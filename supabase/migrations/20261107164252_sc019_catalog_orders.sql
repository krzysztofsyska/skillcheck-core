-- SC-019 / #283: catalog orders and operator-confirmed settlement.
-- Company accounting only, no candidate data. R15 reviews the incoming company
-- foreign keys. No prices, package quantities or runtime enabled.
begin;
do $commerce_preflight$ begin
 if private.erasure_schema_signature() is distinct from '75eca00dc4b8bbf7959e18a144beda51a70b0377ab4cc306e59b2cef56402688' then raise exception 'commerce_source_schema_unreviewed' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='public.preview_candidate_erasure(uuid,text,uuid)'::regprocedure and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='e69418db84166815b3ed3aca0e40de9fd0850bfba7a699c6af497debd6fa0faf') then raise exception 'commerce_source_reader_unreviewed:public.preview_candidate_erasure' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.prepare_erasure_purge_manifest(uuid)'::regprocedure and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='b7ca0b2385917d116147ff4148722f2f68ae73adfc2e73bb50ab70a96953098d') then raise exception 'commerce_source_reader_unreviewed:private.prepare_erasure_purge_manifest' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.authorize_retention_suggestion(uuid)'::regprocedure and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='ad47cb6706b0cda8117915a32c9b0d807e010be288986e8e210b8847d3eb42f6') then raise exception 'commerce_source_reader_unreviewed:private.authorize_retention_suggestion' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='public.get_retention_schedule(uuid)'::regprocedure and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='5e2a80939efb57fba05e1f8ffbd8ee8b24d180c385b85484df009cd9ea47f8b3') then raise exception 'commerce_source_reader_unreviewed:public.get_retention_schedule' using errcode='55000';end if;
end $commerce_preflight$;
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
 check(kind <> 'addon' or (service_code is not null and code=service_code and included_units=0)),
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
   or previous.terms_text is distinct from expected_quote->>'termsText'
   or previous.cv_credits is distinct from (expected_quote->>'cvCredits')::integer
   or previous.service_code is distinct from expected_quote->>'serviceCode'
   or previous.service_units is distinct from (expected_quote->>'serviceUnits')::integer
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
 if target_company is null then
  perform private.sc19_require_operator();
  -- Bounded work queue: settled history cannot hide an outstanding obligation.
  -- Processing the oldest rows exposes the next batch, even with >100 pending.
  return coalesce((select jsonb_agg(to_jsonb(o)-'buyer_id'-'settlement_reference'-'settled_by'-'request_id' order by o.accepted_at,o.id) from (
   select * from sc19_commerce.orders where status='pending' order by accepted_at,id limit 100) o),'[]');
 end if;
 perform sc19_commerce.authorize(target_company);
 return coalesce((select jsonb_agg(to_jsonb(o)-'buyer_id'-'settlement_reference'-'settled_by'-'request_id') from (
  select * from sc19_commerce.orders where company_id=target_company order by accepted_at desc,id desc limit 100) o),'[]');
end;$$;

create function public.sc19_catalog_entitlements(target_company uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform sc19_commerce.authorize(target_company);
 return coalesce((select jsonb_agg(jsonb_build_object('code',code,'available',available,'used',used) order by code)
 from sc19_commerce.entitlements where company_id=target_company),'[]');
end;$$;
revoke all on function public.sc19_catalog_entitlements(uuid) from public,anon,authenticated;
grant execute on function public.sc19_catalog_entitlements(uuid) to authenticated;

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
-- Generated R15 readers and immutable baseline.
create table private.erasure_inventory_baseline_r15 (
 singleton boolean primary key default true check(singleton),schema_signature text not null,known_tables text[] not null
);
alter table private.erasure_inventory_baseline_r15 enable row level security;
create trigger immutable_history before update or delete on private.erasure_inventory_baseline_r15
 for each row execute function private.contact_immutable();
insert into private.erasure_inventory_baseline_r15 select true,'1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44',known_tables||array['private.erasure_inventory_baseline_r15'] from private.erasure_inventory_baseline_r14 where singleton;
do $acl$ declare g record;begin
 revoke all on private.erasure_inventory_baseline_r15 from public;
 for g in select distinct r.rolname from pg_class c cross join lateral aclexplode(c.relacl) a join pg_roles r on r.oid=a.grantee where c.oid='private.erasure_inventory_baseline_r15'::regclass and a.grantee<>c.relowner loop execute format('revoke all on private.erasure_inventory_baseline_r15 from %I',g.rolname);end loop;
end $acl$;
create or replace function public.preview_candidate_erasure(target_candidate uuid,scope_kind text default 'candidate_record',resolution_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare tenant uuid;subjects uuid[];p private.candidate_retention_policies;r private.erasure_subject_resolutions;
 baseline private.erasure_inventory_baseline_r15;signature text;counts jsonb:='{}';manifest text;row_digest jsonb:='[]';
 blockers text[]:=array['execution_not_provisioned','external_inventory_unverified','backup_policy_unverified','administrative_inventory_pending_execution'];generated timestamptz:=statement_timestamp();
begin
 select company_id into tenant from public.candidates where id=target_candidate;perform private.erasure_owner(tenant);
 if scope_kind is null or scope_kind not in ('candidate_record','confirmed_subject')
 or (scope_kind='candidate_record' and resolution_id is not null) or (scope_kind='confirmed_subject' and resolution_id is null)
 then raise exception using errcode='PT422',message='Invalid preview scope';end if;
 subjects:=array[target_candidate];
 if scope_kind='confirmed_subject' then
  select * into r from private.erasure_subject_resolutions where id=resolution_id and company_id=tenant and anchor_candidate_id=target_candidate;
  if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
  subjects:=r.candidate_ids;
  if r.revision<>(select max(revision) from private.erasure_subject_resolutions where company_id=tenant and anchor_candidate_id=target_candidate)
   or r.confirmed_by<>auth.uid() then blockers:=array_append(blockers,'subject_resolution_changed');end if;
  if cardinality(subjects)<>(select count(*) from public.candidates where company_id=tenant and id=any(subjects)) then
   blockers:=array_append(blockers,'subject_resolution_changed');end if;
 else blockers:=array_append(blockers,'subject_resolution_required');end if;
 select * into p from private.candidate_retention_policies where company_id=tenant order by revision desc limit 1;
 if p.id is null then blockers:=array_append(blockers,'retention_policy_required');
 elsif jsonb_array_length(p.rules)<8 then blockers:=array_append(blockers,'retention_policy_incomplete');end if;
 if p.id is not null and p.approved_by<>auth.uid() then blockers:=array_append(blockers,'policy_owner_changed');end if;
 select * into baseline from private.erasure_inventory_baseline_r15 where singleton;
 signature:=private.erasure_schema_signature();
 if baseline.singleton is null or baseline.known_tables is null or signature is distinct from baseline.schema_signature or exists(
  select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f')
  and not (n.nspname||'.'||c.relname)=any(baseline.known_tables)) then
  blockers:=array_append(blockers,'schema_dependency_unknown');
 else
  -- Preserve the R4-VOICE preview denial as well as its purge/restore adapters.
  -- The legacy R4 fixture has no voice module; SQL in this branch is planned
  -- only when the reviewed voice helper exists.
  if to_regprocedure('private.erasure_voice_request_candidate(uuid,text,uuid)') is not null then
    if exists(select 1 from private.voice_plan_request_keys t where t.company_id=tenant
      and private.erasure_voice_request_candidate(t.company_id,t.operation,t.result_id) is null)
    then blockers:=array_append(blockers,'voice_request_adapter_unknown');end if;
  end if;
  if exists(select 1 from private.contact_requests t where t.company_id=tenant
   and private.erasure_contact_request_candidate(t.company_id,t.operation,t.payload,t.result_id) is null) then blockers:=array_append(blockers,'contact_request_adapter_unknown');end if;
  if exists(select 1 from public.screening_analysis_versions a join public.applications ap on ap.company_id=a.company_id and ap.id=a.application_id
   where ap.company_id=tenant and ap.candidate_id=any(subjects) and a.execution_status in ('pending','processing')) then blockers:=array_append(blockers,'active_screening');end if;
  if exists(select 1 from private.erasure_subject_resolutions sr where sr.company_id=tenant and sr.candidate_ids && subjects and not sr.candidate_ids <@ subjects)
   then blockers:=array_append(blockers,'shared_resolution_requires_adapter');end if;
  if exists(select 1 from private.competency_test_cancellations c where c.company_id=tenant
   and private.erasure_row_candidates('private.competency_test_cancellations',to_jsonb(c)) && subjects
   and not private.erasure_row_candidates('private.competency_test_cancellations',to_jsonb(c)) <@ subjects)
   then blockers:=array_append(blockers,'shared_competency_cancellation_requires_adapter');end if;
  with rows as materialized(select * from private.erasure_inventory_rows(tenant,subjects)),
  grouped as(select adapter,count(*) n from rows group by adapter)
  select coalesce((select jsonb_object_agg(adapter,n) from grouped),'{}'::jsonb),
   coalesce((select jsonb_agg(jsonb_build_array(adapter,row_key,private.erasure_hash(row_data)) order by adapter,row_key) from rows),'[]'::jsonb)
  into counts,row_digest;
 end if;
 manifest:=private.erasure_hash(jsonb_build_object('contract','sc010-r1-v1','tenant',tenant,'owner',auth.uid(),'scope',scope_kind,'subjects',subjects,
 'resolution',to_jsonb(r),'current_resolution_revision',(select coalesce(max(revision),0) from private.erasure_subject_resolutions where company_id=tenant and anchor_candidate_id=target_candidate),
 'policy',to_jsonb(p),'schema',signature,'rows',row_digest,'blockers',blockers));
 return jsonb_build_object('scope_kind',scope_kind,'candidate_count',cardinality(subjects),'counts',counts,'blockers',to_jsonb(blockers),
 'policy_revision',coalesce(p.revision,0),'resolution_revision',coalesce(r.revision,0),'manifest_hash',manifest,'schema_signature',signature,
 'generated_at',generated,'expires_at',generated+interval '5 minutes','execution_enabled',false);
end;$$;

create or replace function private.prepare_erasure_purge_manifest(target_request uuid) returns jsonb
language plpgsql volatile security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare e private.erasure_executions;digest text;signature text;counts jsonb;baseline text;
begin
 perform private.erasure_check_purge_scope(target_request);
 select * into e from private.erasure_executions where request_id=target_request;
 signature:=private.erasure_schema_signature();
 -- R4 final reviewed baseline is installed by the final migration, never learned at runtime.
 select schema_signature into baseline from private.erasure_inventory_baseline_r15 where singleton;
 if signature is distinct from baseline then raise exception using errcode='PT409',message='Unknown schema dependency';end if;
 select private.erasure_hash(coalesce(jsonb_agg(jsonb_build_array(adapter,row_key,private.erasure_hash(row_data)) order by adapter,row_key),'[]'::jsonb)) into digest from private.erasure_purge_rows(e.company_id,e.candidate_ids);
 insert into private.erasure_purge_manifest
 select target_request,digest,adapter,row_key,private.erasure_hash(row_data) from private.erasure_purge_rows(e.company_id,e.candidate_ids) on conflict do nothing;
 select coalesce(jsonb_object_agg(adapter,n),'{}'::jsonb) into counts from(select adapter,count(*) n from private.erasure_purge_rows(e.company_id,e.candidate_ids) group by adapter)c;
 return jsonb_build_object('manifest_hash',digest,'schema_signature',signature,'counts',counts);
end;$$;

create or replace function private.authorize_retention_suggestion(target_suggestion uuid) returns uuid
language plpgsql volatile security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare s private.retention_suggestions;d private.retention_delegations;r private.erasure_subject_resolutions;p jsonb;ticket uuid;result uuid;issued timestamptz;authz jsonb;
begin
 select * into s from private.retention_suggestions where id=target_suggestion for update nowait;
 select * into d from private.retention_delegations where id=s.delegation_id;
 if d.execution_mode<>'automatic' then raise exception using errcode='PT409',message='Automatic delegation required';end if;
 perform private.erasure_execution_gate(false);
 if private.erasure_schema_signature() is distinct from (select schema_signature from private.erasure_inventory_baseline_r15 where singleton) then raise exception using errcode='PT409',message='Unknown schema dependency';end if;
 p:=private.evaluate_retention_subject(s.resolution_id,d.id);
 if p->'blockers'<>'[]'::jsonb or p->>'evidence_hash'<>s.evidence_hash then raise exception using errcode='PT409',message='Retention eligibility changed';end if;
 if exists(select 1 from unnest(s.candidate_ids) x(id) where private.erasure_candidate_frozen(x.id)) then raise exception using errcode='PT409',message='Candidate workflow frozen';end if;
 select * into r from private.erasure_subject_resolutions where id=s.resolution_id;
 -- Fixed graph checks, with unknown schema/JSON/dependencies rejected by the R3 adapter before commit.
 if exists(select 1 from private.contact_requests c where c.company_id=s.company_id and private.erasure_contact_request_candidate(c.company_id,c.operation,c.payload,c.result_id) is null) then raise exception using errcode='PT409',message='Unknown candidate dependency';end if;
 issued:=clock_timestamp();
 insert into private.erasure_preview_tickets(company_id,actor_id,anchor_candidate_id,scope_kind,resolution_id,candidate_ids,manifest_hash,generations,created_at,expires_at)
 values(s.company_id,d.owner_id,r.anchor_candidate_id,'confirmed_subject',r.id,s.candidate_ids,s.evidence_hash,private.erasure_generation_snapshot(s.candidate_ids),issued,issued+interval '5 minutes') returning id into ticket;
 insert into private.erasure_requests(company_id,actor_id,anchor_candidate_id,candidate_ids,scope_kind,preview_ticket_id,manifest_hash,policy_revision,resolution_revision,status,generation)
 values(s.company_id,d.owner_id,r.anchor_candidate_id,s.candidate_ids,'confirmed_subject',ticket,s.evidence_hash,d.policy_revision,r.revision,'authorized',1) returning id into result;
 insert into private.erasure_candidate_lifecycle(candidate_id,company_id,generation,status,request_id)
 select id,s.company_id,1,'frozen',result from unnest(s.candidate_ids) x(id)
 on conflict(candidate_id) do update set generation=erasure_candidate_lifecycle.generation+1,status='frozen',request_id=excluded.request_id;
 authz:=jsonb_build_object('kind','retention_policy','actor_id',d.owner_id,'delegation_id',d.id,'activation_revision',d.revision,'policy_revision',d.policy_revision,'due_generation',s.due_generation,'due_at',s.due_at,'evidence_hash',s.evidence_hash);
 insert into private.retention_authorizations(request_id,authorization_json) values(result,authz);
 update private.retention_suggestions set status='authorized',request_id=result,blockers='[]'::jsonb where id=s.id;
 insert into private.erasure_lifecycle_events(company_id,request_id,actor_id,event,generation) values(s.company_id,result,d.owner_id,'authorized',1);
 -- Reuse the complete reviewed R3 scope validator inside this transaction. This
 -- temporary non-exportable execution never receives a reservation or ledger ACK.
 insert into private.erasure_executions(request_id,company_id,candidate_ids,scope_kind,owner_id,policy_copy,resolution_revision,generation,phase,recovery_retain_until)
 select result,s.company_id,s.candidate_ids,'confirmed_subject',d.owner_id,jsonb_build_object('revision',p2.revision,'rules',p2.rules),r.revision,1,'authorized',clock_timestamp()+interval '1 second'
 from private.candidate_retention_policies p2 where p2.id=d.policy_id;
 perform private.erasure_check_purge_scope(result);
 delete from private.erasure_executions where request_id=result;
 return result;
end;$$;

create or replace function public.get_retention_schedule(target_company uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare d private.retention_delegations;t private.retention_ticks;c private.erasure_execution_config;p private.candidate_retention_policies;schema_ok boolean;begin
 perform private.erasure_owner(target_company);
 select * into d from private.retention_delegations where company_id=target_company order by revision desc limit 1;
 select * into t from private.retention_ticks where company_id=target_company order by created_at desc,id desc limit 1;
 select * into c from private.erasure_execution_config where singleton;
 select * into p from private.candidate_retention_policies where company_id=target_company order by revision desc limit 1;
 schema_ok:=private.erasure_schema_signature() is not distinct from (select schema_signature from private.erasure_inventory_baseline_r15 where singleton);
 return jsonb_build_object('revision',coalesce(d.revision,0),'delegation_id',d.id,'policy_revision',d.policy_revision,'execution_mode',coalesce(d.execution_mode,'suggest_only'),
 'max_batch',coalesce(d.max_batch,25),'revoked',coalesce(d.revoked,true),'owner_current',d.owner_id is not distinct from auth.uid(),
 'authorization_enabled',coalesce(schema_ok and not d.revoked and d.execution_mode='automatic' and d.owner_id=auth.uid() and d.policy_id=p.id and d.policy_revision=p.revision and p.approved_by=auth.uid()
  and c.enabled and c.external_inventory_verified and c.backup_horizon_days is not null and c.artifact_horizon_days is not null and c.retention_margin_days is not null and not c.restore_isolated,false),
 'production_ready',false,
 'blockers',case when c.enabled and c.external_inventory_verified and c.backup_horizon_days is not null and c.artifact_horizon_days is not null and c.retention_margin_days is not null and not c.restore_isolated then '[]'::jsonb else jsonb_build_array('execution_not_provisioned') end || case when schema_ok then '[]'::jsonb else jsonb_build_array('schema_dependency_unknown') end,
 'oldest_pending_at',(select min(created_at) from (select created_at from private.erasure_executions where company_id=target_company and phase in ('authorized','erasing') union all select r.created_at from private.erasure_requests r where r.company_id=target_company and r.status='authorized' and not exists(select 1 from private.erasure_executions e where e.request_id=r.id)) pending),
 'expired_leases',(select count(*) from private.erasure_executions where company_id=target_company and (pending_phase is not null or (phase='erasing' and not local_purged)) and lease_until<clock_timestamp()),
 'last_tick_at',t.created_at,'lag_seconds',case when t.id is null then null else greatest(0,floor(extract(epoch from statement_timestamp()-t.created_at))) end,
 'suggestions',(select count(*) from private.retention_suggestions where company_id=target_company and status='suggested'),
 'authorized',(select count(*) from private.retention_suggestions where company_id=target_company and status='authorized'),
 'blocked',(select count(*) from private.retention_suggestions where company_id=target_company and status='blocked'),
 'holds',(select count(*) from private.erasure_holds where company_id=target_company and released_at is null));
end;$$;
do $commerce_postflight$ begin
 if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then raise exception 'commerce_final_schema_mismatch:%',private.erasure_schema_signature() using errcode='55000';end if;
end $commerce_postflight$;
commit;
