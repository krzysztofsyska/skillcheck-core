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
-- Idempotent: inserts are ON CONFLICT DO NOTHING and every UPDATE is conditional,
-- so re-running changes nothing. private.sc19_payment_offers is update-immutable
-- (private.sc19_payment_immutable() allows an UPDATE only of active/approved and
-- refuses every DELETE), so an issued revision is never rewritten; the accented
-- revision is a row of its own and an older ASCII revision is only deactivated.
begin;

do $sc19_preview_seed$
declare
  seeded_offer integer;
  live_rows integer;
  -- 2027-12-31T23:59:59Z, the validity this offer revision was approved with.
  offer_valid_until constant bigint := 1830297599000;
  -- Every offer id this seed has ever issued, so a Preview database that already
  -- received the earlier ASCII revision ends with exactly one purchasable offer.
  superseded constant text[] := array['preselekcja-60-2026-11'];
begin
  if to_regclass('private.sc19_package_policy') is null
     or to_regclass('private.sc19_payment_offers') is null then
    raise exception 'sc19_preview_seed_requires_m13' using errcode = '55000';
  end if;

  -- Second line of defence behind the workflow's connection-string check: refuse
  -- a database that already carries real commercial activity. skillcheck-preview
  -- is test-only and has none; a live database would, and a seed must never
  -- rewrite or sit beside somebody's real billing state.
  -- private.sc19_trial_approvals and private.sc19_analysis_spend are deliberately
  -- NOT counted: a trial approval is an operator verification of a company/NIP,
  -- not commercial activity, and the FREE preselection walk this seed exists for
  -- needs one, so counting it would make the seed refuse its own preview database.
  select coalesce(sum(n), 0)::integer into live_rows from (
    select count(*) n from private.sc19_balances
    union all select count(*) from private.sc19_credit_journal
    union all select count(*) from private.sc19_payment_orders
    union all select count(*) from private.sc19_payment_grants
  ) activity;
  if live_rows <> 0 then
    raise exception 'sc19_preview_seed_refuses_live_database' using errcode = '55000',
      detail = format('%s existing balance/journal/order/grant rows', live_rows),
      hint = 'This is a preview-only seed. Quotas and offers on a live database are an owner action in /operator/billing.';
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
  -- 60 this revision was approved for, and anything this seed already published
  -- is withdrawn.
  if (select credits from private.sc19_package_policy where plan = 'PRESELEKCJA') is distinct from 60 then
    update private.sc19_payment_offers set active = false, approved = false
      where id = any(superseded || array['preselekcja-60-2026-11-r2']) and (active or approved);
    raise notice 'sc19-preselekcja-offer: stored PRESELEKCJA quota is not 60; the 60 CV / 300 zl offer is NOT published and nothing this seed issued is purchasable';
    return;
  end if;

  -- An expired revision has nothing left to publish. Report and finish, so a
  -- fresh preview database can still be built after 2027-12-31, and withdraw
  -- anything this seed published so no reader that ignores valid_until_ms sees it.
  if offer_valid_until <= (extract(epoch from now()) * 1000)::bigint then
    update private.sc19_payment_offers set active = false, approved = false
      where id = any(superseded || array['preselekcja-60-2026-11-r2']) and (active or approved);
    raise notice 'sc19-preselekcja-offer: the PRESELEKCJA offer revision expired at %, nothing is published; issue a new reviewed revision with an owner-approved validity', to_timestamp(offer_valid_until / 1000.0);
    return;
  end if;

  -- 30000 minor units PLN = 300,00 zl gross (243,90 zl net + 56,10 zl VAT at 23%).
  insert into private.sc19_payment_offers(
    id, revision, plan, active, approved,
    amount_minor, currency, credits,
    terms_revision, terms_text, valid_until_ms)
  values (
    'preselekcja-60-2026-11-r2', 'preselekcja-60-v2', 'PRESELEKCJA', true, true,
    30000, 'PLN', 60,
    'preselekcja-terms-2026-11-v2',
    'PRESELEKCJA — jednorazowy pakiet 60 analiz CV za 300,00 zł brutto '
    || '(243,90 zł netto + 56,10 zł VAT 23%).' || chr(10)
    || 'Analizy są ważne 3 miesiące od dnia ich przyznania i nie przechodzą na kolejny okres.' || chr(10)
    || 'Analizy przyznajemy po potwierdzeniu płatności przez operatora płatności.' || chr(10)
    || 'Faktura VAT jest wystawiana po zaksięgowaniu płatności i wysyłana e-mailem.' || chr(10)
    || 'Wynik analizy jest informacją wspierającą rekrutera. SkillCheck nie podejmuje '
    || 'decyzji o zatrudnieniu — każdy wynik weryfikuje człowiek.' || chr(10)
    || 'Zasady zamówienia, reklamacji i odstąpienia opisuje Regulamin (§ 10–11); '
    || 'wzór formularza odstąpienia jest dostępny pod /regulamin/formularz-odstapienia.' || chr(10)
    || 'Dane osobowe kandydatów są przetwarzane na podstawie Umowy powierzenia (DPA), '
    || 'dostępnej pod /regulamin/umowa-powierzenia.',
    offer_valid_until)
  on conflict (id) do nothing;

  -- Re-run after a manual deactivation on preview: the row already exists, so the
  -- INSERT above did nothing and the two mutable flags are set here instead.
  update private.sc19_payment_offers set active = true, approved = true
    where id = 'preselekcja-60-2026-11-r2' and not (active and approved);

  -- A preview database that received the earlier ASCII revision stops offering
  -- it. The row stays: it is undeletable and a paid order would reference it.
  update private.sc19_payment_offers set active = false, approved = false
    where id = any(superseded) and (active or approved);

  select count(*)::integer into seeded_offer from private.sc19_payment_offers
    where plan = 'PRESELEKCJA' and approved and active
      and credits = 60 and amount_minor = 30000 and currency = 'PLN'
      and valid_until_ms > (extract(epoch from now()) * 1000)::bigint;
  -- Reached only when this revision is in date and the stored quota matches, so
  -- nothing purchasable here really is a broken seed, not an expired offer.
  if seeded_offer = 0 then
    raise exception 'sc19_preview_seed_no_purchasable_offer' using errcode = '55000';
  end if;

  -- The terms the customer accepts must not silently lose Polish letters.
  if exists (select 1 from private.sc19_payment_offers
    where id = 'preselekcja-60-2026-11-r2' and terms_text !~ '[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]') then
    raise exception 'sc19_preview_seed_terms_diacritics_missing' using errcode = '55000';
  end if;
end
$sc19_preview_seed$;

commit;
