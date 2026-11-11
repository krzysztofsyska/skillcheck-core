-- SC-P24-SANDBOX-PROD: dedicated least-privilege login role for the Przelewy24
-- SANDBOX checkout served from the production domain.
--
-- WHY. Owner decision, by voice, 2026-11-11: a Przelewy24 verifier must be able to
-- walk the purchase path on https://skillcheck.pl all the way to the Przelewy24
-- payment page and pay with test money (bank transfer or BLIK). A disabled
-- "wkrótce" button is not acceptable to the verifier. The checkout adapter
-- (lib/sc19-payment-postgres.ts) talks to the database with its OWN restricted
-- login, never with a Supabase service key and never with a superuser-ish
-- `postgres` credential; production has no direct-Postgres credential of any kind
-- (all POSTGRES_* variables were removed from Vercel Production on 2026-11-01).
-- So the adapter needs a role of its own here, mirroring what
-- supabase/preview-setup/sc19-p24-runtime.sql installed on the TEST project
-- skillcheck-preview for the preview walk.
--
-- The application code still refuses to go live: lib/sc19-payment-preview.ts only
-- builds a configuration when P24_SANDBOX=true, and the runtime is composed with
-- mode 'test', liveApproved false and the sandbox checkout origin only. This role
-- is equally mode-bound: its RLS policy on private.sc19_payment_orders accepts
-- mode='test' and provider='przelewy24' and nothing else, so even a stolen
-- password cannot create or settle a LIVE order.
--
-- WHAT THIS MIGRATION CREATES. One role plus grants and policies for it. No
-- table, no column, no constraint, no trigger and no row. private.erasure_schema_signature()
-- covers relations, columns, constraints and triggers, so the SC-010 schema
-- signature is unchanged; the relation allowlist is unchanged; and every
-- accounting table that tests/sc-019-migrations-production-history.test.mjs
-- inspects stays empty, so "No commercial activation or retrospective billing"
-- still holds. Nothing here publishes an offer, sets a quota, grants credits or
-- switches a provider on.
--
-- NO PASSWORD HERE, EVER. The role is created NOLOGIN and with no password, so
-- applying this file gives nobody a way in. The owner sets the password himself,
-- on the production database, and pastes the connection string into the Vercel
-- Production variable SC19_P24_CHECKOUT_DATABASE_URL. A password, or any
-- statement that sets one, must never appear in a migration or in any other
-- committed file. Steps for the owner: docs/p24-sandbox-produkcja-2026-11-11.md.
--
-- WHY EACH PRIVILEGE. Derived from what lib/sc19-payment-postgres.ts actually
-- executes, and deliberately identical to the privileges `sc19_p24_preview` holds
-- on skillcheck-preview (read 2026-11-11 from pg_class.relacl, pg_attribute.attacl,
-- pg_proc.proacl and pg_policies on orbyscrupgnupifzlqxp) -- no more:
--
--   public.companies            select(id,owner_id) for the ownership check,
--                               update(id) only because `select ... for update`
--                               needs the UPDATE privilege to take the company
--                               lock. A RESTRICTIVE policy with `check (false)`
--                               makes an actual UPDATE impossible.
--   private.sc19_trial_approvals select(company_id) + update(company_id) for the
--                               `for share` verification read; `check (false)`
--                               again forbids writing. The role deliberately has
--                               NO access to the nip column.
--   private.sc19_payment_offers select (the store reads the whole row) and
--                               update(id) for `for share`; the policy only shows
--                               approved AND active offers and `check (false)`
--                               forbids editing a price or its terms.
--   private.sc19_payment_orders select/insert and update of exactly the four
--                               columns the order lifecycle writes
--                               (status, session_id, checkout_url, payment_id).
--                               Price, credits, buyer, offer and mode are
--                               immutable to this role.
--   private.sc19_payment_requests, private.sc19_payment_grants
--                               select/insert for request binding and the
--                               once-only settlement receipt. No update, no
--                               delete: a receipt cannot be rewritten or removed.
--   private.sc19_credit_journal insert of the four audited columns only, and only
--                               reason='paid_grant' with a positive delta and a
--                               canonical settlement reference. No select: the
--                               adapter never reads the journal.
--   private.sc19_balances       select plus insert/update of plan and available
--                               (and updated_at) to add the paid credits, pinned
--                               to plan='PRESELEKCJA'.
--   private.sc19_has_pending_catalog_order(uuid)
--                               execute, so a new order is refused while a
--                               catalog order is pending (SC-019 commerce).
--
-- Re-runnable: the role is created only if missing, policies are dropped before
-- being created and every grant is idempotent, so a Preview resync or a repeated
-- apply leaves exactly the same privileges.
begin;

do $preflight$
begin
  if to_regclass('public.companies') is null
     or to_regclass('private.sc19_trial_approvals') is null
     or to_regclass('private.sc19_payment_offers') is null
     or to_regclass('private.sc19_payment_orders') is null
     or to_regclass('private.sc19_payment_requests') is null
     or to_regclass('private.sc19_payment_grants') is null
     or to_regclass('private.sc19_credit_journal') is null
     or to_regclass('private.sc19_balances') is null then
    raise exception 'sc19_p24_checkout_requires_m13' using errcode = '55000';
  end if;
end
$preflight$;

-- The identity. Created without LOGIN and without a password; the owner adds both
-- outside the repository. If a role of this name already exists, it is adopted
-- only when its privileges are the ones we expect: anything wider means the name
-- belongs to something else and this migration must not grant data access to it.
-- LOGIN is accepted on a re-run, because by then the owner has enabled it.
do $role$
begin
  if not exists (select 1 from pg_roles where rolname = 'sc19_p24_checkout') then
    create role sc19_p24_checkout nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
  end if;
  if exists (select 1 from pg_roles where rolname = 'sc19_p24_checkout'
      and (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or rolinherit)) then
    raise exception 'sc19_p24_checkout_unsafe_role' using errcode = '55000';
  end if;
  -- It must inherit nothing: a membership in another role would widen it beyond
  -- the grants below. The reverse direction is NOT checked, because PostgreSQL 16+
  -- makes the CREATEROLE user that creates a role a member of it automatically,
  -- which is how the hosted `postgres` identity manages every role here.
  if exists (select 1 from pg_auth_members m where m.member = 'sc19_p24_checkout'::regrole) then
    raise exception 'sc19_p24_checkout_unexpected_membership' using errcode = '55000';
  end if;
end
$role$;

grant usage on schema private, public to sc19_p24_checkout;

-- Commerce may or may not be installed where this file is applied.
do $commerce_acl$
begin
  if to_regprocedure('private.sc19_has_pending_catalog_order(uuid)') is not null then
    grant execute on function private.sc19_has_pending_catalog_order(uuid) to sc19_p24_checkout;
  end if;
end
$commerce_acl$;

-- FOR UPDATE / FOR SHARE need the UPDATE privilege and a policy that can see the
-- row. No actual update to these three read/lock-only relations can pass the
-- check expressions below.
grant select(id, owner_id), update(id) on public.companies to sc19_p24_checkout;
grant select(company_id), update(company_id) on private.sc19_trial_approvals to sc19_p24_checkout;
grant select, update(id) on private.sc19_payment_offers to sc19_p24_checkout;

drop policy if exists p24_checkout_read on public.companies;
drop policy if exists p24_checkout_lock on public.companies;
drop policy if exists p24_checkout_no_company_edit on public.companies;
create policy p24_checkout_read on public.companies for select to sc19_p24_checkout using (true);
create policy p24_checkout_lock on public.companies for update to sc19_p24_checkout using (true) with check (false);
create policy p24_checkout_no_company_edit on public.companies as restrictive for update to sc19_p24_checkout using (true) with check (false);

drop policy if exists p24_checkout_read on private.sc19_trial_approvals;
drop policy if exists p24_checkout_lock on private.sc19_trial_approvals;
create policy p24_checkout_read on private.sc19_trial_approvals for select to sc19_p24_checkout using (true);
create policy p24_checkout_lock on private.sc19_trial_approvals for update to sc19_p24_checkout using (true) with check (false);

drop policy if exists p24_checkout_read on private.sc19_payment_offers;
drop policy if exists p24_checkout_lock on private.sc19_payment_offers;
create policy p24_checkout_read on private.sc19_payment_offers for select to sc19_p24_checkout using (approved and active);
create policy p24_checkout_lock on private.sc19_payment_offers for update to sc19_p24_checkout using (approved and active) with check (false);

-- The order lifecycle. TEST orders of this one provider and nothing else: a LIVE
-- order can be neither created nor read nor settled through this role.
grant select, insert, update(status, session_id, checkout_url, payment_id)
  on private.sc19_payment_orders to sc19_p24_checkout;
drop policy if exists p24_checkout_orders on private.sc19_payment_orders;
create policy p24_checkout_orders on private.sc19_payment_orders to sc19_p24_checkout
  using (mode = 'test' and provider = 'przelewy24') with check (mode = 'test' and provider = 'przelewy24');

grant select, insert on private.sc19_payment_requests, private.sc19_payment_grants to sc19_p24_checkout;
drop policy if exists p24_checkout_requests on private.sc19_payment_requests;
create policy p24_checkout_requests on private.sc19_payment_requests to sc19_p24_checkout
  using (exists (select 1 from private.sc19_payment_orders o where o.id = order_id))
  with check (exists (select 1 from private.sc19_payment_orders o where o.id = order_id));
drop policy if exists p24_checkout_receipts on private.sc19_payment_grants;
create policy p24_checkout_receipts on private.sc19_payment_grants to sc19_p24_checkout
  using (exists (select 1 from private.sc19_payment_orders o where o.id = order_id))
  with check (exists (select 1 from private.sc19_payment_orders o where o.id = order_id));

-- Settlement. Append-only accounting with a canonical reference, and a balance
-- row that can only ever hold the PRESELEKCJA plan.
grant insert(company_id, reason, delta, reference) on private.sc19_credit_journal to sc19_p24_checkout;
drop policy if exists p24_checkout_grant on private.sc19_credit_journal;
create policy p24_checkout_grant on private.sc19_credit_journal for insert to sc19_p24_checkout
  with check (reason = 'paid_grant' and delta > 0 and reference ~ '^settlement:sc19:[0-9a-f]{64}$');

grant select, insert(company_id, plan, available), update(plan, available, updated_at)
  on private.sc19_balances to sc19_p24_checkout;
drop policy if exists p24_checkout_balance on private.sc19_balances;
create policy p24_checkout_balance on private.sc19_balances to sc19_p24_checkout
  using (true) with check (plan = 'PRESELEKCJA');

commit;
