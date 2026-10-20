-- SC-019 A2 additive storage prototype. NOT a deployable migration.
-- Run only in disposable databases against the pinned #92 contract.
-- #92/#115 + SC-010 inventory must pass review before a CLI-generated migration.
begin;
do $$ begin
  if to_regclass('private.sc19_balances') is null
    or to_regclass('private.sc19_credit_journal') is null
    or to_regclass('private.sc19_trial_approvals') is null then
    raise exception 'sc19_credit_contract_missing' using errcode='55000';
  end if;
  -- Never silently invalidate, regenerate or bless an SC-010 erasure baseline.
  -- A follow-on migration must include a reviewed immutable inventory revision.
  if to_regprocedure('private.erasure_schema_signature()') is not null then
    raise exception 'sc19_payment_erasure_revision_required' using errcode='55000';
  end if;
end $$;
create table private.sc19_payment_offers (
  id text primary key,
  revision text not null,
  plan text not null check(plan='PRESELEKCJA'),
  active boolean not null default false,
  approved boolean not null default false,
  amount_minor integer not null check(amount_minor between 1 and 100000000),
  currency text not null check(currency='PLN'),
  credits integer not null check(credits between 1 and 100000),
  terms_revision text not null,
  terms_text text not null check(length(terms_text) between 1 and 20000),
  valid_until_ms bigint not null check(valid_until_ms > 0),
  created_at timestamptz not null default now()
);
-- No seed: neither a price, a quota, nor terms have commercial approval.
create table private.sc19_payment_orders (
  id uuid primary key,
  company_id uuid not null references public.companies(id) on delete restrict,
  buyer_id uuid not null,
  request_id uuid not null,
  offer_id text not null references private.sc19_payment_offers(id) on delete restrict,
  offer_revision text not null,
  terms_revision text not null,
  amount_minor integer not null check(amount_minor between 1 and 100000000),
  currency text not null check(currency='PLN'),
  credits integer not null check(credits between 1 and 100000),
  provider text not null,
  account text not null,
  mode text not null check(mode in ('test','live')),
  status text not null check(status in ('awaiting_payment','paid')),
  session_id text,
  checkout_url text,
  payment_id text,
  checkout_deadline_ms bigint not null check(checkout_deadline_ms > 0),
  created_at timestamptz not null default now(),
  unique(company_id, request_id),
  unique(provider, account, mode, session_id),
  check((session_id is null) = (checkout_url is null)),
  check((status='paid') = (payment_id is not null)),
  check(status<>'paid' or session_id is not null)
);
create index sc19_payment_orders_company_idx on private.sc19_payment_orders(company_id,created_at desc);
create table private.sc19_payment_grants (
  payment_key text primary key check(length(payment_key) between 1 and 1024),
  order_id uuid not null unique references private.sc19_payment_orders(id) on delete restrict,
  created_at timestamptz not null default now()
);
create function private.sc19_payment_immutable()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' or tg_table_name='sc19_payment_grants' then raise exception 'sc19_payment_immutable' using errcode='55000'; end if;
  if tg_table_name='sc19_payment_offers' then
    if (to_jsonb(new)-array['active','approved']) is distinct from
       (to_jsonb(old)-array['active','approved']) then
      raise exception 'sc19_offer_revision_immutable' using errcode='55000';
    end if;
  elsif (to_jsonb(new)-array['status','session_id','checkout_url','payment_id']) is distinct from
        (to_jsonb(old)-array['status','session_id','checkout_url','payment_id'])
    or (old.session_id is not null and (new.session_id is distinct from old.session_id
        or new.checkout_url is distinct from old.checkout_url))
    or (old.status='paid' and to_jsonb(new) is distinct from to_jsonb(old)) then
      raise exception 'sc19_order_immutable' using errcode='55000';
  end if;
  return new;
end $$;
revoke all on function private.sc19_payment_immutable() from public,anon,authenticated;
create trigger sc19_offer_immutable before update or delete on private.sc19_payment_offers
  for each row execute function private.sc19_payment_immutable();
create trigger sc19_order_immutable before update or delete on private.sc19_payment_orders
  for each row execute function private.sc19_payment_immutable();
create trigger sc19_grant_immutable before update or delete on private.sc19_payment_grants
  for each row execute function private.sc19_payment_immutable();
alter table private.sc19_payment_offers enable row level security;
alter table private.sc19_payment_orders enable row level security;
alter table private.sc19_payment_grants enable row level security;
revoke all on private.sc19_payment_offers,private.sc19_payment_orders,private.sc19_payment_grants
  from public,anon,authenticated;
-- Global or schema default privileges can grant custom roles capabilities that
-- the fixed browser-role revokes above do not remove. RLS and row triggers do
-- not stop TRUNCATE. Reset actual non-owner grantees on exactly the new objects;
-- leave all pre-existing credit, worker and erasure permissions untouched.
do $sc19_payment_acl$
declare obj record; grantee record;
begin
  for obj in select c.oid,c.relowner from pg_class c
    where c.oid in ('private.sc19_payment_offers'::regclass,
      'private.sc19_payment_orders'::regclass,'private.sc19_payment_grants'::regclass)
  loop
    for grantee in select distinct acl.grantee,role.rolname
      from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
      left join pg_roles role on role.oid=acl.grantee
      where c.oid=obj.oid and acl.grantee<>obj.relowner
    loop
      if grantee.grantee=0 then execute format('revoke all on table %s from public',obj.oid::regclass);
      else execute format('revoke all on table %s from %I',obj.oid::regclass,grantee.rolname);end if;
    end loop;
  end loop;
  for obj in select p.oid,p.proowner from pg_proc p
    where p.oid='private.sc19_payment_immutable()'::regprocedure
  loop
    for grantee in select distinct acl.grantee,role.rolname
      from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      left join pg_roles role on role.oid=acl.grantee
      where p.oid=obj.oid and acl.grantee<>obj.proowner
    loop
      if grantee.grantee=0 then execute format('revoke all on function %s from public',obj.oid::regprocedure);
      else execute format('revoke all on function %s from %I',obj.oid::regprocedure,grantee.rolname);end if;
    end loop;
  end loop;
end
$sc19_payment_acl$;
-- No browser grants, public RPC, service-role grants, or automatic activation.
commit;
