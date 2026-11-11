-- Undoes 20261111140000_sc19_p24_checkout_role.sql: removes the sandbox checkout
-- role, its policies and its grants. No application data is touched; this
-- migration created none.
--
-- WHAT TO DO FIRST. Dropping the role is what actually turns the sandbox checkout
-- off at the database, so a running deployment will start failing its database
-- connection instead of refusing cleanly. The clean order is: remove the Vercel
-- Production variables P24_SANDBOX and SC19_P24_CHECKOUT_DATABASE_URL and
-- redeploy (then resolveSc19PaymentRuntime() returns null and the checkout button
-- is disabled again), and only then run this script. Both steps are the owner's.
--
-- Policies must go before the role: PostgreSQL refuses to drop a role that is
-- still referenced by one. `drop owned by` is deliberately NOT used -- this role
-- owns nothing, and that statement would also drop objects it merely has
-- privileges on in some versions' reading.
--
-- Re-runnable: `if exists` on every statement, so a partial earlier rollback
-- finishes cleanly.
begin;

drop policy if exists p24_checkout_read on public.companies;
drop policy if exists p24_checkout_lock on public.companies;
drop policy if exists p24_checkout_no_company_edit on public.companies;
drop policy if exists p24_checkout_read on private.sc19_trial_approvals;
drop policy if exists p24_checkout_lock on private.sc19_trial_approvals;
drop policy if exists p24_checkout_read on private.sc19_payment_offers;
drop policy if exists p24_checkout_lock on private.sc19_payment_offers;
drop policy if exists p24_checkout_orders on private.sc19_payment_orders;
drop policy if exists p24_checkout_requests on private.sc19_payment_requests;
drop policy if exists p24_checkout_receipts on private.sc19_payment_grants;
drop policy if exists p24_checkout_grant on private.sc19_credit_journal;
drop policy if exists p24_checkout_balance on private.sc19_balances;

do $revoke$
begin
  if not exists (select 1 from pg_roles where rolname = 'sc19_p24_checkout') then return; end if;
  revoke all on public.companies from sc19_p24_checkout;
  revoke all on private.sc19_trial_approvals from sc19_p24_checkout;
  revoke all on private.sc19_payment_offers from sc19_p24_checkout;
  revoke all on private.sc19_payment_orders from sc19_p24_checkout;
  revoke all on private.sc19_payment_requests from sc19_p24_checkout;
  revoke all on private.sc19_payment_grants from sc19_p24_checkout;
  revoke all on private.sc19_credit_journal from sc19_p24_checkout;
  revoke all on private.sc19_balances from sc19_p24_checkout;
  if to_regprocedure('private.sc19_has_pending_catalog_order(uuid)') is not null then
    revoke all on function private.sc19_has_pending_catalog_order(uuid) from sc19_p24_checkout;
  end if;
  revoke all on schema private, public from sc19_p24_checkout;
  drop role sc19_p24_checkout;
end
$revoke$;

commit;
