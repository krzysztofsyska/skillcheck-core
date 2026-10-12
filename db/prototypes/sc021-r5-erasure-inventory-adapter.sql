-- SC-021-B/R5 staging-only adapter. This file is NOT a Supabase migration.
-- It adapts the real SC-010 R4 inventory contract without replacing, overriding,
-- or weakening any of its R4 fail-closed schema signature/preview/purge functions.
-- Promotion requires a separately reviewed R5 baseline and signed purge engine.
begin;

-- Candidate-related AI metering must be inventoried using the authoritative FK,
-- never inferred from process ID, request ID or candidate pseudonym.
create function private.ai_gateway_r5_inventory_rows(
  tenant uuid, subjects uuid[]
) returns table(adapter text,row_key text,row_data jsonb)
language sql stable security definer set search_path = '' as $$
  with matching_links as materialized (
    select l.company_id,l.usage_id,l.candidate_id,l.created_at
    from private.ai_gateway_candidate_links l
    join public.candidates c on c.company_id=l.company_id and c.id=l.candidate_id
    where l.company_id=tenant and l.candidate_id=any(subjects)
  )
  select 'private.ai_gateway_candidate_links'::text,
    l.usage_id::text, to_jsonb(l)
  from matching_links l
  union all
  select 'public.ai_gateway_usage'::text,
    u.id::text, to_jsonb(u)
  from public.ai_gateway_usage u
  join matching_links l on l.company_id=u.company_id and l.usage_id=u.id
$$;

-- Explicit R5 candidate resolver, scoped by tenant and the actual link row.
-- This is deliberately separate from the immutable R4 erasure_row_candidates
-- allowlist. That allowlist must be extended only in the future reviewed R5 SQL.
create function private.ai_gateway_r5_row_candidates(
  tenant uuid, adapter text, row_data jsonb
) returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
declare
  ids uuid[];
begin
  if tenant is null or row_data is null or adapter not in (
    'private.ai_gateway_candidate_links','public.ai_gateway_usage'
  ) then
    raise exception 'SC021_UNKNOWN_CANDIDATE_DEPENDENCY' using errcode='PT409';
  end if;
  select array_agg(distinct l.candidate_id order by l.candidate_id) into ids
  from private.ai_gateway_candidate_links l
  join public.candidates c on c.company_id=l.company_id and c.id=l.candidate_id
  where l.company_id=tenant
    and l.usage_id=case when adapter='private.ai_gateway_candidate_links'
      then (row_data->>'usage_id')::uuid
      else (row_data->>'id')::uuid end
    and (adapter<>'private.ai_gateway_candidate_links'
      or (row_data->>'candidate_id')::uuid=l.candidate_id);
  if coalesce(cardinality(ids),0)<>1 then
    raise exception 'SC021_UNKNOWN_CANDIDATE_DEPENDENCY' using errcode='PT409';
  end if;
  return ids;
exception when invalid_text_representation then
  raise exception 'SC021_UNKNOWN_CANDIDATE_DEPENDENCY' using errcode='PT409';
end $$;

-- Staged real SC-010-R4 purge-graph inventory UNION, not an active executor.
-- IMPORTANT: reconcile BEFORE manifest rows can be returned for signing. A
-- reserved/unknown provider call must never be included in a signed manifest.
-- The caller must also execute the normal R4 scope check and the R5
-- candidate-identity check (provided by erasure_check_purge_scope_sc021_r5).
create function private.erasure_purge_rows_sc021_r5(
  tenant uuid, subjects uuid[]
) returns table(adapter text,row_key text,row_data jsonb)
language plpgsql stable security definer set search_path = ''
set timezone='UTC' set datestyle='ISO, YMD' as $
begin
 perform private.ai_gateway_r5_assert_reconciled(tenant,subjects);
 return query select * from private.erasure_purge_rows(tenant,subjects);
 return query select * from private.ai_gateway_r5_inventory_rows(tenant,subjects);
end $;

-- Preparation/preview blocker: unsigned or unknown usage must never be erased.
-- Unlike cost accounting, this is subject-scoped solely through the trusted FK.
create function private.ai_gateway_r5_assert_reconciled(
  tenant uuid, subjects uuid[]
) returns bigint
language plpgsql stable security definer set search_path = '' as $$
declare
  n bigint;
begin
  if tenant is null or subjects is null or cardinality(subjects)=0
    or exists(select 1 from unnest(subjects) s(id)
      where not exists(select 1 from public.candidates c
        where c.id=s.id and c.company_id=tenant))
  then
    raise exception 'SC021_UNKNOWN_CANDIDATE_DEPENDENCY' using errcode='PT409';
  end if;
  if exists (
    select 1 from private.ai_gateway_candidate_links l
    join public.ai_gateway_usage u on u.company_id=l.company_id and u.id=l.usage_id
    where l.company_id=tenant and l.candidate_id=any(subjects)
      and u.status in ('reserved','unknown')
  ) then
    raise exception 'SC021_UNRECONCILED_CANDIDATE_USAGE' using errcode='PT409';
  end if;
  select count(*) into n from private.ai_gateway_candidate_links l
  where l.company_id=tenant and l.candidate_id=any(subjects);
  return n;
end $$;

-- Reuse the ACTUAL SC-010-R4 scope/locking/overlap logic, then extend it
-- with checks for both new adapters. This is an offline proposal for the R5
-- scope checker, not a replacement for the signed R4 preparation function.
create function private.erasure_check_purge_scope_sc021_r5(target_request uuid)
returns void language plpgsql volatile security definer set search_path = '' as $
declare
 e private.erasure_executions%rowtype;
 r record;
 refs uuid[];
begin
 -- Original scope checker retains all R4 safety checks, candidate FOR UPDATE
 -- locks, shared subject detection and provider-data guard.
 perform private.erasure_check_purge_scope(target_request);
 select * into e from private.erasure_executions
  where request_id=target_request for update nowait;
 if not found then
   raise exception 'SC021_ERASURE_SCOPE_UNAVAILABLE' using errcode='PT404';
 end if;
 -- Reconcile before any caller may hash or sign the staged graph.
 perform private.ai_gateway_r5_assert_reconciled(e.company_id,e.candidate_ids);
 for r in select * from private.ai_gateway_r5_inventory_rows(e.company_id,e.candidate_ids)
 loop
   refs:=private.ai_gateway_r5_row_candidates(e.company_id,r.adapter,r.row_data);
   if refs is null or not (refs <@ e.candidate_ids) then
     raise exception 'SC021_SHARED_CANDIDATE_SCOPE' using errcode='PT409';
   end if;
 end loop;
exception when lock_not_available then
 raise exception 'SC021_ERASURE_SCOPE_BUSY' using errcode='PT409';
end $;

-- A real manifest must not be produced until the exact immutable R5 baseline,
-- R5 purge graph, linked-usage removal, and independent review are in place.
-- There is intentionally NO fallback to the R4 prepare function, since its
-- frozen schema contract rejects the new ledger tables.
create function private.ai_gateway_r5_prepare_gate(target_request uuid)
returns bigint language plpgsql volatile security definer set search_path = '' as $
begin
 perform private.erasure_check_purge_scope_sc021_r5(target_request);
 raise exception 'SC021_R5_BASELINE_NOT_REVIEWED' using errcode='PT409';
end $;

-- CRITICAL SC-005/SC-021 boundary: the generic reservation is not an
-- authorized candidate operation. Deny the shared AI/screening worker roles
-- direct access to it. Candidate requests MUST go through the trusted
-- candidate-bound SECURITY DEFINER RPC; non-candidate work needs a separately
-- reviewed, audited role/operation classification and may not re-use these
-- worker capabilities.
revoke execute on function public.ai_gateway_reserve(
 uuid,uuid,uuid,uuid,text,text,text,text,text,text,bigint)
 from ai_meter_worker,screening_worker;
-- The bound candidate RPC itself is available only to ai_meter_worker;
-- screening_worker must receive a future DB-derived attempt/lease capability,
-- NOT the right to supply arbitrary company_id or candidate_id.

-- These staging helpers are callable ONLY by the migration owner / future
-- reviewed SECURITY DEFINER SC-010 inventory function. Even erasure_purge_owner
-- cannot enumerate another tenant outside a signed purge execution. In the real
-- SC-010 lifecycle, inventory preparation is owned by the DB migration owner;
-- the restricted erasure_purge_owner executes only approved delete capabilities.
revoke all on function private.ai_gateway_r5_inventory_rows(uuid,uuid[])
 from public,anon,authenticated,screening_worker,ai_meter_worker,erasure_purge_owner;
revoke all on function private.ai_gateway_r5_row_candidates(uuid,text,jsonb)
 from public,anon,authenticated,screening_worker,ai_meter_worker,erasure_purge_owner;
revoke all on function private.erasure_purge_rows_sc021_r5(uuid,uuid[])
 from public,anon,authenticated,screening_worker,ai_meter_worker,erasure_purge_owner;
revoke all on function private.erasure_check_purge_scope_sc021_r5(uuid)
 from public,anon,authenticated,screening_worker,ai_meter_worker,erasure_purge_owner;
revoke all on function private.ai_gateway_r5_prepare_gate(uuid)
 from public,anon,authenticated,screening_worker,ai_meter_worker,erasure_purge_owner;
revoke all on function private.ai_gateway_r5_assert_reconciled(uuid,uuid[])
 from public,anon,authenticated,screening_worker,ai_meter_worker,erasure_purge_owner;
commit;
