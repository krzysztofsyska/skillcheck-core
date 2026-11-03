-- SC-P24-VERIFY-002: the purchasable PRESELEKCJA offer gets properly accented
-- Polish terms.
--
-- 20261103120000_sc019_seed_packages_offer seeded `terms_text` without Polish
-- diacritics. That text is what the customer accepts at checkout and what a
-- Przelewy24 verifier reads, so it must be correct Polish.
--
-- private.sc19_payment_offers is update-immutable: private.sc19_payment_immutable()
-- allows an UPDATE only of `active` and `approved` and refuses every DELETE,
-- because a paid order references the exact offer revision it was sold under.
-- The corrected text is therefore a NEW row with a NEW id and a NEW revision,
-- and the previous row is deactivated. Nothing is rewritten and nothing is
-- deleted.
--
-- Price, quota and validity are UNCHANGED owner decisions, carried over
-- verbatim: PRESELEKCJA = 60 analiz CV, 30000 minor units PLN = 300,00 zł gross
-- (243,90 zł net + 56,10 zł VAT at 23%), valid until 2027-12-31T23:59:59Z.
-- Source of truth: docs/cennik-2026-11-02.md. No price, package or MVP content
-- changes here; only the wording of the terms.
--
-- Data only: no table, column, index, trigger, policy, grant or routine is
-- created or altered, so the SC-010 erasure schema signature and the newest
-- erasure inventory baseline are unaffected.
--
-- Idempotent: the insert is ON CONFLICT DO NOTHING and both flag updates are
-- conditional, so re-running changes nothing.
--
-- Roll-forward after its own rollback works: the rollback leaves the accented
-- row in place with active=approved=false (the row is undeletable) and
-- re-activates the previous revision, so the INSERT below is a no-op
-- ON CONFLICT DO NOTHING. The re-activation of this migration's own id is what
-- makes the postflight pass; without it the migration would abort with
-- sc019_offer_terms_diacritics_no_purchasable_offer.
--
-- This does NOT activate a payment provider. resolveSc19PaymentRuntime() still
-- returns null, so POST /api/billing/checkout and the webhook keep answering
-- SC19_PAYMENTS_DISABLED and no order can be created.
begin;

do $sc19_offer_terms$
declare
  purchasable integer;
  paid_credits integer;
begin
  if to_regclass('private.sc19_payment_offers') is null then
    raise notice 'sc019_offer_terms_diacritics: SC-019 payment tables are not installed here, nothing to do';
    return;
  end if;

  -- Same rule as 20261103120000: the shown, accepted and granted quantity must
  -- be one number. private.sc19_grant_paid() grants the stored PRESELEKCJA
  -- quota, and an issued offer row cannot be rewritten, so this 60 CV revision
  -- is not published at all while the stored quota is something else.
  if to_regclass('private.sc19_package_policy') is not null then
    select p.credits into paid_credits from private.sc19_package_policy p where p.plan = 'PRESELEKCJA';
    if paid_credits is distinct from 60 then
      raise notice 'sc019_offer_terms_diacritics: stored PRESELEKCJA quota is %, not 60; the accented 60 CV / 300 zl revision is NOT published', paid_credits;
      return;
    end if;
  end if;

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
    1830297599000)
  on conflict (id) do nothing;

  -- Roll-forward after this migration's own rollback: the accented row already
  -- exists with active=approved=false, so the INSERT above did nothing. The
  -- accented revision is the one this migration publishes, so re-activate it
  -- unconditionally for its own id.
  update private.sc19_payment_offers set active = true, approved = true
    where id = 'preselekcja-60-2026-11-r2' and not (active and approved);

  -- The superseded revision stops being offered. Its row stays, because paid
  -- orders reference it; only the two mutable flags change.
  update private.sc19_payment_offers set active = false, approved = false
    where id = 'preselekcja-60-2026-11' and (active or approved);

  select count(*)::integer into purchasable from private.sc19_payment_offers
    where plan = 'PRESELEKCJA' and approved and active
      and credits = 60 and amount_minor = 30000 and currency = 'PLN'
      and valid_until_ms > (extract(epoch from now()) * 1000)::bigint;
  if purchasable = 0 then
    raise exception 'sc019_offer_terms_diacritics_no_purchasable_offer' using errcode = '55000';
  end if;

  -- The accepted terms must not silently lose Polish letters again.
  if exists (select 1 from private.sc19_payment_offers
    where approved and active and terms_text !~ '[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]') then
    raise exception 'sc019_offer_terms_diacritics_missing' using errcode = '55000';
  end if;
end
$sc19_offer_terms$;

commit;
