-- R7 (docs/ROADMAP.md, „Prawdziwe płatności Stripe (konto KTIG)…”; owner decision
-- 20.11.2026, 18:29, point 5, docs/DECYZJE.md): the payment adapter's restricted
-- roles may create, read, settle and close LIVE-mode Stripe orders of the KTIG
-- account, exactly like TEST-mode ones, so that real payments work once the owner
-- enters live keys. Until now every R7 policy and function accepted mode='test'
-- only (20261121110000, 20261121150000, 20261121180000).
--
-- WHAT CHANGES (for sc19_p24_preview / sc19_p24_checkout, each only where it exists)
--  * Policies, dropped and recreated under the SAME names with mode in
--    ('test','live'); provider='stripe' and account='ktig-consulting' unchanged:
--    stripe_customers_read_<role>, stripe_customers_add_<role> (sc19_stripe.customers),
--    stripe_checkout_orders_<role> (private.sc19_payment_orders),
--    stripe_package_orders_<role> (sc19_stripe.package_orders).
--  * Functions, create or replace (same signatures, owner, grants, security
--    definer, empty search_path), bodies identical to the latest definition except:
--    - sc19_stripe.replace_customer: target_mode 'test' or 'live';
--    - sc19_stripe.grant_package: a 'live' order is granted like a 'test' one, and
--      ONLY with a payment key of the order's own provider, account and mode (see
--      CROSS-SETTLEMENT below);
--    - sc19_stripe.close_expired_order: closes a 'live' order like a 'test' one;
--    - sc19_stripe.buyer: an unpaid 'live' package order counts like a 'test' one.
--  * New RESTRICTIVE insert policy stripe_receipt_scope_<role> on
--    private.sc19_payment_grants (PRESELEKCJA receipts): see below.
--
-- CROSS-SETTLEMENT: a live order and a test order can never settle each other.
--  1. Application: every Stripe call, event and session is checked for livemode
--     against the key's mode, and the orchestration refuses an order whose
--     provider/account/mode differs from the configured scope
--     (SC19_PAYMENT_SCOPE_MISMATCH) before any grant.
--  2. Database (new here): the receipt key the orchestration writes is
--     JSON.stringify([provider, account, mode, paymentId]) (lib/sc19-payments.ts).
--     grant_package and the restrictive receipt policy accept a key only when it
--     starts with the ORDER's own ["provider","account","mode", — so a payment
--     verified under the test key cannot grant a live order, and the reverse.
--
-- What does NOT change: prices (the price-list check constraint is untouched),
-- the one-unresolved-purchase rule, tables, columns, constraints, triggers, grants,
-- roles, the catalog order guard, the cost report and the voice pool (both read paid
-- orders without any mode filter, so a live purchase counts exactly like a test one).
-- No row is changed or deleted. Nothing for anon / authenticated / public. The
-- SC-010 erasure schema signature stays the same (policies and function bodies are
-- not part of it; checked in the postflight). No candidate data.
--
-- Preview never takes real money: the application refuses a live key on Preview
-- (lib/sc19-stripe-config.ts, live_key_on_preview) and opens live checkouts only on
-- the production deployment (stripeLiveApproved).
--
-- Code compatibility: the application code shipped with this change works on the
-- pre-migration schema: TEST mode is unchanged; with a live key on production a new
-- live order is refused by the old policies (row-level security → SC19_PAYMENT_RETRY)
-- BEFORE any Stripe session is created, so nothing can be charged.
-- Production: applied only through db-migrate-production after the owner's approval.
-- Rollback: supabase/rollbacks/20261122100000_r7_stripe_live_orders_down.sql
-- (refused while any live order or live customer exists: accounting records).
begin;

do $preflight$
begin
 if to_regclass('sc19_stripe.package_orders') is null or to_regclass('sc19_stripe.order_closures') is null
  or to_regclass('sc19_stripe.customers') is null or to_regclass('private.sc19_payment_grants') is null
  or to_regprocedure('sc19_stripe.grant_package(uuid,text)') is null
  or to_regprocedure('sc19_stripe.close_expired_order(uuid,text)') is null
  or to_regprocedure('sc19_stripe.replace_customer(uuid,text,text,text)') is null
  or to_regprocedure('sc19_stripe.buyer(uuid)') is null then
  raise exception 'r7_stripe_live_orders_requires_r7_expired_session' using errcode='55000';end if;
 if pg_catalog.obj_description('sc19_stripe.grant_package(uuid,text)'::regprocedure, 'pg_proc') = 'r7_stripe_live_orders' then
  raise exception 'r7_stripe_live_orders_already_installed' using errcode='55000';end if;
 perform set_config('r7_stripe_live.signature_before', private.erasure_schema_signature(), true);
end $preflight$;

-- Body of 20261121110000 with target_mode 'test' or 'live'.
create or replace function sc19_stripe.replace_customer(target_company uuid, target_mode text, stale_id text, fresh_id text)
returns text language plpgsql volatile security definer set search_path='' as $$
declare stored text;
begin
 if target_mode is null or target_mode not in ('test','live') or fresh_id !~ '^cus_[A-Za-z0-9]{6,64}$' then
  raise exception 'stripe_customer_invalid' using errcode='22023';end if;
 update sc19_stripe.customers set customer_id=fresh_id
  where company_id=target_company and mode=target_mode and customer_id=stale_id;
 select customer_id into stored from sc19_stripe.customers where company_id=target_company and mode=target_mode;
 return stored;
end;$$;
revoke all on function sc19_stripe.replace_customer(uuid,text,text,text) from public, anon, authenticated;

-- Body of 20261121150000 with mode 'test' or 'live' and the receipt-key scope check.
create or replace function sc19_stripe.grant_package(target_order uuid, payment_key text) returns uuid
language plpgsql volatile security definer set search_path='' as $$
declare o sc19_stripe.package_orders; prior uuid; ref text;
begin
 if payment_key is null or length(payment_key) not between 1 and 1024 then
  raise exception 'stripe_package_grant_invalid' using errcode='22023';end if;
 select * into o from sc19_stripe.package_orders where id=target_order for update;
 if not found or o.mode not in ('test','live') or o.status<>'awaiting_payment' or o.session_id is null
  -- R7 live: the receipt key must carry the order's own provider, account and mode.
  or not starts_with(grant_package.payment_key, '["'||o.provider||'","'||o.account||'","'||o.mode||'",') then
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
-- Marker for the preflight above (this migration is not re-runnable).
comment on function sc19_stripe.grant_package(uuid, text) is 'r7_stripe_live_orders';

-- Body of 20261121180000 with mode 'test' or 'live'.
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
  if p.provider<>'stripe' or p.account<>'ktig-consulting' or p.mode not in ('test','live') or p.status<>'awaiting_payment'
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
 if k.provider<>'stripe' or k.account<>'ktig-consulting' or k.mode not in ('test','live') or k.status<>'awaiting_payment'
  or k.session_id is distinct from expired_session
  or exists(select 1 from sc19_stripe.package_grants g where g.order_id=k.id) then
  raise exception 'stripe_order_close_invalid' using errcode='22023';end if;
 insert into sc19_stripe.order_closures(order_id, company_id, order_source, session_id, reason)
 values (k.id, k.company_id, 'package', k.session_id, 'session_expired');
 update sc19_stripe.package_orders set status='expired' where id=k.id;
 return true;
end;$$;
revoke all on function sc19_stripe.close_expired_order(uuid, text) from public, anon, authenticated;

-- Body of 20261121180000 with an unpaid 'live' package order counting too.
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
   where p.company_id=target_company and p.provider='stripe' and p.mode in ('test','live') and p.status='awaiting_payment'))
$$;
revoke all on function sc19_stripe.buyer(uuid) from public, anon, authenticated;

do $roles$
declare r text;
begin
 foreach r in array array['sc19_p24_preview','sc19_p24_checkout'] loop
  continue when not exists(select 1 from pg_roles where rolname=r);
  execute format('drop policy if exists %I on sc19_stripe.customers', 'stripe_customers_read_'||r);
  execute format('drop policy if exists %I on sc19_stripe.customers', 'stripe_customers_add_'||r);
  execute format($p$create policy %I on sc19_stripe.customers for select to %I using (mode in ('test','live'))$p$,
   'stripe_customers_read_'||r, r);
  execute format($p$create policy %I on sc19_stripe.customers for insert to %I with check (mode in ('test','live'))$p$,
   'stripe_customers_add_'||r, r);
  execute format('drop policy if exists %I on private.sc19_payment_orders', 'stripe_checkout_orders_'||r);
  execute format($p$create policy %I on private.sc19_payment_orders to %I
   using (mode in ('test','live') and provider = 'stripe' and account = 'ktig-consulting')
   with check (mode in ('test','live') and provider = 'stripe' and account = 'ktig-consulting')$p$, 'stripe_checkout_orders_'||r, r);
  execute format('drop policy if exists %I on sc19_stripe.package_orders', 'stripe_package_orders_'||r);
  execute format($p$create policy %I on sc19_stripe.package_orders to %I
   using (mode in ('test','live') and provider = 'stripe' and account = 'ktig-consulting')
   with check (mode in ('test','live') and provider = 'stripe' and account = 'ktig-consulting')$p$, 'stripe_package_orders_'||r, r);
  -- PRESELEKCJA receipts: the key must carry the order's own provider, account and mode.
  execute format('drop policy if exists %I on private.sc19_payment_grants', 'stripe_receipt_scope_'||r);
  execute format($p$create policy %I on private.sc19_payment_grants as restrictive for insert to %I
   with check (exists(select 1 from private.sc19_payment_orders o where o.id = order_id
    and starts_with(payment_key, '["'||o.provider||'","'||o.account||'","'||o.mode||'",')))$p$, 'stripe_receipt_scope_'||r, r);
 end loop;
end $roles$;

do $postflight$
begin
 if private.erasure_schema_signature() is distinct from current_setting('r7_stripe_live.signature_before') then
  raise exception 'r7_stripe_live_orders_changed_erasure_schema' using errcode='55000';end if;
end $postflight$;

commit;
