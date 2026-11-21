-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback R7 live Stripe orders (20261122100000_r7_stripe_live_orders.sql).
-- Restores TEST-mode-only access for the payment adapter roles: the policies of
-- 20261121110000 / 20261121150000 and the function bodies of 20261121110000
-- (replace_customer), 20261121150000 (grant_package) and 20261121180000
-- (close_expired_order, buyer); drops the restrictive receipt-scope policy.
-- Refuses while any LIVE order or LIVE customer exists: those are accounting records
-- and are never changed or deleted by a rollback. Run with `psql -v ON_ERROR_STOP=1`.
begin;

do $guard$
begin
 if exists(select 1 from private.sc19_payment_orders where provider='stripe' and mode='live')
  or exists(select 1 from sc19_stripe.package_orders where mode='live')
  or exists(select 1 from sc19_stripe.customers where mode='live') then
  raise exception 'r7_stripe_live_orders_rollback_refused_live_records_exist' using errcode='55000';end if;
end $guard$;

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

create or replace function sc19_stripe.grant_package(target_order uuid, payment_key text) returns uuid
language plpgsql volatile security definer set search_path='' as $$
declare o sc19_stripe.package_orders; prior uuid; ref text;
begin
 if payment_key is null or length(payment_key) not between 1 and 1024 then
  raise exception 'stripe_package_grant_invalid' using errcode='22023';end if;
 select * into o from sc19_stripe.package_orders where id=target_order for update;
 if not found or o.mode<>'test' or o.status<>'awaiting_payment' or o.session_id is null then
  raise exception 'stripe_package_grant_invalid' using errcode='22023';end if;
 select g.order_id into prior from sc19_stripe.package_grants g where g.payment_key=grant_package.payment_key;
 if prior is not null then return prior;end if;
 if exists(select 1 from private.sc19_payment_grants g where g.payment_key=grant_package.payment_key) then
  raise exception 'stripe_package_receipt_reused' using errcode='23505';end if;
 insert into sc19_stripe.package_grants(payment_key, order_id) values (grant_package.payment_key, o.id);
 -- Same reference as the PRESELEKCJA grant (lib/sc19-payment-postgres.ts): the
 -- journal's unique reference makes one payment grant at most once across both.
 ref:='settlement:sc19:'||encode(sha256(convert_to(grant_package.payment_key,'UTF8')),'hex');
 insert into private.sc19_credit_journal(company_id, reason, delta, reference)
 values (o.company_id, 'paid_grant', o.credits, ref);
 insert into private.sc19_balances(company_id, plan, available) values (o.company_id, 'PRESELEKCJA', o.credits)
 on conflict (company_id) do update set plan='PRESELEKCJA',
  available=private.sc19_balances.available+excluded.available, updated_at=now();
 insert into sc19_commerce.entitlements(company_id, code, available) values (o.company_id, 'package:'||o.package_code, 1)
 on conflict (company_id, code) do update set available=sc19_commerce.entitlements.available+1;
 return null;
end;$$;
revoke all on function sc19_stripe.grant_package(uuid, text) from public, anon, authenticated;
comment on function sc19_stripe.grant_package(uuid, text) is null;

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

create or replace function sc19_stripe.buyer(target_company uuid)
returns table(company_name text, nip text)
language sql stable security definer set search_path='' as $$
 select c.name, a.nip from public.companies c
 left join private.sc19_trial_approvals a on a.company_id=c.id
 where c.id=target_company and (
  exists(select 1 from private.sc19_payment_orders o
   where o.company_id=target_company and o.provider='stripe' and o.status='awaiting_payment'
    and o.checkout_url is distinct from 'sc19:expired')
  or exists(select 1 from sc19_stripe.package_orders p
   where p.company_id=target_company and p.provider='stripe' and p.mode='test' and p.status='awaiting_payment'))
$$;
revoke all on function sc19_stripe.buyer(uuid) from public, anon, authenticated;

do $roles$
declare r text;
begin
 foreach r in array array['sc19_p24_preview','sc19_p24_checkout'] loop
  continue when not exists(select 1 from pg_roles where rolname=r);
  execute format('drop policy if exists %I on private.sc19_payment_grants', 'stripe_receipt_scope_'||r);
  execute format('drop policy if exists %I on sc19_stripe.customers', 'stripe_customers_read_'||r);
  execute format('drop policy if exists %I on sc19_stripe.customers', 'stripe_customers_add_'||r);
  execute format('create policy %I on sc19_stripe.customers for select to %I using (mode = %L)', 'stripe_customers_read_'||r, r, 'test');
  execute format('create policy %I on sc19_stripe.customers for insert to %I with check (mode = %L)', 'stripe_customers_add_'||r, r, 'test');
  execute format('drop policy if exists %I on private.sc19_payment_orders', 'stripe_checkout_orders_'||r);
  execute format($p$create policy %I on private.sc19_payment_orders to %I
   using (mode = 'test' and provider = 'stripe' and account = 'ktig-consulting')
   with check (mode = 'test' and provider = 'stripe' and account = 'ktig-consulting')$p$, 'stripe_checkout_orders_'||r, r);
  execute format('drop policy if exists %I on sc19_stripe.package_orders', 'stripe_package_orders_'||r);
  execute format($p$create policy %I on sc19_stripe.package_orders to %I
   using (mode = 'test' and provider = 'stripe' and account = 'ktig-consulting')
   with check (mode = 'test' and provider = 'stripe' and account = 'ktig-consulting')$p$, 'stripe_package_orders_'||r, r);
 end loop;
end $roles$;

commit;
