-- SC-021-B/R5 offline ONLY. Must never be added to supabase/migrations
-- until SC-010 signed erasure manifest, purge graph, and new immutable R5
-- schema baseline are independently reviewed together.
begin;

-- A candidate link is explicit; never infer identity from a pseudonym/UUID substring.
-- This FK intentionally RESTRICTS candidate deletion until a signed purge detaches
-- all linked usage atomically. One physical provider call may belong to one subject.
alter table public.ai_gateway_usage
  add constraint ai_gateway_usage_company_and_id unique (company_id,id);
create table private.ai_gateway_candidate_links (
  company_id uuid not null,
  usage_id uuid not null,
  candidate_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (company_id,usage_id),
  foreign key (company_id,usage_id)
    references public.ai_gateway_usage(company_id,id) on delete cascade,
  foreign key (company_id,candidate_id)
    references public.candidates(company_id,id) on delete restrict
);
create index ai_gateway_candidate_links_subject_idx
  on private.ai_gateway_candidate_links (company_id,candidate_id,usage_id);

-- Identifiers, provider request IDs and physical call keys never enter this table.
-- Retains only company/month/task/provider/price totals, not per-person spend.
create table private.ai_gateway_anonymous_spend (
  company_id uuid not null references public.companies(id) on delete cascade,
  billing_month date not null,
  task text not null,
  provider text not null,
  model text not null,
  price_version text not null,
  cost_micro_usd numeric(30,0) not null check (cost_micro_usd >= 0),
  call_count bigint not null check (call_count >= 0),
  primary key(company_id,billing_month,task,provider,model,price_version)
);

alter table private.ai_gateway_candidate_links enable row level security;
alter table private.ai_gateway_anonymous_spend enable row level security;
revoke all on private.ai_gateway_candidate_links,private.ai_gateway_anonymous_spend
  from public,anon,authenticated;
-- No Data API privileges for any tenant, no direct worker table mutations.

-- The only supported candidate-bearing reservation path in this prototype.
-- An SC-005 worker must obtain company and candidate identity from a trusted DB
-- claim; neither may come from a browser. It binds in the same transaction as
-- the budget reservation before any outbound provider request.
create function private.ai_gateway_reserve_candidate(
  target_company uuid, target_candidate uuid, request_id uuid,
  target_operation uuid, target_process uuid, target_task text,
  target_provider text, target_model text, target_policy_version text,
  target_price_version text, estimated_micro_usd bigint
) returns table(usage_id uuid,created boolean,warning boolean)
language plpgsql security definer set search_path = '' as $$
declare
  candidate_company uuid;
  result_row record;
begin
  if target_company is null or target_candidate is null then
    raise exception 'SC021_CANDIDATE_UNAVAILABLE' using errcode='PT404';
  end if;
  -- Candidate lock FIRST, like SC-010; then tenant budget inside reserve().
  perform private.erasure_lock_candidate(target_candidate);
  select company_id into candidate_company from public.candidates
    where id=target_candidate;
  if candidate_company is distinct from target_company then
    raise exception 'SC021_CANDIDATE_UNAVAILABLE' using errcode='PT404';
  end if;
  select * into result_row from public.ai_gateway_reserve(
    target_company,request_id,target_operation,target_process,null,target_task,
    target_provider,target_model,target_policy_version,target_price_version,
    estimated_micro_usd
  );
  if result_row.created then
    insert into private.ai_gateway_candidate_links(company_id,usage_id,candidate_id)
      values(target_company,result_row.usage_id,target_candidate);
  elsif not exists (
    select 1 from private.ai_gateway_candidate_links candidate_link
    where candidate_link.company_id=target_company
      and candidate_link.usage_id=result_row.usage_id
      and candidate_link.candidate_id=target_candidate
  ) then
    raise exception 'SC021_CANDIDATE_REPLAY_CONFLICT' using errcode='23505';
  end if;
  return query select result_row.usage_id::uuid,result_row.created::boolean,result_row.warning::boolean;
end $$;

-- Prepared exclusively for the SC-010 purge executor, never an ordinary worker
-- or tenant. It REQUIRES an execution-scoped signed purge context in the SAME
-- transaction. A detached cost remains in an anonymous company total, so
-- deleting a subject never credits back actual provider expenditure.
create function private.ai_gateway_detach_signed_purge(target_request uuid)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  execution_row record;
  detached_count bigint;
begin
  select e.company_id,e.candidate_ids into execution_row
  from private.erasure_executions e
  join private.erasure_purge_context context
    on context.request_id=e.request_id
   and context.company_id=e.company_id
   and context.txid=txid_current()
   and context.mode='delete'
  where e.request_id=target_request;
  if not found or execution_row.candidate_ids is null
     or cardinality(execution_row.candidate_ids)=0 then
    raise exception 'SC021_ERASURE_NOT_AUTHORIZED' using errcode='PT403';
  end if;
  -- SC-010 freezes each subject before signing its purge; an active subject
  -- must not be detached through this capability even with a spoofed context.
  if exists (
    select 1 from unnest(execution_row.candidate_ids) as subjects(id)
    where not private.erasure_candidate_frozen(subjects.id)
  ) then
    raise exception 'SC021_CANDIDATE_NOT_FROZEN' using errcode='PT409';
  end if;
  -- Budget lock order matches reserve() and settle(): tenant before usage rows.
  perform 1 from public.ai_gateway_limits
    where company_id=execution_row.company_id for update;
  if not found then raise exception 'SC021_BUDGET_UNCONFIGURED' using errcode='P0001'; end if;
  perform 1 from private.ai_gateway_candidate_links l
  join public.ai_gateway_usage u on u.id=l.usage_id and u.company_id=l.company_id
  where l.company_id=execution_row.company_id
    and l.candidate_id=any(execution_row.candidate_ids)
    and u.status in ('reserved','unknown');
  if found then
    raise exception 'SC021_UNRECONCILED_CANDIDATE_USAGE' using errcode='PT409';
  end if;
  -- SETTLED expenses only. RELEASED reservations contribute zero.
  insert into private.ai_gateway_anonymous_spend (
    company_id,billing_month,task,provider,model,price_version,
    cost_micro_usd,call_count
  )
  select u.company_id,u.billing_month,u.task,u.provider,u.model,
    u.price_version,sum(u.actual_micro_usd::numeric),count(*)::bigint
  from public.ai_gateway_usage u
  join private.ai_gateway_candidate_links l
    on l.company_id=u.company_id and l.usage_id=u.id
  where l.company_id=execution_row.company_id
    and l.candidate_id=any(execution_row.candidate_ids)
    and u.status='settled'
  group by u.company_id,u.billing_month,u.task,u.provider,u.model,u.price_version
  on conflict(company_id,billing_month,task,provider,model,price_version)
  do update set
    cost_micro_usd=private.ai_gateway_anonymous_spend.cost_micro_usd + excluded.cost_micro_usd,
    call_count=private.ai_gateway_anonymous_spend.call_count + excluded.call_count;

  with deleted as (
    delete from public.ai_gateway_usage u
    using private.ai_gateway_candidate_links l
    where l.company_id=execution_row.company_id
      and l.candidate_id=any(execution_row.candidate_ids)
      and u.company_id=l.company_id and u.id=l.usage_id
    returning u.id
  )
  select count(*)::bigint into detached_count from deleted;
  return detached_count;
end $$;

-- Security-definer RPCs are not exposed in any public schema or user grants.
revoke all on function private.ai_gateway_reserve_candidate(
  uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,bigint)
  from public,anon,authenticated;
revoke all on function private.ai_gateway_detach_signed_purge(uuid)
  from public,anon,authenticated;
grant usage on schema private to ai_meter_worker,erasure_purge_owner;
grant execute on function private.ai_gateway_reserve_candidate(
  uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,bigint)
  to ai_meter_worker;
grant execute on function private.ai_gateway_detach_signed_purge(uuid)
  to erasure_purge_owner;
commit;
