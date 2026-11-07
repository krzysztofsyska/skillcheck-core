-- SC-019 / #283: catalog orders and operator-confirmed settlement.
-- Company accounting only, no candidate data. Separate schema preserves the
-- candidate-erasure inventory. No prices, package quantities or runtime enabled.
begin;
create schema sc19_commerce;
revoke all on schema sc19_commerce from public,anon,authenticated;
create table sc19_commerce.settings (
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false,
 skill_test_metering boolean not null default false,
 terms_revision text not null default 'catalog-orders-v1',
 terms_text text not null default 'Zakup jednorazowy. Przyznanie po potwierdzonej wpłacie. Niewykorzystane jednostki pozostają na koncie; nowy zakup ich nie kasuje. Brak częściowego zwrotu lub proporcjonalnej dopłaty. Nowy pakiet kupujesz w całości.'
);
insert into sc19_commerce.settings default values;
-- Runtime readiness is distinct from catalog sellable. No client write access.
-- Only implemented consumers can be mapped: CV and candidate competency tests.
create table sc19_commerce.product_rules (
 version_id uuid not null references pricing.catalog_versions(id),
 kind text not null check(kind in ('package','addon')),
 code text not null,
 package_code text not null check(package_code in ('FREE','PRESELEKCJA','WERYFIKACJA','ASSESSMENT_CENTER')),
 runtime_ready boolean not null default false,
 auto_purchase boolean not null default false,
 service_code text check(service_code in ('skill_test')),
 included_units integer not null default 0 check(included_units between 0 and 100000),
 max_quantity integer not null default 1 check(max_quantity between 1 and 1000),
 prerequisites text[] not null default '{}',
 exclusions text[] not null default '{}',
 primary key(version_id,kind,code,package_code),
 check(kind <> 'addon' or (service_code is not null and included_units=0)),
 check(kind <> 'package' or code=package_code),
 check(included_units=0 or service_code is not null)
);
create table sc19_commerce.orders (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete restrict,
 buyer_id uuid not null,
 request_id uuid not null,
 version_id uuid not null references pricing.catalog_versions(id),
 kind text not null check(kind in ('package','addon')),
 code text not null, package_code text not null,
 quantity integer not null check(quantity between 1 and 1000),
 gross_minor integer not null check(gross_minor between 1 and 100000000),
 cv_credits integer not null check(cv_credits between 0 and 100000),
 service_code text, service_units integer not null check(service_units between 0 and 100000),
 terms_revision text not null, terms_text text not null,
 accepted_at timestamptz not null default now(),
 status text not null default 'pending' check(status in ('pending','paid','cancelled')),
 settlement_reference text unique, settled_by uuid, settled_at timestamptz,
 unique(company_id,request_id),
 check((status='paid')=(settlement_reference is not null)),
 check((status='paid')=(settled_by is not null)),
 check((status='paid')=(settled_at is not null))
);
create unique index commerce_one_pending on sc19_commerce.orders(company_id) where status='pending';
create table sc19_commerce.entitlements (
 company_id uuid not null references public.companies(id) on delete restrict,
 code text not null,
 available integer not null default 0 check(available>=0),
 used integer not null default 0 check(used>=0),
 primary key(company_id,code)
);
alter table sc19_commerce.settings enable row level security;
alter table sc19_commerce.product_rules enable row level security;
alter table sc19_commerce.orders enable row level security;
alter table sc19_commerce.entitlements enable row level security;
revoke all on all tables in schema sc19_commerce from public,anon,authenticated;

create function sc19_commerce.authorize(cid uuid,buy boolean default false) returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.has_company_access(cid,false)
  or (buy and not private.is_company_owner(cid)) then
  raise exception 'commerce_forbidden' using errcode='42501';end if;
 if buy and not exists(select 1 from private.sc19_trial_approvals where company_id=cid) then
  raise exception 'commerce_verification_required' using errcode='42501';end if;
end;$$;

create function sc19_commerce.quote(cid uuid,k text,c text,p text,q integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v uuid; rules sc19_commerce.product_rules; price integer; credits integer:=0;
 units integer:=0; settings sc19_commerce.settings; pkg pricing.package_prices; addon pricing.addon_options;
begin
 select * into settings from sc19_commerce.settings where singleton for share;
 if not settings.enabled then raise exception 'commerce_disabled' using errcode='55000';end if;
 select id into v from pricing.catalog_versions where status='PUBLISHED' and approved for share;
 if v is null or k not in ('package','addon') or q is null or q<1 then
  raise exception 'commerce_invalid' using errcode='22023';end if;
 select * into rules from sc19_commerce.product_rules where version_id=v and kind=k and code=c and package_code=p for share;
 if not found or not rules.runtime_ready or not rules.auto_purchase or q>rules.max_quantity
  or (rules.service_code='skill_test' and not settings.skill_test_metering) then
  raise exception 'commerce_unavailable' using errcode='22023';end if;
 select * into pkg from pricing.package_prices where version_id=v and package_code=p for share;
 if not found or p in ('FREE','ASSESSMENT_CENTER') then raise exception 'commerce_unavailable' using errcode='22023';end if;
 -- AC has no metered consumer yet. WERYFIKACJA requires an explicitly configured
 -- approved number of tests; never infer it from the CV pool.
 if k='package' and p='WERYFIKACJA' and (rules.service_code is distinct from 'skill_test' or rules.included_units=0) then
  raise exception 'commerce_unavailable' using errcode='22023';end if;
 if k='package' then
  if not pkg.sellable or c<>p or q<>1 then raise exception 'commerce_unavailable' using errcode='22023';end if;
  price:=pkg.gross_minor;credits:=pkg.cv_included;units:=rules.included_units;
 else
  if not exists(select 1 from sc19_commerce.entitlements where company_id=cid and code='package:'||p and available>0)
   and not(p='PRESELEKCJA' and exists(select 1 from private.sc19_balances where company_id=cid and plan=p)) then
   raise exception 'commerce_package_required' using errcode='22023';end if;
  select * into addon from pricing.addon_options where version_id=v and code=c for share;
  if not found or not addon.sellable or addon.gross_minor<=0 then raise exception 'commerce_unavailable' using errcode='22023';end if;
  price:=addon.gross_minor*q;units:=q;
 end if;
 if price not between 1 and 100000000 or credits>100000 or units>100000
  or exists(select 1 from unnest(rules.prerequisites) requirement where not exists(
   select 1 from sc19_commerce.entitlements where company_id=cid and code=requirement and available>0))
  or exists(select 1 from sc19_commerce.entitlements where company_id=cid and code=any(rules.exclusions) and available>0) then
  raise exception 'commerce_incompatible' using errcode='22023';end if;
 return jsonb_build_object('versionId',v,'kind',k,'code',c,'packageCode',p,'quantity',q,
  'grossMinor',price,'cvCredits',credits,'serviceCode',rules.service_code,'serviceUnits',units,
  'termsRevision',settings.terms_revision,'termsText',settings.terms_text);
end;$$;

create function public.sc19_catalog_order_options(target_company uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r record; result jsonb:='[]'; quote jsonb;
begin
 perform sc19_commerce.authorize(target_company);
 for r in select pr.kind,pr.code,pr.package_code from sc19_commerce.product_rules pr
  join pricing.catalog_versions v on v.id=pr.version_id where v.status='PUBLISHED' and v.approved loop
  begin
   quote:=sc19_commerce.quote(target_company,r.kind,r.code,r.package_code,1);
   result:=result||jsonb_build_array(quote);
  exception when sqlstate '22023' or sqlstate '55000' then null;end;
 end loop;
 return result;
end;$$;

create function public.sc19_create_catalog_order(target_company uuid,request_key uuid,
 expected_quote jsonb,accepted boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare quote jsonb; previous sc19_commerce.orders; oid uuid;
begin
 perform sc19_commerce.authorize(target_company,true);
 perform private.sc19_lock_company(target_company);
 if accepted is distinct from true or request_key is null or jsonb_typeof(expected_quote) is distinct from 'object' then
  raise exception 'commerce_invalid' using errcode='22023';end if;
 select * into previous from sc19_commerce.orders where company_id=target_company and request_id=request_key;
 if found then
  if previous.buyer_id<>auth.uid() or previous.kind is distinct from expected_quote->>'kind'
   or previous.code is distinct from expected_quote->>'code' or previous.package_code is distinct from expected_quote->>'packageCode'
   or previous.quantity is distinct from (expected_quote->>'quantity')::integer
   or previous.version_id::text is distinct from expected_quote->>'versionId'
   or previous.terms_revision is distinct from expected_quote->>'termsRevision'
   or previous.gross_minor is distinct from (expected_quote->>'grossMinor')::integer then
   raise exception 'commerce_request_conflict' using errcode='23505';end if;
  return previous.id;
 end if;
 -- Do not create an independent order while a P24 checkout is unresolved.
 if exists(select 1 from private.sc19_payment_orders where company_id=target_company and status='awaiting_payment')
  or exists(select 1 from sc19_commerce.orders where company_id=target_company and status='pending') then
  raise exception 'commerce_pending_order' using errcode='23505';end if;
 quote:=sc19_commerce.quote(target_company,expected_quote->>'kind',expected_quote->>'code',
  expected_quote->>'packageCode',(expected_quote->>'quantity')::integer);
 if quote is distinct from expected_quote then raise exception 'commerce_stale_quote' using errcode='22023';end if;
 insert into sc19_commerce.orders(company_id,buyer_id,request_id,version_id,kind,code,package_code,quantity,
  gross_minor,cv_credits,service_code,service_units,terms_revision,terms_text)
 values(target_company,auth.uid(),request_key,(quote->>'versionId')::uuid,quote->>'kind',quote->>'code',
  quote->>'packageCode',(quote->>'quantity')::integer,(quote->>'grossMinor')::integer,(quote->>'cvCredits')::integer,
  quote->>'serviceCode',(quote->>'serviceUnits')::integer,quote->>'termsRevision',quote->>'termsText') returning id into oid;
 return oid;
end;$$;

create function public.sc19_catalog_orders(target_company uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if target_company is null then perform private.sc19_require_operator();
 else perform sc19_commerce.authorize(target_company);end if;
 return coalesce((select jsonb_agg(to_jsonb(o)-'buyer_id'-'settlement_reference'-'settled_by'-'request_id') from (
  select * from sc19_commerce.orders where target_company is null or company_id=target_company order by accepted_at desc limit 100) o),'[]');
end;$$;

create function public.sc19_cancel_catalog_order(target_company uuid,target_order uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform sc19_commerce.authorize(target_company,true);
 perform private.sc19_lock_company(target_company);
 update sc19_commerce.orders set status='cancelled' where id=target_order and company_id=target_company and status='pending';
 if not found then raise exception 'commerce_order_unavailable' using errcode='22023';end if;
end;$$;

create function public.sc19_settle_catalog_order(target_order uuid,settlement_reference text,
 confirmed_gross integer,confirmed_currency text) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.sc19_require_operator(); o sc19_commerce.orders; cid uuid; ref text:=btrim(settlement_reference);
begin
 if ref is null or length(ref) not between 8 and 160 or confirmed_currency is distinct from 'PLN' then
  raise exception 'commerce_invalid' using errcode='22023';end if;
 select company_id into cid from sc19_commerce.orders where id=target_order;
 if cid is null then raise exception 'commerce_order_unavailable' using errcode='22023';end if;
 perform private.sc19_lock_company(cid);
 select * into o from sc19_commerce.orders where id=target_order for update;
 if confirmed_gross is distinct from o.gross_minor then raise exception 'commerce_amount_mismatch' using errcode='22023';end if;
 if o.status='paid' then
  if o.settlement_reference<>ref then raise exception 'commerce_settlement_conflict' using errcode='23505';end if;
  return;
 end if;
 if o.status<>'pending' then raise exception 'commerce_order_unavailable' using errcode='22023';end if;
 -- The same namespace as existing manual grants: one bank/invoice reference
 -- cannot grant both a legacy pack and a catalog order (even across companies).
 perform pg_advisory_xact_lock(hashtextextended('settlement:'||ref,0));
 if exists(select 1 from private.sc19_credit_journal where reference='settlement:'||ref)
  or exists(select 1 from sc19_commerce.orders other_order where other_order.settlement_reference=ref) then
  raise exception 'commerce_settlement_conflict' using errcode='23505';end if;
 if o.cv_credits>0 then
  insert into private.sc19_credit_journal(company_id,reason,delta,reference)
  values(cid,'paid_grant',o.cv_credits,'settlement:'||ref);
  insert into private.sc19_balances(company_id,plan,available) values(cid,'PRESELEKCJA',o.cv_credits)
  on conflict(company_id) do update set available=private.sc19_balances.available+excluded.available,
   plan='PRESELEKCJA',updated_at=now();
 end if;
 if o.kind='package' then
  insert into sc19_commerce.entitlements(company_id,code,available) values(cid,'package:'||o.package_code,1)
  on conflict(company_id,code) do update set available=sc19_commerce.entitlements.available+1;
 end if;
 if o.service_units>0 then
  insert into sc19_commerce.entitlements(company_id,code,available) values(cid,o.service_code,o.service_units)
  on conflict(company_id,code) do update set available=sc19_commerce.entitlements.available+excluded.available;
 end if;
 update sc19_commerce.orders set status='paid',settlement_reference=ref,settled_by=actor,settled_at=now() where id=o.id;
end;$$;

create function sc19_commerce.consume_skill_test(cid uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 -- Existing deployments keep their behavior until explicit runtime activation.
 if not (select skill_test_metering from sc19_commerce.settings where singleton) then return;end if;
 update sc19_commerce.entitlements set available=available-1,used=used+1
 where company_id=cid and code='skill_test' and available>0;
 if not found then raise exception 'commerce_skill_test_exhausted' using errcode='PT422';end if;
end;$$;

-- Existing manual settlement shares the same receipt lock and rejects a
-- catalog reference, including a service-only order that has no CV journal row.
create or replace function private.sc19_grant_paid(target_company uuid, settlement_reference text)
returns integer language plpgsql security definer set search_path='' as $$
declare prior_company uuid; credits integer; paid_credits integer;
begin
 if length(btrim(coalesce(settlement_reference,''))) not between 8 and 160 then
  raise exception 'sc19_invalid_settlement' using errcode='22023';end if;
 perform private.sc19_lock_company(target_company);
 perform pg_advisory_xact_lock(hashtextextended('settlement:'||btrim(settlement_reference),0));
 if exists(select 1 from sc19_commerce.orders o where o.settlement_reference=btrim(sc19_grant_paid.settlement_reference)) then
  raise exception 'sc19_reference_conflict' using errcode='23505';end if;
 select company_id into prior_company from private.sc19_credit_journal where reference='settlement:'||btrim(settlement_reference);
 if prior_company is not null then
  if prior_company<>target_company then raise exception 'sc19_reference_conflict' using errcode='23505';end if;
  select available into credits from private.sc19_balances where company_id=target_company;return credits;
 end if;
 select p.credits into paid_credits from private.sc19_package_policy p where p.plan='PRESELEKCJA';
 if paid_credits is null then raise exception 'sc19_missing_paid_policy' using errcode='55000';end if;
 insert into private.sc19_balances(company_id,plan,available) values(target_company,'PRESELEKCJA',paid_credits)
 on conflict(company_id) do update set plan='PRESELEKCJA',available=private.sc19_balances.available+paid_credits,updated_at=now();
 insert into private.sc19_credit_journal(company_id,reason,delta,reference)
 values(target_company,'paid_grant',paid_credits,'settlement:'||btrim(settlement_reference));
 select available into credits from private.sc19_balances where company_id=target_company;return credits;
end;$$;

-- Debit only for a new grant. Repeat requests return before this boundary;
-- any later failure rolls back the entitlement debit with the whole grant.
create or replace function public.create_competency_test_grant(target_application uuid,target_definition uuid,start_by timestamptz,request_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.applications;d public.exercise_definition_entries;g private.competency_test_grants;secret text;
begin
 a:=private.competency_lock_application(target_application,true);
 d:=private.competency_eligible(a,target_definition);
 if request_key is null or start_by is null then raise exception using errcode='PT422',message='Invalid grant';end if;
 select * into g from private.competency_test_grants where company_id=a.company_id and created_by=auth.uid() and issuance_request_key=request_key;
 if found then
  if g.application_id<>a.id or g.definition_entry_id<>target_definition or g.start_by_at<>start_by then raise exception using errcode='PT409',message='Request key reused';end if;
  return jsonb_build_object('grantId',g.id,'revision',g.revision,'state','secret_unavailable_rotate_required');end if;
 d:=private.competency_eligible(a,target_definition);
 if start_by<=clock_timestamp() or start_by>clock_timestamp()+interval '7 days' then raise exception using errcode='PT422',message='Invalid start window';end if;
 perform sc19_commerce.consume_skill_test(a.company_id);
 secret:=encode(extensions.gen_random_bytes(32),'hex');
 insert into private.competency_test_grants(company_id,candidate_id,recruitment_id,application_id,definition_entry_id,token_digest,
 start_by_at,created_by,issuance_request_key,event_request_key) values(a.company_id,a.candidate_id,a.recruitment_id,a.id,d.id,
 extensions.digest(secret,'sha256'),start_by,auth.uid(),request_key,request_key) returning * into g;
 return jsonb_build_object('grantId',g.id,'revision',g.revision,'token',secret);
exception when unique_violation then raise exception using errcode='PT409',message='Grant already exists';end;$$;

create function sc19_commerce.protect_order() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' or (to_jsonb(new)-array['status','settlement_reference','settled_by','settled_at'])
  is distinct from (to_jsonb(old)-array['status','settlement_reference','settled_by','settled_at'])
  or old.status<>'pending' then raise exception 'commerce_immutable' using errcode='22023';end if;
 return new;
end;$$;
create trigger commerce_order_immutable before update or delete on sc19_commerce.orders
for each row execute function sc19_commerce.protect_order();
revoke all on all functions in schema sc19_commerce from public,anon,authenticated;
revoke all on function public.sc19_catalog_order_options(uuid),public.sc19_create_catalog_order(uuid,uuid,jsonb,boolean),
 public.sc19_catalog_orders(uuid),public.sc19_cancel_catalog_order(uuid,uuid),public.sc19_settle_catalog_order(uuid,text,integer,text) from public,anon,authenticated;
grant execute on function public.sc19_catalog_order_options(uuid),public.sc19_create_catalog_order(uuid,uuid,jsonb,boolean),
 public.sc19_catalog_orders(uuid),public.sc19_cancel_catalog_order(uuid,uuid),public.sc19_settle_catalog_order(uuid,text,integer,text) to authenticated;
commit;
