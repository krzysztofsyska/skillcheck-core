-- R7 (docs/ROADMAP.md, „Zakup PRESELEKCJI, WERYFIKACJI i ASSESSMENT CENTER przez
-- Stripe Checkout”): a WERYFIKACJA or ASSESSMENT CENTER order may hold a CV pool
-- ABOVE the package's base pool, priced by the overage rule of
-- docs/cennik-2026-11-02.md („Dopłata za CV powyżej puli bazowej”). TEST mode only;
-- the application offers it only behind PRICING_CV_SLIDER_ENABLED (default off).
--
-- WHAT CHANGES
-- Only the check constraint sc19_stripe.package_orders.package_orders_price_list
-- (migration 20261121150000_r7_stripe_packages.sql). Until now it allowed exactly
-- one base package (WERYFIKACJA 61500 gr / 60 CV, ASSESSMENT CENTER 149900 gr /
-- 50 CV). It now also allows a larger pool, and the amount is still PINNED: it must
-- be exactly what the pricing engine computes for that pool, so a wrong price can
-- still never be stored or paid for, whatever the code sends.
--
-- THE RULE (same arithmetic as lib/pricing/quote-engine.ts and lib/pricing/cv-pool.ts):
--  * pool from the base pool up to the catalog cv_max (150, pricing.package_prices),
--    in steps of 5 counted from the base pool; never below the base (no discount);
--  * net = base net + extra CV × 16 gr net (the catalog's 20 gr gross per CV turned
--    into net, half-up: netFromGross(20, 2300) = 16);
--    base net: WERYFIKACJA 50000 gr, ASSESSMENT CENTER 121870 gr
--    (netFromGross(61500 / 149900, 2300));
--  * gross = net + VAT 23% of the summed net, half-up, in whole grosze, once.
--  E.g. WERYFIKACJA with 100 CV: net 50640 gr, gross 62287 gr (622,87 zł). At the
--  base pool the formula gives exactly 61500 / 149900, so every existing row passes.
-- PRESELEKCJA is not in this table and has no surcharge (whole 60-CV packages).
--
-- Nothing else changes: no grant logic (sc19_stripe.grant_package already grants the
-- order's own credits), no trigger, no grant, no role, no price in pricing.*, no
-- offer. The table is outside public/private, so the SC-010 erasure schema
-- signature stays the same (checked below). No candidate data.
--
-- Code compatibility: the application code shipped with this change works on the
-- pre-migration schema: with the slider flag off it never creates an above-base
-- order; with the flag on, such an insert is refused by the old constraint and the
-- buyer gets a retry error, nothing is charged (the order row is written before any
-- Stripe session is created).
-- Production: applied only through db-migrate-production after the owner's approval.
-- Rollback: supabase/rollbacks/20261121190000_r7_stripe_package_cv_overage_down.sql
-- (refused while any above-base order exists: orders are accounting records).
begin;

do $preflight$
begin
 if to_regclass('sc19_stripe.package_orders') is null then
  raise exception 'r7_stripe_cv_overage_requires_r7_stripe_packages' using errcode='55000';end if;
 if not exists(select 1 from pg_constraint where conrelid='sc19_stripe.package_orders'::regclass
   and conname='package_orders_price_list') then
  raise exception 'r7_stripe_cv_overage_price_list_missing' using errcode='55000';end if;
 if exists(select 1 from pg_constraint where conrelid='sc19_stripe.package_orders'::regclass
   and conname='package_orders_price_list'
   and obj_description(oid, 'pg_constraint') = 'r7_stripe_cv_overage') then
  raise exception 'r7_stripe_cv_overage_already_installed' using errcode='55000';end if;
 perform set_config('r7_stripe_cv_overage.signature_before', private.erasure_schema_signature(), true);
end $preflight$;

alter table sc19_stripe.package_orders drop constraint package_orders_price_list;
alter table sc19_stripe.package_orders add constraint package_orders_price_list check (
 (package_code='WERYFIKACJA' and credits between 60 and 150 and (credits - 60) % 5 = 0
  and amount_minor::bigint = (50000 + (credits - 60) * 16)::bigint
   + ((50000 + (credits - 60) * 16)::bigint * 2300 * 2 + 10000) / 20000)
 or (package_code='ASSESSMENT_CENTER' and credits between 50 and 150 and (credits - 50) % 5 = 0
  and amount_minor::bigint = (121870 + (credits - 50) * 16)::bigint
   + ((121870 + (credits - 50) * 16)::bigint * 2300 * 2 + 10000) / 20000));
-- Marker for the preflight above (this migration is not re-runnable).
comment on constraint package_orders_price_list on sc19_stripe.package_orders is 'r7_stripe_cv_overage';

do $postflight$
begin
 if private.erasure_schema_signature() is distinct from current_setting('r7_stripe_cv_overage.signature_before') then
  raise exception 'r7_stripe_cv_overage_changed_erasure_schema' using errcode='55000';end if;
end $postflight$;

commit;
