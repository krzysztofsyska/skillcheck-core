-- SC-CHECKOUT-P24-001: public online checkout (Przelewy24) for the PRESELEKCJA offer.
-- Guest buyers, no account. Data lives in the dedicated schema "checkout":
--   * buyers are not candidates: these rows are outside the SC-010 candidate
--     erasure inventory, whose schema signature tracks only "public"/"private"
--     relations (private.erasure_schema_signature), so adding them must not
--     block candidate erasure previews/purges (schema_dependency_unknown/PT409);
--   * the schema is not exposed by the Data API and has no grants at all.
-- The Next.js server calls SECURITY DEFINER RPCs in "public", each authenticated
-- by an HMAC-SHA256 over a canonical request built with a server-only secret
-- (Vercel env CHECKOUT_ORDER_SECRET, mirrored in checkout.settings).
-- Without an installed secret every RPC refuses (fail closed).
-- Buyer-data retention (accounting/consumer law) is handled by the operator,
-- not by the candidate erasure engine.
begin;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname='extensions' and p.proname='hmac'
    and pg_catalog.pg_get_function_identity_arguments(p.oid)='text, text, text') then
    raise exception 'checkout_pgcrypto_hmac';
  end if;
end $$;

create schema checkout;
revoke all on schema checkout from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'revoke all on schema checkout from service_role';
  end if;
end $$;

create table checkout.orders (
  id uuid primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','paid','failed','cancelled')),
  product_code text not null check (product_code ~ '^[a-z0-9-]{1,40}$'),
  quantity integer not null check (quantity between 1 and 10),
  amount_gross integer not null check (amount_gross between 100 and 10000000),
  currency text not null default 'PLN' check (currency = 'PLN'),
  customer_name text not null check (char_length(customer_name) between 2 and 120),
  customer_email text not null check (char_length(customer_email) between 3 and 254 and customer_email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  customer_phone text not null check (customer_phone ~ '^[0-9+() -]{6,32}$'),
  company_name text check (company_name is null or char_length(company_name) between 2 and 200),
  nip text check (nip is null or nip ~ '^[0-9]{10}$'),
  terms_accepted_at timestamptz not null,
  p24_session_id text not null unique check (p24_session_id = 'sc-ord-' || id::text),
  p24_order_id bigint unique check (p24_order_id is null or p24_order_id > 0),
  paid_at timestamptz,
  -- Last reconciliation attempt; rotates the reconcile queue so unsettled rows cannot starve later ones.
  reconciled_at timestamptz,
  check ((status = 'paid') = (paid_at is not null)),
  check (status <> 'paid' or p24_order_id is not null)
);
create index orders_email_time on checkout.orders (lower(customer_email), created_at);
alter table checkout.orders enable row level security;
revoke all on checkout.orders from public, anon, authenticated;

create table checkout.settings (
  id boolean primary key default true check (id),
  request_secret text check (request_secret is null or octet_length(request_secret) >= 32)
);
insert into checkout.settings(id) values (true);
alter table checkout.settings enable row level security;
revoke all on checkout.settings from public, anon, authenticated;
do $$ begin
  -- Old Supabase defaults grant this BYPASSRLS role table CRUD; both tables are RPC-only.
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'revoke all on table checkout.orders, checkout.settings from service_role';
  end if;
end $$;

-- Owner/operator installs (or rotates) the secret with the SQL editor; never from the app.
create function checkout.set_request_secret(new_secret text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if new_secret is null or octet_length(new_secret) < 32 then raise exception 'checkout_secret_invalid'; end if;
  update checkout.settings set request_secret = new_secret where id;
end $$;
revoke all on function checkout.set_request_secret(text) from public, anon, authenticated;

-- Length-prefixed field; NULL is '-' so it can never collide with any string value.
create function checkout.field(value text) returns text
language sql immutable set search_path = '' as $$
  select case when value is null then '-' else pg_catalog.octet_length(value)::text || ':' || value end
$$;
revoke all on function checkout.field(text) from public, anon, authenticated;

-- Same canonical form as lib/checkout-orders.ts checkoutCanonical().
create function checkout.authenticate(action text, issued_at_us bigint, fields text[], signature text) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  secret text;
  canonical text;
  now_us bigint := (extract(epoch from pg_catalog.clock_timestamp()) * 1000000)::bigint;
begin
  select s.request_secret into secret from checkout.settings s where s.id;
  if secret is null then raise exception 'checkout_disabled'; end if;
  if issued_at_us is null or issued_at_us < now_us - 300000000 or issued_at_us > now_us + 60000000 then
    raise exception 'checkout_request_expired';
  end if;
  canonical := 'v1' || chr(10) || action || chr(10) || issued_at_us::text || chr(10) ||
    pg_catalog.array_to_string(array(select checkout.field(f) from pg_catalog.unnest(fields) with ordinality u(f, n) order by n), chr(10));
  if signature is null or signature !~ '^[0-9a-f]{64}$' or
     pg_catalog.encode(extensions.hmac(canonical, secret, 'sha256'), 'hex') <> signature then
    raise exception 'checkout_unauthenticated';
  end if;
end $$;
revoke all on function checkout.authenticate(text, bigint, text[], text) from public, anon, authenticated;

create function public.checkout_create_order(
  order_id uuid, product_code text, quantity integer, amount_gross integer,
  customer_name text, customer_email text, customer_phone text, company_name text, nip text,
  issued_at_us bigint, request_signature text
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  existing checkout.orders%rowtype;
  session_id text := 'sc-ord-' || order_id::text;
begin
  perform checkout.authenticate('create', issued_at_us, array[order_id::text, product_code, quantity::text,
    amount_gross::text, customer_name, customer_email, customer_phone, company_name, nip], request_signature);
  select * into existing from checkout.orders o where o.id = order_id;
  if found then
    -- Idempotent retry of the very same signed request only.
    if existing.product_code = product_code and existing.quantity = quantity and existing.amount_gross = amount_gross
       and existing.customer_email = customer_email and existing.status = 'pending' then
      return existing.p24_session_id;
    end if;
    raise exception 'checkout_order_conflict';
  end if;
  if (select count(*) from checkout.orders o where lower(o.customer_email) = lower(checkout_create_order.customer_email)
      and o.created_at > now() - interval '1 hour') >= 10 then
    raise exception 'checkout_rate_limited';
  end if;
  insert into checkout.orders (id, product_code, quantity, amount_gross, customer_name, customer_email,
    customer_phone, company_name, nip, terms_accepted_at, p24_session_id)
  values (order_id, product_code, quantity, amount_gross, customer_name, customer_email,
    customer_phone, company_name, nip, now(), session_id);
  return session_id;
end $$;

create function public.checkout_update_order(
  order_id uuid, new_status text, p24_order_id bigint, paid_amount integer,
  issued_at_us bigint, request_signature text
) returns text
language plpgsql security definer set search_path = '' as $$
declare o checkout.orders%rowtype;
begin
  perform checkout.authenticate('update', issued_at_us, array[order_id::text, new_status,
    p24_order_id::text, paid_amount::text], request_signature);
  if new_status not in ('paid', 'failed', 'cancelled') then raise exception 'checkout_status_invalid'; end if;
  select * into o from checkout.orders x where x.id = order_id for update;
  if not found then raise exception 'checkout_order_missing'; end if;
  if o.p24_order_id is not null and p24_order_id is not null and o.p24_order_id <> p24_order_id then
    raise exception 'checkout_p24_order_mismatch';
  end if;
  -- Paid is terminal; a late confirmed payment may still settle a failed/cancelled order.
  if o.status = 'paid' or o.status = new_status then return o.status; end if;
  if new_status = 'paid' then
    if p24_order_id is null or paid_amount is distinct from o.amount_gross then raise exception 'checkout_amount_mismatch'; end if;
    update checkout.orders x set status = 'paid', paid_at = now(), updated_at = now(),
      p24_order_id = checkout_update_order.p24_order_id where x.id = order_id;
  else
    if o.status <> 'pending' then return o.status; end if;
    update checkout.orders x set status = new_status, updated_at = now(),
      p24_order_id = coalesce(x.p24_order_id, checkout_update_order.p24_order_id) where x.id = order_id;
  end if;
  return new_status;
end $$;

create function public.checkout_read_order(order_id uuid, issued_at_us bigint, request_signature text)
returns table (status text, product_code text, quantity integer, amount_gross integer, currency text,
  customer_email text, p24_session_id text, p24_order_id bigint)
language plpgsql security definer set search_path = '' as $$
begin
  perform checkout.authenticate('read', issued_at_us, array[order_id::text], request_signature);
  return query select o.status, o.product_code, o.quantity, o.amount_gross, o.currency, o.customer_email,
    o.p24_session_id, o.p24_order_id from checkout.orders o where o.id = order_id;
end $$;

-- Reconciliation feed: claims a batch of recent unpaid orders (ids only), least recently
-- checked first, and stamps reconciled_at so the next batch moves on to other rows.
create function public.checkout_pending_orders(older_than_seconds integer, max_rows integer, issued_at_us bigint, request_signature text)
returns table (order_id uuid)
language plpgsql security definer set search_path = '' as $$
begin
  perform checkout.authenticate('pending', issued_at_us, array[older_than_seconds::text, max_rows::text], request_signature);
  if older_than_seconds is null or older_than_seconds < 0 or max_rows is null or max_rows not between 1 and 50 then
    raise exception 'checkout_invalid';
  end if;
  return query
    with batch as (
      select o.id from checkout.orders o
      where o.status in ('pending', 'failed')
        and o.created_at < now() - pg_catalog.make_interval(secs => older_than_seconds)
        and o.created_at > now() - interval '3 days'
      order by o.reconciled_at nulls first, o.created_at
      limit max_rows
      for update skip locked)
    update checkout.orders o set reconciled_at = now() from batch where o.id = batch.id
    returning o.id;
end $$;

revoke all on function public.checkout_create_order(uuid, text, integer, integer, text, text, text, text, text, bigint, text) from public, anon, authenticated;
revoke all on function public.checkout_update_order(uuid, text, bigint, integer, bigint, text) from public, anon, authenticated;
revoke all on function public.checkout_read_order(uuid, bigint, text) from public, anon, authenticated;
revoke all on function public.checkout_pending_orders(integer, integer, bigint, text) from public, anon, authenticated;
grant execute on function public.checkout_create_order(uuid, text, integer, integer, text, text, text, text, text, bigint, text) to anon, authenticated;
grant execute on function public.checkout_update_order(uuid, text, bigint, integer, bigint, text) to anon, authenticated;
grant execute on function public.checkout_read_order(uuid, bigint, text) to anon, authenticated;
grant execute on function public.checkout_pending_orders(integer, integer, bigint, text) to anon, authenticated;

commit;
