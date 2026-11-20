-- R7 (docs/ROADMAP.md, step 2): Stripe Checkout for PRESELEKCJA on the existing
-- SC-019 payment orchestration (lib/sc19-payments.ts, lib/sc19-stripe-*.ts).
--
-- ADDITIVE ONLY. One new schema with one table and one function, plus grants and
-- NEW policies for the payment adapter's existing restricted roles
-- (sc19_p24_preview on skillcheck-preview, sc19_p24_checkout on production; each
-- only where it exists). No existing table, column, constraint, trigger, policy,
-- function body or row is changed or removed. The new schema is outside
-- public/private, so the SC-010 erasure schema signature stays exactly the same
-- (checked below).
--
--  * sc19_stripe.customers — one Stripe customer per company and mode, so a
--    company is never duplicated in Stripe. Company accounting only, no candidate
--    data. No foreign key (keeps the erasure inventory untouched).
--  * sc19_stripe.buyer(company) — company name and NIP for the Stripe checkout
--    form, and ONLY for a company that currently has an unpaid Stripe order. The
--    roles still have no direct access to the nip column.
--  * policy stripe_checkout_orders on private.sc19_payment_orders — the roles may
--    create, read and settle Stripe orders of the KTIG account in TEST mode only.
--    A LIVE order can be neither created nor read nor settled through these roles;
--    opening live payments needs a separate migration after the owner's decision.
--
-- Nothing here publishes an offer, grants credits, sets a price, stores a key or
-- switches a provider on. Production: applied only through db-migrate-production
-- after the owner's approval. Code compatibility: without this migration the
-- Stripe checkout fails closed (permission denied → SC19_PAYMENT_RETRY), nothing
-- else changes. Rollback: supabase/rollbacks/20261121110000_r7_stripe_checkout_down.sql.
begin;

do $preflight$
begin
 if to_regclass('public.companies') is null or to_regclass('private.sc19_trial_approvals') is null
  or to_regclass('private.sc19_payment_orders') is null then
  raise exception 'r7_stripe_checkout_requires_sc19_payments' using errcode='55000';end if;
 if to_regnamespace('sc19_stripe') is not null then
  raise exception 'r7_stripe_checkout_already_installed' using errcode='55000';end if;
 perform set_config('r7_stripe_checkout.signature_before', private.erasure_schema_signature(), true);
end $preflight$;

create schema sc19_stripe;
revoke all on schema sc19_stripe from public, anon, authenticated;

create table sc19_stripe.customers (
 company_id uuid not null,
 mode text not null check (mode in ('test','live')),
 customer_id text not null unique check (customer_id ~ '^cus_[A-Za-z0-9]{6,64}$'),
 created_at timestamptz not null default now(),
 primary key (company_id, mode)
);
alter table sc19_stripe.customers enable row level security;
revoke all on sc19_stripe.customers from public, anon, authenticated;

create function sc19_stripe.buyer(target_company uuid)
returns table(company_name text, nip text)
language sql stable security definer set search_path='' as $$
 select c.name, a.nip from public.companies c
 left join private.sc19_trial_approvals a on a.company_id=c.id
 where c.id=target_company and exists(select 1 from private.sc19_payment_orders o
  where o.company_id=target_company and o.provider='stripe' and o.status='awaiting_payment')
$$;
revoke all on function sc19_stripe.buyer(uuid) from public, anon, authenticated;

do $roles$
declare r text;
begin
 foreach r in array array['sc19_p24_preview','sc19_p24_checkout'] loop
  continue when not exists(select 1 from pg_roles where rolname=r);
  execute format('grant usage on schema sc19_stripe to %I', r);
  execute format('grant select, insert on sc19_stripe.customers to %I', r);
  execute format('grant execute on function sc19_stripe.buyer(uuid) to %I', r);
  execute format('create policy %I on sc19_stripe.customers for select to %I using (mode = %L)', 'stripe_customers_read_'||r, r, 'test');
  execute format('create policy %I on sc19_stripe.customers for insert to %I with check (mode = %L)', 'stripe_customers_add_'||r, r, 'test');
  execute format($p$create policy %I on private.sc19_payment_orders to %I
   using (mode = 'test' and provider = 'stripe' and account = 'ktig-consulting')
   with check (mode = 'test' and provider = 'stripe' and account = 'ktig-consulting')$p$, 'stripe_checkout_orders_'||r, r);
 end loop;
end $roles$;

do $postflight$
begin
 if private.erasure_schema_signature() is distinct from current_setting('r7_stripe_checkout.signature_before') then
  raise exception 'r7_stripe_checkout_changed_erasure_schema' using errcode='55000';end if;
end $postflight$;

commit;
