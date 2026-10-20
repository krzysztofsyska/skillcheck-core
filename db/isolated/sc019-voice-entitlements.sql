-- SC-019 / Voice MVP: ISOLATED PostgreSQL foundation, NOT a migration.
-- Apply only to disposable synthetic databases after the accepted migration chain.
-- This resource is one voice interview; it never debits CV-analysis credits.
-- There is deliberately no browser grant/claim RPC, payment callback, price,
-- live issuer or seed. Only a trusted SQL operator/test administrator may record
-- an independently verified approval or settlement and current company evidence.
-- Existing SC-010 inventory/purge consumers remain unchanged and fail closed
-- because these additional relations have not been approved for live erasure.
begin;

create table private.sc19_voice_entitlements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  resource text not null default 'voice_interview' check (resource = 'voice_interview'),
  package text not null check (package in ('FREE', 'PRESELEKCJA')),
  total integer not null check (total between 1 and 100000),
  used integer not null default 0 check (used >= 0),
  reserved integer not null default 0 check (reserved >= 0),
  revision bigint not null default 1 check (revision > 0),
  -- The opaque UUID refers to operator approval for FREE, or to independently
  -- verified external settlement for PRESELEKCJA. It is never a client request
  -- key, payment redirect, NIP, contact detail or new reference on each retry.
  grant_reference uuid not null unique,
  valid_from timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  active boolean not null default false,
  revoked_at timestamptz,
  company_verified boolean not null default false,
  company_verification_reference uuid,
  company_verification_expires_at timestamptz,
  free_trial_approved boolean not null default false,
  paid_settlement_verified boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (company_id, id),
  check (used + reserved <= total),
  check (package <> 'FREE' or total = 1),
  check (expires_at > valid_from),
  check ((company_verification_reference is null) = (company_verification_expires_at is null)),
  check (not company_verified or company_verification_reference is not null),
  check (package = 'FREE' or not free_trial_approved),
  check (package = 'PRESELEKCJA' or not paid_settlement_verified),
  check (revoked_at is null or not active)
);

-- The history row survives expiry, revocation, consumption and cancellation.
-- A new request/reference can never restart FREE for this company.
create unique index sc19_voice_free_once_per_company
  on private.sc19_voice_entitlements(company_id) where package = 'FREE';
create index sc19_voice_entitlements_company_idx
  on private.sc19_voice_entitlements(company_id, package, valid_from, id);
alter table private.sc19_voice_entitlements enable row level security;
alter table private.sc19_voice_entitlements force row level security;
revoke all on private.sc19_voice_entitlements from public;

-- This helper validates a freshly locked database row, never a caller JSON DTO.
-- It grants no capability: the reservation RPC must also authenticate the tenant,
-- recheck SC-010/012, lock this exact (company_id,id) FOR UPDATE NOWAIT, check
-- used+reserved<total for a NEW reservation, and commit reserved=reserved+1 with
-- its unique operation row in one transaction. Eligibility omits headroom so an
-- existing operation can replay while its reservation occupies the last unit.
create function private.sc19_voice_entitlement_eligible(
  entitlement private.sc19_voice_entitlements
) returns boolean language sql volatile security invoker set search_path = '' as $$
  select coalesce(
    entitlement.resource = 'voice_interview'
    and entitlement.active
    and entitlement.revoked_at is null
    and entitlement.valid_from <= clock_timestamp()
    and entitlement.expires_at > clock_timestamp()
    and entitlement.company_verified
    and entitlement.company_verification_reference is not null
    and entitlement.company_verification_expires_at > clock_timestamp()
    and (
      (entitlement.package = 'FREE' and entitlement.total = 1
        and entitlement.free_trial_approved)
      or (entitlement.package = 'PRESELEKCJA' and entitlement.paid_settlement_verified)
    ),
    false
  );
$$;
revoke all on function private.sc19_voice_entitlement_eligible(private.sc19_voice_entitlements) from public;

create function private.sc19_voice_entitlement_guard()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  usage_delta integer;
  reservation_delta integer;
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'voice_entitlement_history_immutable' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.used <> 0 or new.reserved <> 0 or new.revision <> 1 then
      raise exception 'voice_entitlement_initial_counters_invalid' using errcode = '22023';
    end if;
    new.created_at := clock_timestamp();
    new.updated_at := new.created_at;
    if new.revoked_at is not null then
      new.revoked_at := new.created_at;
      new.active := false;
    end if;
    return new;
  end if;

  -- A paid top-up is a new immutable grant with a different settlement reference.
  -- It never rewrites a previous grant or its consumed/pending units. Grant
  -- windows are economic terms, so extending them requires a separately reviewed
  -- policy instead of updating a row that may already have been consumed.
  if row(new.id, new.company_id, new.resource, new.package, new.total,
      new.grant_reference, new.valid_from, new.expires_at, new.created_at)
    is distinct from
    row(old.id, old.company_id, old.resource, old.package, old.total,
      old.grant_reference, old.valid_from, old.expires_at, old.created_at) then
    raise exception 'voice_entitlement_grant_immutable' using errcode = '55000';
  end if;
  if old.revoked_at is not null
    and (new.revoked_at is distinct from old.revoked_at or new.active) then
    raise exception 'voice_entitlement_revocation_final' using errcode = '55000';
  end if;

  usage_delta := new.used - old.used;
  reservation_delta := new.reserved - old.reserved;
  if usage_delta <> 0 or reservation_delta <> 0 then
    -- Never combine operator evidence/policy changes with operational accounting.
    if row(new.active, new.revoked_at, new.company_verified,
        new.company_verification_reference, new.company_verification_expires_at,
        new.free_trial_approved, new.paid_settlement_verified)
      is distinct from
      row(old.active, old.revoked_at, old.company_verified,
        old.company_verification_reference, old.company_verification_expires_at,
        old.free_trial_approved, old.paid_settlement_verified) then
      raise exception 'voice_entitlement_mixed_mutation' using errcode = '55000';
    end if;
    -- One operation reserves one unit, then releases it before send or settles
    -- that held unit as used. Used never decreases. UNKNOWN has no transition
    -- here and keeps its reserved unit until the operation is reconciled.
    if not (
      (usage_delta = 0 and reservation_delta in (-1, 1))
      or (usage_delta = 1 and reservation_delta = -1)
    ) then
      raise exception 'voice_entitlement_counter_transition_invalid' using errcode = '55000';
    end if;
    if reservation_delta = 1 and (
      not private.sc19_voice_entitlement_eligible(old)
      or old.used + old.reserved >= old.total
    ) then
      raise exception 'voice_entitlement_unavailable' using errcode = 'PT402';
    end if;
  end if;

  if new.revision not in (old.revision, old.revision + 1) then
    raise exception 'voice_entitlement_revision_invalid' using errcode = '55000';
  end if;
  if old.revoked_at is null and new.revoked_at is not null then
    new.revoked_at := clock_timestamp();
    new.active := false;
  end if;
  -- Callers can use a WHERE revision=expected CAS, but cannot choose/backdate the
  -- resulting revision or clock. Explicit revision=revision+1 is also accepted.
  new.revision := old.revision + 1;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
revoke all on function private.sc19_voice_entitlement_guard() from public;
create trigger sc19_voice_entitlement_guard
  before insert or update or delete on private.sc19_voice_entitlements
  for each row execute function private.sc19_voice_entitlement_guard();
create trigger sc19_voice_entitlement_no_truncate
  before truncate on private.sc19_voice_entitlements
  for each statement execute function private.sc19_voice_entitlement_guard();

-- No RLS policies or role grants. Close actual ACLs, including arbitrary
-- inherited defaults and grant options, on these three new objects only.
-- The owner and its defaults remain unchanged; workers get no general CRUD.
do $$
declare f record; recipient record;
begin
  revoke all on table private.sc19_voice_entitlements from public cascade;
  for recipient in
    select distinct a.grantee from pg_catalog.pg_class c
      cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      where c.oid='private.sc19_voice_entitlements'::pg_catalog.regclass
        and a.grantee<>0 and a.grantee<>c.relowner
  loop
    execute pg_catalog.format('revoke all on table private.sc19_voice_entitlements from %I cascade',
      pg_catalog.pg_get_userbyid(recipient.grantee));
  end loop;
  for f in select p.oid,p.oid::pg_catalog.regprocedure as signature
    from pg_catalog.pg_proc p where p.oid in (
      'private.sc19_voice_entitlement_eligible(private.sc19_voice_entitlements)'::pg_catalog.regprocedure,
      'private.sc19_voice_entitlement_guard()'::pg_catalog.regprocedure
    )
  loop
    execute pg_catalog.format('revoke all on function %s from public cascade',f.signature);
    for recipient in
      select distinct a.grantee from pg_catalog.pg_proc p
        cross join lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        where p.oid=f.oid and a.grantee<>0 and a.grantee<>p.proowner
    loop
      execute pg_catalog.format('revoke all on function %s from %I cascade',f.signature,
        pg_catalog.pg_get_userbyid(recipient.grantee));
    end loop;
  end loop;
end;
$$;

commit;
