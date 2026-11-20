-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback R7 expired Stripe sessions (20261121180000_r7_stripe_expired_session.sql).
-- Refuses once any order has been closed: closures and the orders they closed are
-- accounting records and are never deleted or reopened by a rollback. Restores the
-- bodies of 20261121150000_r7_stripe_packages.sql (package guard, buyer lookup,
-- catalog order guard, one-unresolved index) and of
-- 20261021084732_sc019_credits_payments_inventory.sql (PRESELEKCJA order guard).
-- Run with `psql -v ON_ERROR_STOP=1`.
begin;

do $guard$
begin
 if to_regclass('sc19_stripe.order_closures') is not null and exists(select 1 from sc19_stripe.order_closures) then
  raise exception 'r7_stripe_expired_session_rollback_refused_closures_exist' using errcode='55000';end if;
 if exists(select 1 from sc19_stripe.package_orders where status='expired')
  or exists(select 1 from private.sc19_payment_orders where checkout_url='sc19:expired') then
  raise exception 'r7_stripe_expired_session_rollback_refused_closed_orders' using errcode='55000';end if;
end $guard$;

-- Bodies that read the closures table go first (SQL/plpgsql bodies are not dependency-tracked).
create or replace function private.sc19_payment_immutable()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' or tg_table_name in ('sc19_payment_grants','sc19_payment_requests') then raise exception 'sc19_payment_immutable' using errcode='55000'; end if;
  if tg_table_name='sc19_payment_offers' then
    if (to_jsonb(new)-array['active','approved']) is distinct from
       (to_jsonb(old)-array['active','approved']) then
      raise exception 'sc19_offer_revision_immutable' using errcode='55000';
    end if;
  elsif (to_jsonb(new)-array['status','session_id','checkout_url','payment_id']) is distinct from
        (to_jsonb(old)-array['status','session_id','checkout_url','payment_id'])
    or (old.session_id is not null and (new.session_id is distinct from old.session_id
        or new.checkout_url is distinct from old.checkout_url))
    or (old.status='paid' and to_jsonb(new) is distinct from to_jsonb(old)) then
      raise exception 'sc19_order_immutable' using errcode='55000';
  end if;
  return new;
end $$;
revoke all on function private.sc19_payment_immutable() from public,anon,authenticated;

create or replace function sc19_stripe.package_immutable() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='DELETE' or tg_table_name in ('package_requests','package_grants') then
  raise exception 'sc19_stripe_package_immutable' using errcode='55000';end if;
 if (to_jsonb(new)-array['status','session_id','checkout_url','payment_id'])
     is distinct from (to_jsonb(old)-array['status','session_id','checkout_url','payment_id'])
  or (old.session_id is not null and (new.session_id is distinct from old.session_id
      or new.checkout_url is distinct from old.checkout_url))
  or (old.status='paid' and to_jsonb(new) is distinct from to_jsonb(old))
  or (old.status='awaiting_payment' and new.status='paid' and not exists(
      select 1 from sc19_stripe.package_grants g where g.order_id=new.id)) then
  raise exception 'sc19_stripe_package_immutable' using errcode='55000';end if;
 return new;
end;$$;
revoke all on function sc19_stripe.package_immutable() from public, anon, authenticated;

create or replace function sc19_stripe.buyer(target_company uuid)
returns table(company_name text, nip text)
language sql stable security definer set search_path='' as $$
 select c.name, a.nip from public.companies c
 left join private.sc19_trial_approvals a on a.company_id=c.id
 where c.id=target_company and (
  exists(select 1 from private.sc19_payment_orders o
   where o.company_id=target_company and o.provider='stripe' and o.status='awaiting_payment')
  or exists(select 1 from sc19_stripe.package_orders p
   where p.company_id=target_company and p.provider='stripe' and p.mode='test' and p.status='awaiting_payment'))
$$;
revoke all on function sc19_stripe.buyer(uuid) from public, anon, authenticated;

create or replace function public.sc19_create_catalog_order(target_company uuid,request_key uuid,
 expected_quote jsonb,accepted boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare quote jsonb; previous sc19_commerce.orders; oid uuid;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'commerce_read_committed_required' using errcode='25001';end if;
 perform sc19_commerce.authorize(target_company,true);
 perform private.sc19_lock_company(target_company);
 -- A concurrent NIP release may have committed while the company lock waited.
 perform sc19_commerce.authorize(target_company,true);
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
 -- Do not create an independent order while a Stripe checkout (PRESELEKCJA or a
 -- package) or another catalog order is unresolved.
 if exists(select 1 from private.sc19_payment_orders where company_id=target_company and status='awaiting_payment'
   and provider<>'przelewy24')
  or exists(select 1 from sc19_stripe.package_orders where company_id=target_company and status='awaiting_payment')
  or exists(select 1 from sc19_commerce.orders where company_id=target_company and status='pending') then
  raise exception 'commerce_pending_order' using errcode='23505';end if;
 quote:=sc19_commerce.quote(target_company,expected_quote->>'kind',expected_quote->>'code',
  expected_quote->>'packageCode',(expected_quote->>'quantity')::integer);
 if quote is distinct from expected_quote then raise exception 'commerce_stale_quote' using errcode='22023';end if;
 -- P24 uses SERIALIZABLE: a company row lock alone does not refresh its snapshot.
 -- Write a new version of the already-verified approval without changing proof or
 -- approved_at. P24's FOR SHARE approval read must retry a stale snapshot (40001).
 -- Do not touch companies: its erasure guard would lock every candidate.
 update private.sc19_trial_approvals set approved_at=approved_at where company_id=target_company;
 insert into sc19_commerce.orders(company_id,buyer_id,request_id,version_id,kind,code,package_code,quantity,
  gross_minor,cv_credits,service_code,service_units,terms_revision,terms_text)
 values(target_company,auth.uid(),request_key,(quote->>'versionId')::uuid,quote->>'kind',quote->>'code',
  quote->>'packageCode',(quote->>'quantity')::integer,(quote->>'grossMinor')::integer,(quote->>'cvCredits')::integer,
  quote->>'serviceCode',(quote->>'serviceUnits')::integer,quote->>'termsRevision',quote->>'termsText') returning id into oid;
 return oid;
end;$$;
revoke all on function public.sc19_create_catalog_order(uuid,uuid,jsonb,boolean) from public,anon;

drop index if exists private.sc19_payment_one_unresolved;
create unique index sc19_payment_one_unresolved on private.sc19_payment_orders(company_id)
 where status='awaiting_payment' and provider<>'przelewy24';

drop function sc19_stripe.close_expired_order(uuid, text);
drop table sc19_stripe.order_closures;

alter table sc19_stripe.package_orders drop constraint package_orders_status_check;
alter table sc19_stripe.package_orders add constraint package_orders_status_check
 check (status in ('awaiting_payment','paid'));

commit;
