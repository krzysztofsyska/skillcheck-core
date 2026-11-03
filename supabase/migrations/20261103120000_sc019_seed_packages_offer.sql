-- SC-MVP: seed the approved package quotas and the single purchasable
-- PRESELEKCJA offer so the purchase path is walkable end to end.
--
-- Owner decisions carried here, nothing invented:
--   FREE        = 5 analiz CV, 0 zł            (owner 2026-11-02)
--   PRESELEKCJA = 60 analiz CV, 300 zł brutto  (owner 2026-10-28, reconfirmed
--                                               2026-11-01 and 2026-11-02)
-- Source of truth: docs/cennik-2026-11-02.md.
--
-- WERYFIKACJA and ASSESSMENT CENTER stay NON-purchasable (standing owner
-- decision, CLAUDE.md). This migration therefore does not touch the check
-- constraints that limit private.sc19_package_policy.plan to
-- ('FREE','PRESELEKCJA') and private.sc19_payment_offers.plan to 'PRESELEKCJA'.
--
-- Data only: no table, column, index, trigger, policy, grant or routine is
-- created or altered, so the SC-010 erasure schema signature and the newest
-- erasure inventory baseline are unaffected.
--
-- Idempotent: every insert is ON CONFLICT DO NOTHING and no issued offer
-- revision or approved quota is ever rewritten (private.sc19_payment_offers is
-- update-immutable except for the active/approved flags). The one UPDATE this
-- migration makes re-activates ITS OWN offer id, and only while nothing else is
-- purchasable, so re-running it where a later revision has superseded this one
-- changes nothing.
--
-- Roll-forward after its own rollback therefore works. The rollback leaves this
-- offer row in place with active=approved=false (the row is undeletable), so the
-- INSERT below is a no-op ON CONFLICT DO NOTHING; without the re-activation the
-- postflight would abort with sc019_seed_packages_offer_no_purchasable_offer.
--
-- Two conditions mean "there is nothing to publish", not "the chain is broken",
-- so both only report and return, and the migration still succeeds:
--   * the offer's own validity has passed (after 2027-12-31 this seed has nothing
--     left to publish). An abort there would make every fresh database
--     unbuildable from that date on — new preview branches, restore rehearsals,
--     CI matrix runs — for a reason that has nothing to do with the schema.
--   * the stored PRESELEKCJA quota is not the 60 this revision was approved for.
-- In both cases the end state is "nothing purchasable": the guards deactivate
-- the revisions this chain issued before returning, so a 60 CV / 300 zł offer
-- can never stay on sale next to a different stored quota, in whatever order and
-- however many times the two migrations of this chain run.
--
-- This seed does NOT activate a payment provider. resolveSc19PaymentRuntime()
-- still returns null, so /api/billing/* answers "payments unavailable" until a
-- reviewed Przelewy24 adapter and its keys exist. The offer exists so the
-- checkout page, the terms and the order form can be walked and verified.
begin;

do $sc19_seed_packages$
declare
  seeded_policy integer;
  seeded_offer integer;
  paid_credits integer;
  -- 2027-12-31T23:59:59Z, the validity this offer revision was approved with.
  offer_valid_until constant bigint := 1830297599000;
  -- Every offer id this SC-P24 chain issues. A guard that stops this chain from
  -- publishing deactivates all of them, so "nothing to publish" always ends as
  -- "nothing purchasable" regardless of which of the two migrations ran first or
  -- how often either is replayed. No row outside this chain is ever touched.
  chain_offers constant text[] := array['preselekcja-60-2026-11', 'preselekcja-60-2026-11-r2'];
begin
  if to_regclass('private.sc19_package_policy') is null then
    raise notice 'sc019_seed_packages_offer: SC-019 credit tables are not installed here, nothing seeded';
    return;
  end if;

  insert into private.sc19_package_policy(plan, credits)
    values ('FREE', 5), ('PRESELEKCJA', 60)
    on conflict (plan) do nothing;

  select count(*)::integer into seeded_policy from private.sc19_package_policy
    where (plan, credits) in (('FREE', 5), ('PRESELEKCJA', 60));
  if seeded_policy <> 2 then
    -- An operator-approved quota that differs from the owner decision is kept,
    -- never overwritten by a migration; it is only reported.
    raise notice 'sc019_seed_packages_offer: package policy differs from FREE=5/PRESELEKCJA=60, existing operator values kept';
  end if;

  if to_regclass('private.sc19_payment_offers') is null then
    raise notice 'sc019_seed_packages_offer: SC-019 payment tables are not installed here, no offer seeded';
    return;
  end if;

  -- The shown number, the accepted number and the granted number must be the
  -- same number. private.sc19_grant_paid() grants whatever
  -- private.sc19_package_policy holds for PRESELEKCJA, and the offer below
  -- carries `credits` in a row that is update-immutable once issued, so the two
  -- cannot be reconciled afterwards. The offer is therefore NOT published while
  -- the stored quota differs from the 60 this revision was approved for: a
  -- customer is never shown or asked to accept a quantity the grant would not
  -- deliver. Taking the number from the policy instead was rejected because the
  -- price (300,00 zł gross) and the terms text are fixed owner decisions tied to
  -- 60 analyses; a different quota is a different package and needs an owner
  -- decision plus a new offer revision, not an automatic re-pricing.
  select p.credits into paid_credits from private.sc19_package_policy p where p.plan = 'PRESELEKCJA';
  if paid_credits is distinct from 60 then
    -- Skipping the INSERT is not enough: the other migration of this chain may
    -- already have published its revision while the quota still matched (apply
    -- 20261103120000, change the quota in /operator/billing, apply
    -- 20261103130100 — or the reverse). An offer left `approved and active` here
    -- would sell 60 CV at 300 zl against a stored quota that grants something
    -- else. The flags are the only mutable columns, so deactivating every
    -- revision this chain issued is both possible and the complete answer.
    update private.sc19_payment_offers set active = false, approved = false
      where id = any(chain_offers) and (active or approved);
    raise notice 'sc019_seed_packages_offer: stored PRESELEKCJA quota is %, not 60; the 60 CV / 300 zl offer is NOT published and nothing of this chain is purchasable', paid_credits;
    return;
  end if;

  -- An offer whose validity has passed has nothing left to publish. Report it and
  -- finish successfully, so a fresh database can still be built after
  -- 2027-12-31; deactivate this chain's revisions so a replay cannot leave an
  -- expired-but-flagged offer behind for a reader that ignores valid_until_ms.
  if offer_valid_until <= (extract(epoch from now()) * 1000)::bigint then
    update private.sc19_payment_offers set active = false, approved = false
      where id = any(chain_offers) and (active or approved);
    raise notice 'sc019_seed_packages_offer: the PRESELEKCJA offer revision expired at %, nothing is published; issue a new reviewed revision with an owner-approved validity', to_timestamp(offer_valid_until / 1000.0);
    return;
  end if;

  -- 30000 minor units PLN = 300,00 zł gross (243,90 zł net + 23% VAT).
  -- valid_until_ms = 2027-12-31T23:59:59Z; a new revision replaces it, an
  -- existing row is never rewritten.
  insert into private.sc19_payment_offers(
    id, revision, plan, active, approved,
    amount_minor, currency, credits,
    terms_revision, terms_text, valid_until_ms)
  values (
    'preselekcja-60-2026-11', 'preselekcja-60-v1', 'PRESELEKCJA', true, true,
    30000, 'PLN', 60,
    'preselekcja-terms-2026-11',
    'PRESELEKCJA — jednorazowy pakiet 60 analiz CV za 300,00 zl brutto '
    || '(243,90 zl netto + 23% VAT).' || chr(10)
    || 'Analizy sa wazne 3 miesiace od dnia ich przyznania i nie przechodza na kolejny okres.' || chr(10)
    || 'Analizy przyznajemy po potwierdzeniu platnosci przez operatora platnosci.' || chr(10)
    || 'Faktura VAT jest wystawiana po zaksiegowaniu platnosci i wysylana e-mailem.' || chr(10)
    || 'Wynik analizy jest informacja wspierajaca rekrutera. SkillCheck nie podejmuje '
    || 'decyzji o zatrudnieniu — kazdy wynik weryfikuje czlowiek.' || chr(10)
    || 'Zasady zamowienia, reklamacji i odstapienia opisuje Regulamin (par. 10-11); '
    || 'wzor formularza odstapienia jest dostepny pod /regulamin/formularz-odstapienia.' || chr(10)
    || 'Dane osobowe kandydatow sa przetwarzane na podstawie Umowy powierzenia (DPA), '
    || 'dostepnej pod /regulamin/umowa-powierzenia.',
    offer_valid_until)
  on conflict (id) do nothing;

  -- Roll-forward after this migration's own rollback: the row already exists
  -- with active=approved=false, so the INSERT above did nothing. Re-activate
  -- exactly THIS id, and only while no other offer is purchasable, so a database
  -- where 20261103130100 has superseded this revision is left untouched.
  update private.sc19_payment_offers set active = true, approved = true
    where id = 'preselekcja-60-2026-11' and not (active and approved)
      and not exists (select 1 from private.sc19_payment_offers other
        where other.id <> 'preselekcja-60-2026-11' and other.approved and other.active
          and other.valid_until_ms > (extract(epoch from now()) * 1000)::bigint);

  select count(*)::integer into seeded_offer from private.sc19_payment_offers
    where plan = 'PRESELEKCJA' and approved and active
      and credits = 60 and amount_minor = 30000 and currency = 'PLN'
      and valid_until_ms > (extract(epoch from now()) * 1000)::bigint;
  -- Reached only when this revision is in date and the stored quota matches, so
  -- nothing purchasable here really is a broken migration, not an expired offer.
  if seeded_offer = 0 then
    raise exception 'sc019_seed_packages_offer_no_purchasable_offer' using errcode = '55000';
  end if;
end
$sc19_seed_packages$;

commit;
