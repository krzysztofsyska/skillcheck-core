-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback R7 invoice attempt window (20261122110000_r7_invoice_attempt_window.sql).
-- Refuses while any attempt time is recorded (they belong to accounting rows).
-- Run with `psql -v ON_ERROR_STOP=1`.
begin;

do $guard$
begin
 if exists(select 1 from sc19_stripe.invoices where first_attempt_at is not null or last_attempt_at is not null)
  or exists(select 1 from sc19_stripe.invoice_corrections where first_attempt_at is not null or last_attempt_at is not null) then
  raise exception 'r7_invoice_attempt_window_rollback_refused_attempts_recorded' using errcode='55000';end if;
end $guard$;

alter table sc19_stripe.invoice_corrections drop column if exists last_attempt_at, drop column if exists first_attempt_at;
alter table sc19_stripe.invoices drop column if exists last_attempt_at, drop column if exists first_attempt_at;

commit;
