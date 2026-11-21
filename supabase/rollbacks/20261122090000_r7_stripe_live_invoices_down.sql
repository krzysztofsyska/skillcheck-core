-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback R7 live Stripe payments and Fakturownia invoices
-- (20261122090000_r7_stripe_live_invoices.sql). Refuses while any LIVE Stripe
-- order, LIVE customer, invoice, refund or correction record exists: those are
-- accounting records and are never deleted by a rollback. Restores the bodies of
-- 20261121110000_r7_stripe_checkout.sql (replace_customer) and
-- 20261121180000_r7_stripe_expired_session.sql (close_expired_order).
-- Run with `psql -v ON_ERROR_STOP=1`.
begin;

do $guard$
begin
 if exists(select 1 from private.sc19_payment_orders where provider='stripe' and mode='live') then
  raise exception 'r7_stripe_live_rollback_refused_live_orders_exist' using errcode='55000';end if;
 if exists(select 1 from sc19_stripe.customers where mode='live') then
  raise exception 'r7_stripe_live_rollback_refused_live_customers_exist' using errcode='55000';end if;
 if exists(select 1 from sc19_stripe.invoices) or exists(select 1 from sc19_stripe.refunds)
  or exists(select 1 from sc19_stripe.invoice_corrections) then
  raise exception 'r7_stripe_live_rollback_refused_invoices_exist' using errcode='55000';end if;
end $guard$;

do $policies$
declare r text;
begin
 foreach r in array array['sc19_p24_preview','sc19_p24_checkout'] loop
  execute format('drop policy if exists %I on private.sc19_payment_orders', 'stripe_live_orders_'||r);
  execute format('drop policy if exists %I on sc19_stripe.customers', 'stripe_live_customers_read_'||r);
  execute format('drop policy if exists %I on sc19_stripe.customers', 'stripe_live_customers_add_'||r);
 end loop;
end $policies$;

create or replace function sc19_stripe.replace_customer(target_company uuid, target_mode text, stale_id text, fresh_id text)
returns text language plpgsql volatile security definer set search_path='' as $$
declare stored text;
begin
 if target_mode is distinct from 'test' or fresh_id !~ '^cus_[A-Za-z0-9]{6,64}$' then
  raise exception 'stripe_customer_invalid' using errcode='22023';end if;
 update sc19_stripe.customers set customer_id=fresh_id
  where company_id=target_company and mode=target_mode and customer_id=stale_id;
 select customer_id into stored from sc19_stripe.customers where company_id=target_company and mode=target_mode;
 return stored;
end;$$;
revoke all on function sc19_stripe.replace_customer(uuid,text,text,text) from public, anon, authenticated;

create or replace function sc19_stripe.close_expired_order(target_order uuid, expired_session text) returns boolean
language plpgsql volatile security definer set search_path='' as $$
declare p private.sc19_payment_orders; k sc19_stripe.package_orders;
begin
 if target_order is null or expired_session is null or length(expired_session) not between 1 and 255 then
  raise exception 'stripe_order_close_invalid' using errcode='22023';end if;
 select * into p from private.sc19_payment_orders where id=target_order for update;
 if found then
  if p.checkout_url is not distinct from 'sc19:expired' then
   if p.session_id=expired_session then return false;end if;
   raise exception 'stripe_order_close_invalid' using errcode='22023';end if;
  if p.provider<>'stripe' or p.account<>'ktig-consulting' or p.mode<>'test' or p.status<>'awaiting_payment'
   or p.session_id is distinct from expired_session
   or exists(select 1 from private.sc19_payment_grants g where g.order_id=p.id) then
   raise exception 'stripe_order_close_invalid' using errcode='22023';end if;
  insert into sc19_stripe.order_closures(order_id, company_id, order_source, session_id, reason)
  values (p.id, p.company_id, 'preselekcja', p.session_id, 'session_expired');
  update private.sc19_payment_orders set checkout_url='sc19:expired' where id=p.id;
  return true;
 end if;
 select * into k from sc19_stripe.package_orders where id=target_order for update;
 if not found then raise exception 'stripe_order_close_invalid' using errcode='22023';end if;
 if k.status='expired' then
  if k.session_id=expired_session then return false;end if;
  raise exception 'stripe_order_close_invalid' using errcode='22023';end if;
 if k.provider<>'stripe' or k.account<>'ktig-consulting' or k.mode<>'test' or k.status<>'awaiting_payment'
  or k.session_id is distinct from expired_session
  or exists(select 1 from sc19_stripe.package_grants g where g.order_id=k.id) then
  raise exception 'stripe_order_close_invalid' using errcode='22023';end if;
 insert into sc19_stripe.order_closures(order_id, company_id, order_source, session_id, reason)
 values (k.id, k.company_id, 'package', k.session_id, 'session_expired');
 update sc19_stripe.package_orders set status='expired' where id=k.id;
 return true;
end;$$;
revoke all on function sc19_stripe.close_expired_order(uuid, text) from public, anon, authenticated;

drop function if exists sc19_stripe.invoice_buyer(uuid);
drop table if exists sc19_stripe.invoice_corrections;
drop table if exists sc19_stripe.refunds;
drop table if exists sc19_stripe.invoices;
drop function if exists sc19_stripe.invoice_guard();

commit;
