-- R7 (docs/ROADMAP.md, „Prawdziwe płatności Stripe (konto KTIG), faktura VAT z
-- Fakturowni po opłaceniu i faktura korygująca po zwrocie”). Owner decision
-- 20.11.2026, 18:29, point 5 (docs/DECYZJE.md).
--
-- ADDITIVE ONLY. New tables, a new function, a new trigger, NEW policies for the
-- payment adapter's existing restricted roles (sc19_p24_preview on
-- skillcheck-preview, sc19_p24_checkout on production; each only where it exists)
-- and three function bodies redefined with the same signatures, grants, security
-- definer and empty search_path. No table, column, constraint, index, existing
-- policy or row is changed or removed. The new tables are in sc19_stripe, outside
-- public/private, so the SC-010 erasure schema signature stays exactly the same
-- (checked below).
--
-- LIVE PAYMENTS: PRESELEKCJA ONLY.
--  * policy stripe_live_orders_<role> on private.sc19_payment_orders: the roles may
--    also create, read and settle LIVE Stripe PRESELEKCJA orders of the KTIG account.
--    The existing TEST policy stays as it is (policies are permissive, OR-ed).
--  * policies stripe_live_customers_*: one LIVE Stripe customer per company.
--  * sc19_stripe.replace_customer: also for mode 'live'.
--  * sc19_stripe.close_expired_order: the PRESELEKCJA branch also closes a LIVE order;
--    the package branch stays TEST only.
--  WERYFIKACJA and ASSESSMENT CENTER stay TEST only (sc19_stripe.package_orders
--  policies and sc19_stripe.grant_package are unchanged): for real money they are
--  „wkrótce”, not buyable.
--
-- INVOICES (Fakturownia; the application issues them, the database only records):
--  * sc19_stripe.invoices — one row per LIVE paid order: claim/lease state, the
--    Fakturownia document id and number once issued, or 'skipped' for the seller's
--    own control purchase (NIP 7394002294). An issued or skipped row never changes.
--  * sc19_stripe.refunds — the cumulative refunded amount Stripe reported for a
--    LIVE paid order; it can only grow. Its lease lets one correction attempt per
--    order run at a time.
--  * sc19_stripe.invoice_corrections — one correction invoice per order and
--    cumulative refunded total; an issued row never changes.
--  * sc19_stripe.invoice_buyer(order) — company name and NIP for the invoice of a
--    PAID LIVE Stripe order only (the roles still have no direct access to NIP).
--  Nothing here deducts CV analyses: the credit journal has no refund reason, and
--  changing its check constraint is not additive. A refund is recorded; any pool
--  correction is done by the operator.
--
-- Nothing here publishes an offer, grants credits, sets a price, stores a key or
-- switches sales on (that stays SC19_PACKAGES_ENABLED, default off).
--
-- Code compatibility: the code shipped with this change works on the
-- pre-migration schema: a LIVE checkout is refused by the old TEST-only policy
-- (permission denied → SC19_PAYMENT_RETRY, nothing charged: the order row is
-- written before any Stripe session), and the invoice code sees no
-- sc19_stripe.invoices table and does nothing.
-- Production: applied only through db-migrate-production after the owner's approval.
-- Rollback: supabase/rollbacks/20261122090000_r7_stripe_live_invoices_down.sql.
begin;

do $preflight$
begin
 if to_regclass('sc19_stripe.customers') is null or to_regclass('sc19_stripe.package_orders') is null
  or to_regclass('sc19_stripe.order_closures') is null
  or to_regprocedure('sc19_stripe.close_expired_order(uuid,text)') is null then
  raise exception 'r7_stripe_live_invoices_requires_r7_stripe' using errcode='55000';end if;
 if to_regclass('sc19_stripe.invoices') is not null then
  raise exception 'r7_stripe_live_invoices_already_installed' using errcode='55000';end if;
 perform set_config('r7_stripe_live.signature_before', private.erasure_schema_signature(), true);
end $preflight$;

create table sc19_stripe.invoices (
 order_id uuid primary key,
 company_id uuid not null,
 payment_id text not null unique check (payment_id ~ '^pi_[A-Za-z0-9]{6,64}$'),
 mode text not null check (mode = 'live'),
 status text not null default 'new' check (status in ('new','pending','failed','issued','skipped')),
 attempts integer not null default 0 check (attempts >= 0),
 lease_until timestamptz,
 fakturownia_id bigint check (fakturownia_id > 0),
 number text check (length(number) <= 100),
 error_code text check (error_code ~ '^[A-Z0-9_]{1,60}$'),
 payment_method text check (payment_method ~ '^[a-z0-9_]{1,40}$'),
 created_at timestamptz not null default now(),
 changed_at timestamptz not null default now(),
 issued_at timestamptz,
 check ((status = 'issued') = (fakturownia_id is not null))
);
create table sc19_stripe.refunds (
 order_id uuid primary key,
 company_id uuid not null,
 payment_id text not null unique check (payment_id ~ '^pi_[A-Za-z0-9]{6,64}$'),
 refunded_total integer not null check (refunded_total > 0),
 -- One correction attempt per order at a time (a lease on this row).
 lease_until timestamptz,
 updated_at timestamptz not null default now()
);
create table sc19_stripe.invoice_corrections (
 order_id uuid not null references sc19_stripe.invoices(order_id),
 refunded_total integer not null check (refunded_total > 0),
 status text not null default 'pending' check (status in ('pending','failed','issued')),
 attempts integer not null default 0 check (attempts >= 0),
 fakturownia_id bigint check (fakturownia_id > 0),
 number text check (length(number) <= 100),
 error_code text check (error_code ~ '^[A-Z0-9_]{1,60}$'),
 changed_at timestamptz not null default now(),
 issued_at timestamptz,
 primary key (order_id, refunded_total),
 check ((status = 'issued') = (fakturownia_id is not null))
);
alter table sc19_stripe.invoices enable row level security;
alter table sc19_stripe.refunds enable row level security;
alter table sc19_stripe.invoice_corrections enable row level security;
revoke all on sc19_stripe.invoices, sc19_stripe.refunds, sc19_stripe.invoice_corrections from public, anon, authenticated;

-- Accounting records: never deleted; an issued (or skipped) document never changes;
-- identity columns never change; a refunded total never shrinks.
create function sc19_stripe.invoice_guard() returns trigger
language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception 'stripe_invoice_immutable' using errcode='55000';end if;
 if tg_table_name='refunds' then
  if new.order_id<>old.order_id or new.company_id<>old.company_id or new.payment_id<>old.payment_id
   or new.refunded_total<old.refunded_total then
   raise exception 'stripe_invoice_immutable' using errcode='55000';end if;
  return new;
 end if;
 if old.status in ('issued','skipped') and to_jsonb(new) is distinct from to_jsonb(old) then
  raise exception 'stripe_invoice_immutable' using errcode='55000';end if;
 if new.order_id<>old.order_id then raise exception 'stripe_invoice_immutable' using errcode='55000';end if;
 -- Nested IFs: a record field of the other table must never be evaluated.
 if tg_table_name='invoices' then
  if new.company_id<>old.company_id or new.payment_id<>old.payment_id or new.mode<>old.mode then
   raise exception 'stripe_invoice_immutable' using errcode='55000';end if;
 else
  if new.refunded_total<>old.refunded_total then
   raise exception 'stripe_invoice_immutable' using errcode='55000';end if;
 end if;
 return new;
end;$$;
revoke all on function sc19_stripe.invoice_guard() from public, anon, authenticated;
create trigger invoice_guard before update or delete on sc19_stripe.invoices
 for each row execute function sc19_stripe.invoice_guard();
create trigger invoice_guard before update or delete on sc19_stripe.refunds
 for each row execute function sc19_stripe.invoice_guard();
create trigger invoice_guard before update or delete on sc19_stripe.invoice_corrections
 for each row execute function sc19_stripe.invoice_guard();

-- Company name and NIP for the VAT invoice of a PAID LIVE Stripe PRESELEKCJA order.
create function sc19_stripe.invoice_buyer(target_order uuid)
returns table(company_name text, nip text)
language sql stable security definer set search_path='' as $$
 select c.name, a.nip from private.sc19_payment_orders o
 join public.companies c on c.id=o.company_id
 left join private.sc19_trial_approvals a on a.company_id=c.id
 where o.id=target_order and o.provider='stripe' and o.account='ktig-consulting' and o.mode='live' and o.status='paid'
$$;
revoke all on function sc19_stripe.invoice_buyer(uuid) from public, anon, authenticated;

-- LIVE customers too. Otherwise the body of 20261121110000_r7_stripe_checkout.sql.
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

-- The PRESELEKCJA branch also closes a LIVE order. Otherwise the body of
-- 20261121180000_r7_stripe_expired_session.sql (package orders: TEST only).
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

do $roles$
declare r text;
begin
 foreach r in array array['sc19_p24_preview','sc19_p24_checkout'] loop
  continue when not exists(select 1 from pg_roles where rolname=r);
  execute format($p$create policy %I on private.sc19_payment_orders to %I
   using (mode = 'live' and provider = 'stripe' and account = 'ktig-consulting')
   with check (mode = 'live' and provider = 'stripe' and account = 'ktig-consulting')$p$, 'stripe_live_orders_'||r, r);
  execute format('create policy %I on sc19_stripe.customers for select to %I using (mode = %L)', 'stripe_live_customers_read_'||r, r, 'live');
  execute format('create policy %I on sc19_stripe.customers for insert to %I with check (mode = %L)', 'stripe_live_customers_add_'||r, r, 'live');
  execute format('grant select, insert on sc19_stripe.invoices, sc19_stripe.refunds, sc19_stripe.invoice_corrections to %I', r);
  execute format('grant update(status, attempts, lease_until, fakturownia_id, number, error_code, payment_method, changed_at, issued_at) on sc19_stripe.invoices to %I', r);
  execute format('grant update(refunded_total, lease_until, updated_at) on sc19_stripe.refunds to %I', r);
  execute format('grant update(status, attempts, fakturownia_id, number, error_code, changed_at, issued_at) on sc19_stripe.invoice_corrections to %I', r);
  execute format('grant execute on function sc19_stripe.invoice_buyer(uuid) to %I', r);
  execute format('create policy %I on sc19_stripe.invoices to %I using (true) with check (mode = %L)', 'stripe_invoices_'||r, r, 'live');
  execute format('create policy %I on sc19_stripe.refunds to %I using (true) with check (true)', 'stripe_refunds_'||r, r);
  execute format('create policy %I on sc19_stripe.invoice_corrections to %I using (true) with check (true)', 'stripe_invoice_corrections_'||r, r);
 end loop;
end $roles$;

do $postflight$
begin
 if private.erasure_schema_signature() is distinct from current_setting('r7_stripe_live.signature_before') then
  raise exception 'r7_stripe_live_invoices_changed_erasure_schema' using errcode='55000';end if;
end $postflight$;

commit;
