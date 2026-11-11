-- SC-019 offer publication: the operator publishes the approved PRESELEKCJA
-- offer from /operator/billing, instead of a migration seeding commercial state
-- or privileged SQL on the production database.
--
-- WHY THIS SHAPE
--
-- private.sc19_payment_offers is empty on production (checked 2026-11-11), so
-- lib/sc19-payment-postgres.ts listOffers() returns nothing and a verified
-- company sees no package to buy. The preview path to the same row is
-- supabase/preview-seeds/sc19-preselekcja-offer.sql, which is deliberately NOT
-- a migration: publishing an approved+active offer from a file would switch
-- commercial state on wherever the chain is applied, including production,
-- without the owner ever acting. tests/sc-019-migrations-production-history.test.mjs
-- refuses exactly that ("No commercial activation or retrospective billing")
-- and that guard is right.
--
-- So this migration installs the MECHANISM and publishes NOTHING. It creates
-- functions and grants only: no table, column, constraint, trigger or row. The
-- SC-010 erasure schema signature covers relations, columns, constraints and
-- triggers (private.erasure_schema_signature()), so it is unchanged, the
-- relation allowlist is unchanged, and every accounting table the production
-- history guard inspects stays empty. Publishing stays an explicit operator
-- click, recorded by the row's created_at.
--
-- WHAT THE OPERATOR CANNOT DO
--
-- The operator publishes; he does not draft. The offer id, revision, terms
-- revision, terms text, amount and CV count are CONSTANTS in
-- private.sc19_offer_revision() below, reviewed in this pull request. The
-- publishing function takes no arguments at all: there is no field in which an
-- operator could type a price, a CV count or a contract clause. A new revision
-- is a new reviewed migration that replaces these constants, which keeps the
-- legal artifact in code review where it belongs.
--
-- The constants are the ones already live on the TEST project skillcheck-preview
-- (row preselekcja-60-2026-11-r2, read 2026-11-11): 30000 minor units PLN =
-- 300,00 zl gross for 60 CV analyses, terms revision preselekcja-terms-2026-11-v2,
-- terms text md5 a535d6098abdc3240e12eca8e22ad46e, valid until 1830297599000
-- (2027-12-31T23:59:59Z). Price and contents are the owner's decision of
-- 2026-10-28, reconfirmed 2026-11-01 and 2026-11-02; source of truth
-- docs/cennik-2026-11-02.md. Nothing here changes a price or a package.
--
-- WHAT IT REFUSES
--
-- An offer that disagrees with the price catalog is the failure this is built to
-- make impossible, so publication is refused unless the PUBLISHED catalog
-- version in pricing.package_prices has PRESELEKCJA at exactly this gross amount
-- and CV count and marked sellable, AND private.sc19_package_policy grants the
-- same number of analyses. The shown number, the accepted number and the granted
-- number must be one number: private.sc19_grant_paid() grants whatever the
-- policy holds, while the offer's credits column is immutable once issued, so
-- the two cannot be reconciled afterwards.
--
-- An expired revision is refused rather than published dead.
--
-- NEVER TWO ACTIVE, NEVER ZERO WHERE ONE WAS
--
-- private.sc19_payment_immutable() refuses every DELETE and every UPDATE except
-- of active/approved, so a new revision is published by withdrawing the previous
-- row and inserting the new one. Both happen in this function's single
-- transaction, under an advisory lock that serialises concurrent publications,
-- and the function asserts before returning that exactly one approved, active,
-- in-date offer exists and that it is this revision. If that assertion fails
-- nothing is committed, so no reader can observe two offers or none.
--
-- This migration does NOT activate a payment provider. resolveSc19PaymentRuntime()
-- still returns null without provider configuration, so POST /api/billing/checkout
-- keeps answering SC19_PAYMENTS_DISABLED and no order can be created. Publishing
-- the offer makes the package, its price and its terms visible to a verified
-- company; the sale itself is settled by bank transfer and the package is granted
-- by the operator (owner decision 2026-11-01).
begin;

do $preflight$
begin
  if to_regclass('private.sc19_payment_offers') is null
     or to_regclass('private.sc19_package_policy') is null then
    raise exception 'sc19_offer_publication_requires_m13' using errcode = '55000';
  end if;
  if to_regprocedure('private.sc19_require_operator()') is null then
    raise exception 'sc19_offer_publication_requires_operator_fulfillment' using errcode = '55000';
  end if;
  if to_regclass('pricing.package_prices') is null
     or to_regclass('pricing.catalog_versions') is null then
    raise exception 'sc19_offer_publication_requires_pricing_catalog' using errcode = '55000';
  end if;
end
$preflight$;

-- The reviewed offer revision. ONE place holds the legal and economic constants,
-- read by both the publishing function and the operator's read-only view, so the
-- panel can never show terms other than the ones publication would issue.
--
-- Changing any value here is a new revision: give it a NEW id, because
-- private.sc19_payment_offers rows are immutable once issued and a paid order
-- references the id it was bought under.
create function private.sc19_offer_revision()
returns table(offer_id text, revision text, terms_revision text, terms_text text,
  plan text, amount_minor integer, currency text, credits integer, valid_until_ms bigint)
language sql immutable set search_path = '' as $$
  select
    'preselekcja-60-2026-11-r2',
    'preselekcja-60-v2',
    'preselekcja-terms-2026-11-v2',
    -- 30000 minor units PLN = 300,00 zl gross (243,90 zl net + 56,10 zl VAT 23%).
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
    'PRESELEKCJA',
    30000,
    'PLN',
    60,
    -- 2027-12-31T23:59:59Z. Deliberately finite: terms the customer accepts carry
    -- a revision with an end date. public.sc19_operator_published_offer() reports
    -- the remaining days and warns below 30, so the offer cannot quietly expire
    -- and stop sales without a signal in the panel.
    1830297599000::bigint
$$;
revoke all on function private.sc19_offer_revision() from public, anon, authenticated;

comment on function private.sc19_offer_revision() is
  'Reviewed PRESELEKCJA offer constants (price, CV count, terms, validity). Changing a value is a new revision with a new id in a new reviewed migration.';

-- What the operator sees: the published offer, this revision, the catalog and the
-- quota side by side, so the panel can state why publication would be refused
-- instead of only failing. Always returns exactly one row; the published_* fields
-- are null when nothing is published.
create function public.sc19_operator_published_offer()
returns table(
  published_offer_id text, published_revision text, published_terms_revision text,
  published_amount_minor integer, published_credits integer,
  published_valid_until_ms bigint, published_at timestamptz,
  expires_in_days integer, expiring_soon boolean,
  revision_offer_id text, revision_revision text, revision_terms_revision text,
  revision_amount_minor integer, revision_credits integer, revision_valid_until_ms bigint,
  catalog_gross_minor integer, catalog_cv_included integer, catalog_sellable boolean,
  policy_credits integer, publishable boolean, refusal text)
language plpgsql stable security definer set search_path = '' as $$
declare
  rev record;
  live record;
  cat record;
  cat_found boolean;
  quota integer;
  now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  why text := null;
begin
  perform private.sc19_require_operator();
  select * into rev from private.sc19_offer_revision();
  select o.id, o.revision, o.terms_revision, o.amount_minor, o.credits, o.valid_until_ms, o.created_at
    into live
    from private.sc19_payment_offers o
    where o.approved and o.active and o.valid_until_ms > now_ms
    order by o.created_at desc, o.id
    limit 1;
  select p.gross_minor, p.cv_included, p.sellable into cat
    from pricing.package_prices p
    join pricing.catalog_versions v on v.id = p.version_id
    where v.status = 'PUBLISHED' and p.package_code = rev.plan;
  cat_found := found;
  select c.credits into quota from private.sc19_package_policy c where c.plan = rev.plan;

  -- The same order of refusals as public.sc19_operator_publish_offer(), so the
  -- panel names the first thing to fix and the button does not then fail on a
  -- different one.
  if not cat_found then why := 'catalog_missing';
  elsif not cat.sellable then why := 'catalog_not_sellable';
  elsif cat.gross_minor is distinct from rev.amount_minor
     or cat.cv_included is distinct from rev.credits then why := 'catalog_mismatch';
  elsif quota is null then why := 'policy_missing';
  elsif quota is distinct from rev.credits then why := 'policy_mismatch';
  elsif rev.valid_until_ms <= now_ms then why := 'revision_expired';
  end if;

  return query select
    live.id, live.revision, live.terms_revision, live.amount_minor, live.credits,
    live.valid_until_ms, live.created_at,
    case when live.valid_until_ms is null then null
      else ((live.valid_until_ms - now_ms) / 86400000)::integer end,
    case when live.valid_until_ms is null then null
      else live.valid_until_ms - now_ms < 30 * 86400000::bigint end,
    rev.offer_id, rev.revision, rev.terms_revision, rev.amount_minor, rev.credits,
    rev.valid_until_ms,
    cat.gross_minor, cat.cv_included, cat.sellable,
    quota, why is null, why;
end;
$$;
revoke all on function public.sc19_operator_published_offer() from public, anon, authenticated;
grant execute on function public.sc19_operator_published_offer() to authenticated;

-- Publishes the reviewed revision. No arguments: the operator decides WHETHER to
-- publish, never WHAT. Idempotent — publishing the revision that is already
-- published changes nothing and returns the same row.
create function public.sc19_operator_publish_offer()
returns table(offer_id text, revision text, amount_minor integer, credits integer,
  terms_revision text, valid_until_ms bigint, published_at timestamptz, withdrawn integer)
language plpgsql volatile security definer set search_path = '' as $$
declare
  rev record;
  cat record;
  cat_found boolean;
  stored_found boolean;
  quota integer;
  stored private.sc19_payment_offers;
  retired integer := 0;
  now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  final record;
begin
  perform private.sc19_require_operator();
  select * into rev from private.sc19_offer_revision();

  -- Serialises concurrent publications for the whole transaction. Two operators
  -- clicking at once would otherwise each withdraw the other's row and both
  -- insert, and the final assertion would roll one back; the lock makes the
  -- second wait and find nothing to do.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('sc19_offer_publication'));

  -- The catalog is the single source of truth for what a customer pays and gets
  -- (SC-PRICING-W2). An offer that disagrees with it is refused, not published.
  select p.gross_minor, p.cv_included, p.sellable into cat
    from pricing.package_prices p
    join pricing.catalog_versions v on v.id = p.version_id
    where v.status = 'PUBLISHED' and p.package_code = rev.plan;
  cat_found := found;
  if not cat_found then
    raise exception 'sc19_offer_catalog_missing' using errcode = '55000',
      detail = 'No PUBLISHED price catalog version carries this package.';
  end if;
  if not cat.sellable then
    raise exception 'sc19_offer_catalog_not_sellable' using errcode = '55000',
      detail = 'The catalog marks this package as not purchasable.';
  end if;
  if cat.gross_minor is distinct from rev.amount_minor
     or cat.cv_included is distinct from rev.credits then
    raise exception 'sc19_offer_catalog_mismatch' using errcode = '55000',
      detail = format('Catalog has %s minor units / %s CV; this revision has %s / %s.',
        cat.gross_minor, cat.cv_included, rev.amount_minor, rev.credits);
  end if;

  -- The granted number must equal the shown number: private.sc19_grant_paid()
  -- grants the policy quota, and the offer's credits column is immutable.
  select c.credits into quota from private.sc19_package_policy c where c.plan = rev.plan;
  if quota is null then
    raise exception 'sc19_offer_policy_missing' using errcode = '55000',
      detail = 'Set the number of analyses for this package before publishing.';
  end if;
  if quota is distinct from rev.credits then
    raise exception 'sc19_offer_policy_mismatch' using errcode = '55000',
      detail = format('The package grants %s analyses; this revision sells %s.', quota, rev.credits);
  end if;

  if rev.valid_until_ms <= now_ms then
    raise exception 'sc19_offer_revision_expired' using errcode = '55000',
      detail = 'This revision is out of date; issue a new reviewed revision.';
  end if;

  -- An existing row under this id is immutable apart from active/approved, so if
  -- its economics or terms differ from the reviewed revision it must NOT be
  -- activated. That can only mean the constants changed without a new id.
  select * into stored from private.sc19_payment_offers where id = rev.offer_id;
  stored_found := found;
  if stored_found and (stored.revision is distinct from rev.revision
      or stored.plan is distinct from rev.plan
      or stored.amount_minor is distinct from rev.amount_minor
      or stored.currency is distinct from rev.currency
      or stored.credits is distinct from rev.credits
      or stored.terms_revision is distinct from rev.terms_revision
      or stored.terms_text is distinct from rev.terms_text
      or stored.valid_until_ms is distinct from rev.valid_until_ms) then
    raise exception 'sc19_offer_stored_revision_differs' using errcode = '55000',
      detail = 'A row with this id already exists with different terms or economics. Issue a new revision id.';
  end if;

  -- Withdraw every other purchasable offer first. The row itself stays: it is
  -- undeletable and a paid order references it.
  update private.sc19_payment_offers set active = false, approved = false
    where id <> rev.offer_id and (active or approved);
  get diagnostics retired = row_count;

  insert into private.sc19_payment_offers(
    id, revision, plan, active, approved, amount_minor, currency, credits,
    terms_revision, terms_text, valid_until_ms)
  values (
    rev.offer_id, rev.revision, rev.plan, true, true, rev.amount_minor, rev.currency,
    rev.credits, rev.terms_revision, rev.terms_text, rev.valid_until_ms)
  on conflict (id) do nothing;

  -- The row already existed (withdrawn earlier, or published already): the two
  -- mutable flags are the only thing publication may change.
  update private.sc19_payment_offers set active = true, approved = true
    where id = rev.offer_id and not (active and approved);

  -- Fail closed. Anything other than exactly this one purchasable offer rolls the
  -- whole publication back, so no reader ever sees two offers or none.
  select count(*)::integer total, min(o.id) only_id into final
    from private.sc19_payment_offers o
    where o.approved and o.active and o.valid_until_ms > now_ms;
  if final.total <> 1 or final.only_id is distinct from rev.offer_id then
    raise exception 'sc19_offer_publication_not_unique' using errcode = '55000',
      detail = format('%s purchasable offers after publication.', final.total);
  end if;

  return query select o.id, o.revision, o.amount_minor, o.credits, o.terms_revision,
    o.valid_until_ms, o.created_at, retired
    from private.sc19_payment_offers o where o.id = rev.offer_id;
end;
$$;
revoke all on function public.sc19_operator_publish_offer() from public, anon, authenticated;
grant execute on function public.sc19_operator_publish_offer() to authenticated;

commit;
