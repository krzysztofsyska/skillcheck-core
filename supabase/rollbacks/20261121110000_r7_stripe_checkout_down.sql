-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback R7 Stripe checkout (20261121110000_r7_stripe_checkout.sql).
-- Refuses while a Stripe order or a stored Stripe customer exists: those are
-- accounting records and are never deleted by a rollback. Run with
-- `psql -v ON_ERROR_STOP=1`.
begin;

do $guard$
begin
 if exists(select 1 from private.sc19_payment_orders where provider='stripe') then
  raise exception 'r7_stripe_rollback_refused_orders_exist' using errcode='55000';end if;
 if to_regclass('sc19_stripe.customers') is not null and exists(select 1 from sc19_stripe.customers) then
  raise exception 'r7_stripe_rollback_refused_customers_exist' using errcode='55000';end if;
end $guard$;

do $policies$
declare r text;
begin
 foreach r in array array['sc19_p24_preview','sc19_p24_checkout'] loop
  execute format('drop policy if exists %I on private.sc19_payment_orders', 'stripe_checkout_orders_'||r);
 end loop;
end $policies$;

drop function if exists sc19_stripe.replace_customer(uuid,text,text,text);
drop function if exists sc19_stripe.buyer(uuid);
drop table if exists sc19_stripe.customers;
drop schema if exists sc19_stripe;

commit;
