-- R7 (docs/ROADMAP.md, live Stripe + Fakturownia invoices; Codex P2 on promotion #594):
-- remember WHEN the application tried to issue an invoice or a correction, so a
-- document whose response was lost is looked up in Fakturownia only around those
-- days (issue_date from the first attempt day −1 to the last attempt day +1),
-- instead of the whole account history since the payment (which hit the 20-page
-- cap on a busy account and never finished).
--
-- ADDITIVE ONLY: two nullable columns on each of sc19_stripe.invoices and
-- sc19_stripe.invoice_corrections (migration 20261122090000), and column UPDATE
-- grants for the payment adapter's existing roles (each only where it exists). No
-- row, constraint, policy, trigger or function is changed. The tables are outside
-- public/private, so the SC-010 erasure schema signature stays the same (checked).
--
-- Code compatibility: the code shipped with this change reads the columns only when
-- they exist; without them it searches from the payment date as before.
-- Production: applied only through db-migrate-production after the owner's approval.
-- Rollback: supabase/rollbacks/20261122110000_r7_invoice_attempt_window_down.sql.
begin;

do $preflight$
begin
 if to_regclass('sc19_stripe.invoices') is null or to_regclass('sc19_stripe.invoice_corrections') is null then
  raise exception 'r7_invoice_attempt_window_requires_r7_stripe_live_invoices' using errcode='55000';end if;
 if exists(select 1 from information_schema.columns where table_schema='sc19_stripe' and table_name='invoices'
   and column_name='first_attempt_at') then
  raise exception 'r7_invoice_attempt_window_already_installed' using errcode='55000';end if;
 perform set_config('r7_invoice_window.signature_before', private.erasure_schema_signature(), true);
end $preflight$;

alter table sc19_stripe.invoices add column first_attempt_at timestamptz, add column last_attempt_at timestamptz;
alter table sc19_stripe.invoice_corrections add column first_attempt_at timestamptz, add column last_attempt_at timestamptz;

do $roles$
declare r text;
begin
 foreach r in array array['sc19_p24_preview','sc19_p24_checkout'] loop
  continue when not exists(select 1 from pg_roles where rolname=r);
  execute format('grant update(first_attempt_at, last_attempt_at) on sc19_stripe.invoices, sc19_stripe.invoice_corrections to %I', r);
 end loop;
end $roles$;

do $postflight$
begin
 if private.erasure_schema_signature() is distinct from current_setting('r7_invoice_window.signature_before') then
  raise exception 'r7_invoice_attempt_window_changed_erasure_schema' using errcode='55000';end if;
end $postflight$;

commit;
