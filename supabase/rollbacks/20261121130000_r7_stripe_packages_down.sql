-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback R7 Stripe packages (20261121130000_r7_stripe_packages.sql).
-- Refuses while any WERYFIKACJA / ASSESSMENT CENTER Stripe order exists: orders,
-- receipts and the grants they made are accounting records and are never deleted
-- by a rollback. Run with `psql -v ON_ERROR_STOP=1`.
begin;

do $guard$
begin
 if to_regclass('sc19_stripe.package_orders') is not null and exists(select 1 from sc19_stripe.package_orders) then
  raise exception 'r7_stripe_packages_rollback_refused_orders_exist' using errcode='55000';end if;
end $guard$;

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

drop function if exists sc19_stripe.grant_package(uuid, text);
drop table if exists sc19_stripe.package_grants;
drop table if exists sc19_stripe.package_requests;
drop table if exists sc19_stripe.package_orders;
drop function if exists sc19_stripe.package_immutable();

commit;
