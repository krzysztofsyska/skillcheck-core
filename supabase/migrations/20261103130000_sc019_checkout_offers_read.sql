-- SC-P24-VERIFY-002: read the approved checkout offer without a payment provider.
--
-- A Przelewy24 verifier must be able to walk the purchase path and see the real
-- order summary (package, number of CV analyses, price, terms). Reading an offer
-- out of the database needs no payment provider; only registering a transaction
-- does. resolveSc19PaymentRuntime() still returns null, so
-- POST /api/billing/checkout and the webhook keep answering
-- SC19_PAYMENTS_DISABLED and no order can be created.
--
-- This migration creates ONE routine and no relations: its whole purpose is the
-- `create or replace function public.sc19_checkout_offers` below, plus that
-- function's grants. No table, column, constraint, index or trigger is created
-- or altered. private.erasure_schema_signature() covers relations and their
-- columns and constraints, not routines, so the SC-010 erasure schema signature
-- and the newest erasure inventory baseline (a relation allowlist) are unchanged
-- by it.
--
-- Authorization is exactly the one lib/sc19-payment-postgres.ts already enforces
-- for listOffers, re-checked in the database and not in the client:
--   1. an authenticated caller (auth.uid() is not null),
--   2. who OWNS the company (private.is_company_owner), and
--   3. whose company has an approved private.sc19_trial_approvals row.
-- Any other caller gets 42501, not an empty list, so this cannot become a way to
-- read offers (or to probe which companies exist) without access.
--
-- The function returns only the economic offer snapshot. It never returns a
-- balance, a NIP, a proof reference, an order, a session, a provider, an account,
-- a mode or a checkout URL, and it writes nothing.
begin;

do $preflight$
begin
  if to_regclass('private.sc19_payment_offers') is null
     or to_regclass('private.sc19_trial_approvals') is null
     or to_regprocedure('private.is_company_owner(uuid)') is null then
    raise exception 'sc19_checkout_offers_requires_m13' using errcode = '55000';
  end if;
end
$preflight$;

create or replace function public.sc19_checkout_offers(target_company uuid)
returns table(id text, revision text, plan text, amount_minor integer, currency text,
  credits integer, terms_revision text, terms_text text, valid_until_ms bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or target_company is null
     or not private.is_company_owner(target_company) then
    raise exception 'sc19_company_forbidden' using errcode = '42501';
  end if;
  -- Same requirement as the purchase path: an operator-verified company only.
  if not exists (select 1 from private.sc19_trial_approvals approval
    where approval.company_id = target_company) then
    raise exception 'sc19_offer_requires_verified_company' using errcode = '42501';
  end if;
  return query
    select offer.id, offer.revision, offer.plan, offer.amount_minor, offer.currency,
      offer.credits, offer.terms_revision, offer.terms_text, offer.valid_until_ms
    from private.sc19_payment_offers offer
    where offer.approved and offer.active
      and offer.valid_until_ms > (extract(epoch from now()) * 1000)::bigint
    order by offer.created_at desc, offer.id
    limit 20;
end;
$$;
revoke all on function public.sc19_checkout_offers(uuid) from public, anon, authenticated;
-- anon is deliberately NOT granted: an offer is only ever shown to a signed-in
-- owner of a verified company, never on a public surface.
grant execute on function public.sc19_checkout_offers(uuid) to authenticated;

do $service_role_acl$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.sc19_checkout_offers(uuid) from service_role;
  end if;
end
$service_role_acl$;

do $postflight$
begin
  if has_function_privilege('anon', 'public.sc19_checkout_offers(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.sc19_checkout_offers(uuid)', 'execute') then
    raise exception 'sc19_checkout_offers_acl_unreviewed' using errcode = '42501';
  end if;
  if has_table_privilege('anon', 'private.sc19_payment_offers', 'select')
     or has_table_privilege('authenticated', 'private.sc19_payment_offers', 'select') then
    raise exception 'sc19_checkout_offers_table_exposed' using errcode = '42501';
  end if;
end
$postflight$;

commit;
