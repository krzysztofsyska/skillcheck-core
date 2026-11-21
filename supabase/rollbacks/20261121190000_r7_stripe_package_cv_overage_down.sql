-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback R7 CV pool above the base pool for WERYFIKACJA / ASSESSMENT CENTER
-- (20261121190000_r7_stripe_package_cv_overage.sql). Restores the price-list check of
-- 20261121150000_r7_stripe_packages.sql (exactly one base package). Refuses while any
-- order holds a pool above the base: orders are accounting records and are never
-- changed or deleted by a rollback. Run with `psql -v ON_ERROR_STOP=1`.
begin;

do $guard$
begin
 if exists(select 1 from sc19_stripe.package_orders
   where not ((package_code='WERYFIKACJA' and amount_minor=61500 and credits=60)
     or (package_code='ASSESSMENT_CENTER' and amount_minor=149900 and credits=50))) then
  raise exception 'r7_stripe_cv_overage_rollback_refused_pool_orders_exist' using errcode='55000';end if;
end $guard$;

alter table sc19_stripe.package_orders drop constraint package_orders_price_list;
alter table sc19_stripe.package_orders add constraint package_orders_price_list check (
 (package_code='WERYFIKACJA' and amount_minor=61500 and credits=60)
 or (package_code='ASSESSMENT_CENTER' and amount_minor=149900 and credits=50));

commit;
