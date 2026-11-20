-- R7 (docs/ROADMAP.md): WERYFIKACJA and ASSESSMENT CENTER bought through Stripe
-- Checkout, TEST mode only, on the same SC-019 orchestration as PRESELEKCJA
-- (migration 20261121110000_r7_stripe_checkout.sql, PR #556).
--
-- WHY A SEPARATE ORDER TABLE
-- private.sc19_payment_offers allows plan='PRESELEKCJA' only, and every
-- private.sc19_payment_orders row references such an offer. Widening that check
-- would change the SC-010 erasure schema signature (it covers constraints in
-- public/private) and stop the retention scheduler until a new inventory
-- baseline. So the two packages get their own order, request-alias and receipt
-- tables in the existing schema sc19_stripe, outside public/private, without a
-- foreign key into public/private: the erasure signature stays exactly the same
-- (checked below). Company accounting only, no candidate data.
--
-- PRICES ARE PINNED IN THE TABLE: an order row can only hold one whole package at
-- the price of docs/cennik-2026-11-02.md (WERYFIKACJA 615,00 zł / 60 CV,
-- ASSESSMENT CENTER 1 499,00 zł / 50 CV). Any other amount is refused by a check
-- constraint, so a wrong price can never be paid for, whatever the code sends.
--
-- GRANTING: sc19_stripe.grant_package(order, payment_key) is the only way a paid
-- package is granted. It is called by the orchestration inside the same
-- transaction that marks the order paid (after a signed checkout.session.completed
-- re-read from the Stripe API), once per payment key, and it:
--  * records the receipt (sc19_stripe.package_grants, unique payment key; a key
--    already used for a PRESELEKCJA order is refused);
--  * adds the package's CV analyses to private.sc19_balances with a
--    private.sc19_credit_journal row (same reference format as the PRESELEKCJA
--    grant, unique, so one payment can never grant twice across both paths);
--  * adds 1 to sc19_commerce.entitlements(company, 'package:<code>') — the row the
--    R3 gate private.ac_package_required() reads, so a company that paid for
--    ASSESSMENT CENTER can create and open a finalist session.
-- Skill-test units are NOT granted: the number of tests in WERYFIKACJA is not in
-- the price list, and test metering (sc19_commerce.settings.skill_test_metering)
-- stays off, so tests are not limited by the package today.
--
-- Roles: the payment adapter's existing restricted logins (sc19_p24_preview on
-- skillcheck-preview, sc19_p24_checkout on production; each only where it exists)
-- may create, read and settle TEST-mode Stripe orders of the KTIG account only.
-- Nothing is granted to anon/authenticated. Nothing here publishes an offer, sets
-- a price outside the price list, stores a key or switches sales on (that stays
-- SC19_PACKAGES_ENABLED, default off).
--
-- Code compatibility: the application code shipped with this change works on the
-- pre-migration schema: without sc19_stripe.package_orders it offers only
-- PRESELEKCJA, exactly as before. Production: applied only through
-- db-migrate-production after the owner's approval.
-- Rollback: supabase/rollbacks/20261121130000_r7_stripe_packages_down.sql.
begin;

do $preflight$
begin
 if to_regnamespace('sc19_stripe') is null or to_regclass('sc19_commerce.entitlements') is null
  or to_regclass('private.sc19_credit_journal') is null or to_regclass('private.sc19_balances') is null
  or to_regclass('private.sc19_payment_grants') is null then
  raise exception 'r7_stripe_packages_requires_r7_checkout_and_catalog_orders' using errcode='55000';end if;
 if to_regclass('sc19_stripe.package_orders') is not null then
  raise exception 'r7_stripe_packages_already_installed' using errcode='55000';end if;
 perform set_config('r7_stripe_packages.signature_before', private.erasure_schema_signature(), true);
end $preflight$;

create table sc19_stripe.package_orders (
 id uuid primary key,
 company_id uuid not null,
 buyer_id uuid not null,
 request_id uuid not null,
 package_code text not null,
 offer_id text not null check (length(offer_id) between 1 and 160),
 offer_revision text not null check (length(offer_revision) between 1 and 160),
 terms_revision text not null check (length(terms_revision) between 1 and 160),
 amount_minor integer not null,
 currency text not null check (currency='PLN'),
 credits integer not null,
 provider text not null check (provider='stripe'),
 account text not null check (account='ktig-consulting'),
 mode text not null check (mode in ('test','live')),
 status text not null check (status in ('awaiting_payment','paid')),
 session_id text,
 checkout_url text,
 payment_id text,
 checkout_deadline_ms bigint not null check (checkout_deadline_ms > 0),
 created_at timestamptz not null default now(),
 -- docs/cennik-2026-11-02.md, one whole package per order.
 constraint package_orders_price_list check (
  (package_code='WERYFIKACJA' and amount_minor=61500 and credits=60)
  or (package_code='ASSESSMENT_CENTER' and amount_minor=149900 and credits=50)),
 unique (company_id, request_id),
 unique (company_id, id),
 unique (provider, account, mode, session_id),
 check ((session_id is null) = (checkout_url is null)),
 check ((status='paid') = (payment_id is not null)),
 check (status<>'paid' or session_id is not null)
);
-- One unresolved package purchase per company (the orchestration also refuses a
-- package while a PRESELEKCJA order or a catalog order is unresolved).
create unique index package_one_unresolved on sc19_stripe.package_orders(company_id)
 where status='awaiting_payment';

create table sc19_stripe.package_requests (
 company_id uuid not null,
 request_id uuid not null,
 order_id uuid not null,
 created_at timestamptz not null default now(),
 primary key (company_id, request_id),
 foreign key (company_id, order_id) references sc19_stripe.package_orders(company_id, id) on delete restrict
);

create table sc19_stripe.package_grants (
 payment_key text primary key check (length(payment_key) between 1 and 1024),
 order_id uuid not null unique references sc19_stripe.package_orders(id) on delete restrict,
 created_at timestamptz not null default now()
);

alter table sc19_stripe.package_orders enable row level security;
alter table sc19_stripe.package_requests enable row level security;
alter table sc19_stripe.package_grants enable row level security;
revoke all on sc19_stripe.package_orders, sc19_stripe.package_requests, sc19_stripe.package_grants
 from public, anon, authenticated;

-- Same rules as private.sc19_payment_immutable for the PRESELEKCJA tables: an
-- order binds one session once and becomes paid once; aliases and receipts never
-- change; nothing is deleted.
-- Security definer only so the receipt check below can read package_grants, which
-- the adapter roles cannot read directly.
create function sc19_stripe.package_immutable() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='DELETE' or tg_table_name in ('package_requests','package_grants') then
  raise exception 'sc19_stripe_package_immutable' using errcode='55000';end if;
 if (to_jsonb(new)-array['status','session_id','checkout_url','payment_id'])
     is distinct from (to_jsonb(old)-array['status','session_id','checkout_url','payment_id'])
  or (old.session_id is not null and (new.session_id is distinct from old.session_id
      or new.checkout_url is distinct from old.checkout_url))
  or (old.status='paid' and to_jsonb(new) is distinct from to_jsonb(old))
  or (old.status='awaiting_payment' and new.status='paid' and not exists(
      select 1 from sc19_stripe.package_grants g where g.order_id=new.id)) then
  raise exception 'sc19_stripe_package_immutable' using errcode='55000';end if;
 return new;
end;$$;
revoke all on function sc19_stripe.package_immutable() from public, anon, authenticated;
create trigger package_order_immutable before update or delete on sc19_stripe.package_orders
 for each row execute function sc19_stripe.package_immutable();
create trigger package_request_immutable before update or delete on sc19_stripe.package_requests
 for each row execute function sc19_stripe.package_immutable();
create trigger package_grant_immutable before update or delete on sc19_stripe.package_grants
 for each row execute function sc19_stripe.package_immutable();

-- The ONE grant path for a paid package. Returns NULL when this call granted it,
-- or the order id that already holds this payment key (the caller refuses a key
-- reused for another order). Test mode only.
create function sc19_stripe.grant_package(target_order uuid, payment_key text) returns uuid
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

do $roles$
declare r text;
begin
 foreach r in array array['sc19_p24_preview','sc19_p24_checkout'] loop
  continue when not exists(select 1 from pg_roles where rolname=r);
  execute format('grant usage on schema sc19_stripe to %I', r);
  execute format('grant select, insert, update(status, session_id, checkout_url, payment_id) on sc19_stripe.package_orders to %I', r);
  execute format('grant select, insert on sc19_stripe.package_requests to %I', r);
  execute format('grant execute on function sc19_stripe.grant_package(uuid, text) to %I', r);
  execute format($p$create policy %I on sc19_stripe.package_orders to %I
   using (mode = 'test' and provider = 'stripe' and account = 'ktig-consulting')
   with check (mode = 'test' and provider = 'stripe' and account = 'ktig-consulting')$p$, 'stripe_package_orders_'||r, r);
  execute format($p$create policy %I on sc19_stripe.package_requests to %I
   using (exists(select 1 from sc19_stripe.package_orders o where o.id = package_requests.order_id and o.company_id = package_requests.company_id))
   with check (exists(select 1 from sc19_stripe.package_orders o where o.id = package_requests.order_id and o.company_id = package_requests.company_id))$p$,
   'stripe_package_requests_'||r, r);
 end loop;
end $roles$;

do $postflight$
begin
 if private.erasure_schema_signature() is distinct from current_setting('r7_stripe_packages.signature_before') then
  raise exception 'r7_stripe_packages_changed_erasure_schema' using errcode='55000';end if;
end $postflight$;

commit;
