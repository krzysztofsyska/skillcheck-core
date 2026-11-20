-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback R7 Stripe packages (20261121150000_r7_stripe_packages.sql).
-- Refuses while any WERYFIKACJA / ASSESSMENT CENTER Stripe order exists: orders,
-- receipts and the grants they made are accounting records and are never deleted
-- by a rollback. Run with `psql -v ON_ERROR_STOP=1`.
begin;

do $guard$
begin
 if to_regclass('sc19_stripe.package_orders') is not null and exists(select 1 from sc19_stripe.package_orders) then
  raise exception 'r7_stripe_packages_rollback_refused_orders_exist' using errcode='55000';end if;
 -- The company-wide index cannot be restored while a company holds a stale
 -- Przelewy24 order next to another unresolved order; orders are never changed here.
 if exists(select 1 from private.sc19_payment_orders where status='awaiting_payment'
   group by company_id having count(*)>1) then
  raise exception 'r7_stripe_packages_rollback_refused_unresolved_orders' using errcode='55000';end if;
end $guard$;

-- Restore the company-wide one-unresolved-order index of the SC-019 migration.
drop index if exists private.sc19_payment_one_unresolved;
create unique index sc19_payment_one_unresolved on private.sc19_payment_orders(company_id)
 where status='awaiting_payment';

-- Restore the buyer lookup of 20261121110000_r7_stripe_checkout.sql (PRESELEKCJA
-- Stripe orders only) BEFORE the package table goes: a SQL function body is not
-- dependency-tracked, so it would otherwise keep pointing at a dropped table.
create or replace function sc19_stripe.buyer(target_company uuid)
returns table(company_name text, nip text)
language sql stable security definer set search_path='' as $$
 select c.name, a.nip from public.companies c
 left join private.sc19_trial_approvals a on a.company_id=c.id
 where c.id=target_company and exists(select 1 from private.sc19_payment_orders o
  where o.company_id=target_company and o.provider='stripe' and o.status='awaiting_payment')
$$;
revoke all on function sc19_stripe.buyer(uuid) from public, anon, authenticated;

-- Restore the catalog order guard of 20261107164252_sc019_catalog_orders.sql
-- (verbatim body) before the package table goes, for the same reason.
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
 -- Do not create an independent order while a P24 checkout is unresolved.
 if exists(select 1 from private.sc19_payment_orders where company_id=target_company and status='awaiting_payment')
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
-- create or replace keeps the existing ACL (execute for authenticated only, as set
-- in 20261107164252); the revoke repeats the closed default for public and anon.
revoke all on function public.sc19_create_catalog_order(uuid,uuid,jsonb,boolean) from public,anon;

drop function if exists sc19_stripe.grant_package(uuid, text);
drop table if exists sc19_stripe.package_grants;
drop table if exists sc19_stripe.package_requests;
drop table if exists sc19_stripe.package_orders;
drop function if exists sc19_stripe.package_immutable();

commit;
