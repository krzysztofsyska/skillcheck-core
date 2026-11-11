-- PREVIEW-ONLY commercial seed. NOT a migration: this file lives outside
-- supabase/migrations/ and is applied only by .github/workflows/preview-db-migrate.yml
-- against the TEST project skillcheck-preview (orbyscrupgnupifzlqxp), which holds
-- no real data. The production runner (tools/db-migrate/apply.mjs) and the
-- production workflow read supabase/migrations/ only, so nothing here can ever
-- reach wsvjawuikxfzjyivxgsu.
--
-- WHY IT IS NOT A MIGRATION
--
-- Package quotas and the price/terms of a purchasable offer are commercial,
-- owner-gated state. CLAUDE.md lists "Set FREE = 5 and PRESELEKCJA = 60 in
-- /operator/billing" as an explicit OWNER action, and AGENTS.md forbids
-- billing/charge actions without explicit owner production approval. A migration
-- that writes private.sc19_package_policy and publishes an approved+active
-- private.sc19_payment_offers row would switch commercial state on wherever the
-- chain is applied, including production, without the owner ever acting. That is
-- exactly what tests/sc-019-migrations-production-history.test.mjs refuses with
-- "No commercial activation or retrospective billing", and that guard is right.
--
-- On production the operator does this through /operator/billing:
--   public.sc19_operator_set_package_policy('FREE', 5)
--   public.sc19_operator_set_package_policy('PRESELEKCJA', 60)
-- and a reviewed offer revision is published as a separate owner-approved step.
-- Those values are owner decisions (FREE 5 analiz CV / 0 zl, owner 2026-11-02;
-- PRESELEKCJA 60 analiz CV / 300,00 zl brutto, owner 2026-10-28, reconfirmed
-- 2026-11-01 and 2026-11-02; source of truth docs/cennik-2026-11-02.md). Nothing
-- here changes a price, a package or what is in the MVP.
--
-- WERYFIKACJA and ASSESSMENT CENTER stay NON-purchasable. This file does not
-- touch the check constraints that limit private.sc19_package_policy.plan to
-- ('FREE','PRESELEKCJA') and private.sc19_payment_offers.plan to 'PRESELEKCJA'.
--
-- This seed does NOT activate a payment provider. resolveSc19PaymentRuntime()
-- still returns null, so POST /api/billing/checkout and the webhook keep
-- answering SC19_PAYMENTS_DISABLED and no order can be created. The offer exists
-- so the Przelewy24 verifier can walk the checkout page, the order summary and
-- the terms on Preview.
--
-- Data only: no table, column, index, trigger, policy, grant or routine is
-- created or altered, so the SC-010 erasure schema signature and the newest
-- erasure inventory baseline are unaffected.
--
-- RE-RUNNABLE: preview-db-migrate.yml applies this file on every run, and by then
-- the test project normally holds balances, journal entries, grants and orders
-- from earlier Preview walks. The seed must tolerate all of that and still leave
-- the same one offer published; it never reads or rewrites that activity.
--
-- Idempotent: inserts are ON CONFLICT DO NOTHING and every UPDATE is conditional,
-- so re-running changes nothing. private.sc19_payment_offers is update-immutable
-- (private.sc19_payment_immutable() allows an UPDATE only of active/approved and
-- refuses every DELETE), so an issued revision is never rewritten; the accented
-- revision is a row of its own and an older ASCII revision is only deactivated.
begin;

-- The target project ref, substituted by psql from the ONE place that has
-- verified it against the connection string: the preview-db-migrate workflow
-- refuses a DATABASE_URL that is not skillcheck-preview before it reaches this
-- file. psql does not expand variables inside a dollar-quoted body, so the value
-- is parked in a transaction-local setting the `do` block below reads.
-- Running this file through anything that does not declare the target project
-- (a plain SQL console, the Supabase SQL editor, psql without -v) leaves
-- `:'sc19_seed_target_ref'` unexpanded and fails on a syntax error, before a
-- single statement runs.
set local sc19.seed_target_ref = :'sc19_seed_target_ref';

do $sc19_preview_seed$
declare
  seeded_offer integer;
  target_ref constant text := nullif(current_setting('sc19.seed_target_ref', true), '');
  preview_ref constant text := 'orbyscrupgnupifzlqxp';
  production_ref constant text := 'wsvjawuikxfzjyivxgsu';
  -- 2027-12-31T23:59:59Z, the validity this offer revision was approved with.
  offer_valid_until constant bigint := 1830297599000;
  -- The one revision this seed publishes. Everything else purchasable is
  -- withdrawn by identity against this id, never from a hand-maintained list of
  -- earlier ids: a list only withdraws what somebody remembered to add to it,
  -- and the revision before this one was missing from it. This is the same
  -- `id <> rev.offer_id` rule public.sc19_operator_publish_offer() uses, so both
  -- routes to a Preview database leave the same single purchasable offer.
  offer_id constant text := 'preselekcja-60-2026-11-r3';
begin
  -- SECOND LINE OF DEFENCE: the project this run is aimed at, NOT the data it
  -- finds there.
  --
  -- The real protection is structural and sits outside this file: the production
  -- migration runner (tools/db-migrate/apply.mjs) and the production workflow
  -- read supabase/migrations/ only and cannot reach supabase/preview-seeds/ at
  -- all, and preview-db-migrate.yml refuses any connection string carrying the
  -- production ref before applying anything. This check only has to stop a human
  -- pasting the file somewhere else, so it requires the caller to name the target
  -- project and refuses anything but skillcheck-preview.
  --
  -- It deliberately does NOT look at existing rows. An earlier version refused
  -- when private.sc19_balances / sc19_credit_journal / sc19_payment_orders /
  -- sc19_payment_grants held anything at all, as a proxy for "this looks live".
  -- That proxy is wrong here: preview-db-migrate.yml re-applies this seed on
  -- every run, and ordinary Preview testing (a company claiming FREE, a manual
  -- operator grant, a test order) creates exactly those rows — so the first test
  -- walk would have blocked every later Preview migration run. A project
  -- identity cannot be faked into existence by testing; row counts can.
  if target_ref is null then
    raise exception 'sc19_preview_seed_requires_target_ref' using errcode = '55000',
      detail = 'No target project ref was declared for this run.',
      hint = 'Apply this seed through .github/workflows/preview-db-migrate.yml, which verifies the connection string first.';
  end if;
  if target_ref = production_ref then
    raise exception 'sc19_preview_seed_refuses_production_project' using errcode = '55000',
      detail = 'The declared target is the production project.',
      hint = 'Quotas and offers on production are an owner action in /operator/billing, never a seed.';
  end if;
  if target_ref <> preview_ref then
    raise exception 'sc19_preview_seed_refuses_unknown_project' using errcode = '55000',
      detail = format('Declared target %L is not the skillcheck-preview project.', target_ref),
      hint = 'This seed is preview-only. Nothing else may receive commercial state from a file.';
  end if;

  -- Only then: the credit/payment schema this seed writes into must be installed.
  if to_regclass('private.sc19_package_policy') is null
     or to_regclass('private.sc19_payment_offers') is null then
    raise exception 'sc19_preview_seed_requires_m13' using errcode = '55000';
  end if;

  -- The owner-approved quotas, as the operator would set them in /operator/billing.
  -- An existing operator value is KEPT, never overwritten by this file.
  insert into private.sc19_package_policy(plan, credits)
    values ('FREE', 5), ('PRESELEKCJA', 60)
    on conflict (plan) do nothing;

  -- The shown number, the accepted number and the granted number must be the same
  -- number. private.sc19_grant_paid() grants whatever private.sc19_package_policy
  -- holds for PRESELEKCJA, and the offer row below carries `credits` in a column
  -- that is immutable once issued, so the two cannot be reconciled afterwards.
  -- The offer is therefore not published while the stored quota differs from the
  -- 60 this revision was approved for, and every offer already in the database
  -- is withdrawn.
  if (select credits from private.sc19_package_policy where plan = 'PRESELEKCJA') is distinct from 60 then
    -- Nothing may stay purchasable: every revision this seed could have issued
    -- sells 60 analyses, and the stored quota is not 60.
    update private.sc19_payment_offers set active = false, approved = false
      where active or approved;
    raise notice 'sc19-preselekcja-offer: stored PRESELEKCJA quota is not 60; the 60 CV / 300 zl offer is NOT published and nothing this seed issued is purchasable';
    return;
  end if;

  -- An expired revision has nothing left to publish. Report and finish, so a
  -- fresh preview database can still be built after 2027-12-31, and withdraw
  -- every offer so no reader that ignores valid_until_ms sees one.
  if offer_valid_until <= (extract(epoch from now()) * 1000)::bigint then
    update private.sc19_payment_offers set active = false, approved = false
      where active or approved;
    raise notice 'sc19-preselekcja-offer: the PRESELEKCJA offer revision expired at %, nothing is published; issue a new reviewed revision with an owner-approved validity', to_timestamp(offer_valid_until / 1000.0);
    return;
  end if;

  -- 30000 minor units PLN = 300,00 zl gross (243,90 zl net + 56,10 zl VAT at 23%).
  insert into private.sc19_payment_offers(
    id, revision, plan, active, approved,
    amount_minor, currency, credits,
    terms_revision, terms_text, valid_until_ms)
  values (
    offer_id, 'preselekcja-60-v3', 'PRESELEKCJA', true, true,
    30000, 'PLN', 60,
    'preselekcja-terms-2026-11-v3',
    'PRESELEKCJA — jednorazowy pakiet 60 analiz CV za 300,00 zł brutto '
    || '(243,90 zł netto + 56,10 zł VAT 23%).' || chr(10)
    || 'Analizy są ważne 3 miesiące od dnia ich przyznania i nie przechodzą na kolejny okres.' || chr(10)
    || 'Analizy przyznajemy po zaksięgowaniu wpłaty na naszym rachunku, a przy '
    || 'płatności online — po jej potwierdzeniu przez operatora płatności.' || chr(10)
    || 'Faktura VAT jest wystawiana po zaksięgowaniu płatności i wysyłana e-mailem.' || chr(10)
    || 'Wynik analizy jest informacją wspierającą rekrutera. SkillCheck nie podejmuje '
    || 'decyzji o zatrudnieniu — każdy wynik weryfikuje człowiek.' || chr(10)
    || 'Zasady reklamacji i odstąpienia opisuje Regulamin (§ 10–11); '
    || 'wzór formularza odstąpienia jest dostępny pod /regulamin/formularz-odstapienia.' || chr(10)
    || 'Dane osobowe kandydatów są przetwarzane na podstawie Umowy powierzenia (DPA), '
    || 'dostępnej pod /regulamin/umowa-powierzenia.',
    offer_valid_until)
  on conflict (id) do nothing;

  -- Re-run after a manual deactivation on preview: the row already exists, so the
  -- INSERT above did nothing and the two mutable flags are set here instead.
  update private.sc19_payment_offers set active = true, approved = true
    where id = offer_id and not (active and approved);

  -- Every other revision a preview database may hold (the ASCII one, r2 whose
  -- terms text v3 corrects, or anything a Preview walk left behind) stops being
  -- offered. Withdrawn by identity, not from a list, so an id nobody wrote down
  -- cannot survive this. The rows stay: they are undeletable and a paid order
  -- would reference them.
  update private.sc19_payment_offers set active = false, approved = false
    where id <> offer_id and (active or approved);

  select count(*)::integer into seeded_offer from private.sc19_payment_offers
    where approved and active
      and valid_until_ms > (extract(epoch from now()) * 1000)::bigint;
  -- Reached only when this revision is in date and the stored quota matches, so
  -- anything but exactly one purchasable offer here really is a broken seed, not
  -- an expired offer. Two is as wrong as none: a second purchasable offer would
  -- show the customer a choice nobody approved.
  if seeded_offer <> 1 then
    raise exception 'sc19_preview_seed_not_exactly_one_offer' using errcode = '55000',
      detail = format('%s purchasable offers after the seed; expected exactly 1.', seeded_offer);
  end if;
  -- And the one that survived is this revision, with the approved economics.
  if not exists (select 1 from private.sc19_payment_offers
    where id = offer_id and plan = 'PRESELEKCJA' and approved and active
      and credits = 60 and amount_minor = 30000 and currency = 'PLN'
      and valid_until_ms > (extract(epoch from now()) * 1000)::bigint) then
    raise exception 'sc19_preview_seed_no_purchasable_offer' using errcode = '55000';
  end if;

  -- The terms the customer accepts must not silently lose Polish letters.
  if exists (select 1 from private.sc19_payment_offers
    where id = offer_id and terms_text !~ '[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]') then
    raise exception 'sc19_preview_seed_terms_diacritics_missing' using errcode = '55000';
  end if;
end
$sc19_preview_seed$;

commit;
