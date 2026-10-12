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
-- Both the candidate link and the billable usage are manifest entries.
-- Before Production the existing authoritative R4 functions need reviewed R5
-- replacements + exact immutable baseline, never an unreviewed runtime switch.
create function private.erasure_purge_rows_sc021_r5(
  tenant uuid, subjects uuid[]
) returns table(adapter text,row_key text,row_data jsonb)
language sql stable security definer set search_path = ''
set timezone='UTC' set datestyle='ISO, YMD' as $$
 select * from private.erasure_purge_rows(tenant,subjects)
 union all
 select * from private.ai_gateway_r5_inventory_rows(tenant,subjects)
$$;

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

-- No public/customer/ordinary worker direct inventory or candidate resolver.
revoke all on function private.ai_gateway_r5_inventory_rows(uuid,uuid[])
 from public,anon,authenticated,screening_worker,ai_meter_worker;
revoke all on function private.ai_gateway_r5_row_candidates(uuid,text,jsonb)
 from public,anon,authenticated,screening_worker,ai_meter_worker;
revoke all on function private.erasure_purge_rows_sc021_r5(uuid,uuid[])
 from public,anon,authenticated,screening_worker,ai_meter_worker;
revoke all on function private.ai_gateway_r5_assert_reconciled(uuid,uuid[])
 from public,anon,authenticated,screening_worker,ai_meter_worker;

grant execute on function private.ai_gateway_r5_inventory_rows(uuid,uuid[]) to erasure_purge_owner;
grant execute on function private.ai_gateway_r5_row_candidates(uuid,text,jsonb) to erasure_purge_owner;
grant execute on function private.erasure_purge_rows_sc021_r5(uuid,uuid[]) to erasure_purge_owner;
grant execute on function private.ai_gateway_r5_assert_reconciled(uuid,uuid[]) to erasure_purge_owner;
commit;
