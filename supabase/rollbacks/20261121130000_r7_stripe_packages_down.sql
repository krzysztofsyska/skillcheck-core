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

drop function if exists sc19_stripe.grant_package(uuid, text);
drop table if exists sc19_stripe.package_grants;
drop table if exists sc19_stripe.package_requests;
drop table if exists sc19_stripe.package_orders;
drop function if exists sc19_stripe.package_immutable();

commit;
