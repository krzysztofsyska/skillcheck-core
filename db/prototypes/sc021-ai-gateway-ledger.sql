-- SC-021-B isolated, non-deployable schema PROTOTYPE.
-- Deliberately outside supabase/migrations because adding candidate-linked ledger
-- requires SC-010 R5 erasure inventory and reviewed immutable baseline first.
-- Do not copy/apply against any shared or production database.
-- SC-021-B/C: isolated cost ledger and concurrency-safe tenant budget gate.
-- Staged migration only. Do not apply to Production without owner approval.
create table public.ai_gateway_limits (
  company_id uuid primary key references public.companies(id) on delete cascade,
  monthly_limit_micro_usd bigint not null check (monthly_limit_micro_usd > 0),
  warning_percent integer not null default 80 check (warning_percent between 1 and 99),
  operator_override boolean not null default false,
  updated_at timestamptz not null default now()
);

create table public.ai_gateway_usage (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  request_key uuid not null,
  operation_id uuid not null,
  process_id uuid,
  candidate_pseudonym text check (
    candidate_pseudonym is null or candidate_pseudonym ~ '^[A-Za-z0-9:_-]{1,80}$'
  ),
  task text not null check (task in (
    'cv_screening','interview_plan','voice_analysis','competency_test','assessment_case'
  )),
  provider text not null check (provider ~ '^[a-z0-9_-]{1,40}$'),
  model text not null check (length(model) between 1 and 128),
  policy_version text not null check (length(policy_version) between 1 and 80),
  price_version text not null check (length(price_version) between 1 and 80),
  billing_month date not null,
  reserved_micro_usd bigint not null check (reserved_micro_usd >= 0),
  actual_micro_usd bigint check (actual_micro_usd is null or actual_micro_usd >= 0),
  input_tokens bigint check (input_tokens is null or input_tokens >= 0),
  cached_input_tokens bigint check (cached_input_tokens is null or cached_input_tokens >= 0),
  output_tokens bigint check (output_tokens is null or output_tokens >= 0),
  provider_request_id text check (provider_request_id is null or length(provider_request_id) <= 200),
  status text not null default 'reserved' check (status in ('reserved','settled','unknown','released')),
  override_used boolean not null default false,
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  unique(company_id, request_key)
);
create index ai_gateway_usage_tenant_month on public.ai_gateway_usage(company_id, billing_month, status);
create index ai_gateway_usage_process on public.ai_gateway_usage(company_id, process_id, created_at);

alter table public.ai_gateway_limits enable row level security;
alter table public.ai_gateway_usage enable row level security;
create policy ai_gateway_limits_tenant_read on public.ai_gateway_limits
  for select to authenticated using (private.has_company_access(company_id));
create policy ai_gateway_usage_tenant_read on public.ai_gateway_usage
  for select to authenticated using (private.has_company_access(company_id));
revoke all on public.ai_gateway_limits, public.ai_gateway_usage from public, anon, authenticated;
grant select on public.ai_gateway_limits, public.ai_gateway_usage to authenticated;
-- Only the privileged database operator provisions budgets; company members cannot change limits.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'ai_meter_worker') then
    create role ai_meter_worker nologin noinherit;
  end if;
end $$;

create function public.ai_gateway_reserve(
  target_company uuid,
  request_id uuid,
  target_operation uuid,
  target_process uuid,
  target_candidate_pseudonym text,
  target_task text,
  target_provider text,
  target_model text,
  target_policy_version text,
  target_price_version text,
  estimated_micro_usd bigint
)
returns table(usage_id uuid, created boolean, warning boolean)
language plpgsql security definer set search_path = ''
as $$
declare
  limits public.ai_gateway_limits%rowtype;
  previous public.ai_gateway_usage%rowtype;
  month_date date := (date_trunc('month', now() at time zone 'UTC'))::date;
  accounted bigint;
  spent_after bigint;
begin
  if target_company is null or request_id is null or target_operation is null
    or estimated_micro_usd is null or estimated_micro_usd < 0
    or target_task is null or target_task not in ('cv_screening','interview_plan','voice_analysis','competency_test','assessment_case')
    or target_provider is null or target_provider !~ '^[a-z0-9_-]{1,40}$'
    or target_model is null or length(target_model) not between 1 and 128
    or target_policy_version is null or length(target_policy_version) not between 1 and 80
    or target_price_version is null or length(target_price_version) not between 1 and 80
    or (target_candidate_pseudonym is not null
      and target_candidate_pseudonym !~ '^[A-Za-z0-9:_-]{1,80}$')
  then raise exception 'SC021_INVALID_RESERVATION' using errcode = '22023';
  end if;

  -- Serializable by tenant: lock budget row BEFORE idempotency and SUM check.
  select * into limits from public.ai_gateway_limits where company_id = target_company for update;
  if not found then raise exception 'SC021_BUDGET_UNCONFIGURED' using errcode = 'P0001'; end if;

  select * into previous from public.ai_gateway_usage
   where company_id = target_company and request_key = request_id;
  if found then
    if previous.operation_id <> target_operation
       or previous.task <> target_task or previous.provider <> target_provider
       or previous.model <> target_model or previous.policy_version <> target_policy_version
       or previous.price_version <> target_price_version
       or previous.reserved_micro_usd <> estimated_micro_usd
       or previous.process_id is distinct from target_process
       or previous.candidate_pseudonym is distinct from target_candidate_pseudonym
    then raise exception 'SC021_IDEMPOTENCY_CONFLICT' using errcode = '23505';
    end if;
    return query select previous.id, false, false;
    return;
  end if;

  select coalesce(sum(case
      when status = 'settled' then actual_micro_usd
      when status in ('reserved', 'unknown') then reserved_micro_usd
      else 0
    end), 0)::bigint into accounted
  from public.ai_gateway_usage
  where company_id = target_company and billing_month = month_date;
  spent_after := accounted + estimated_micro_usd;
  if spent_after < accounted then raise exception 'SC021_COST_OVERFLOW' using errcode = '22003'; end if;
  if spent_after > limits.monthly_limit_micro_usd and not limits.operator_override then
    raise exception 'SC021_BUDGET_EXHAUSTED' using errcode = 'P0001';
  end if;
  insert into public.ai_gateway_usage(
    company_id, request_key, operation_id, process_id, candidate_pseudonym,
    task, provider, model, policy_version, price_version,
    billing_month, reserved_micro_usd, override_used
  ) values (
    target_company, request_id, target_operation, target_process, target_candidate_pseudonym,
    target_task, target_provider, target_model, target_policy_version, target_price_version,
    month_date, estimated_micro_usd, limits.operator_override
  ) returning id into usage_id;
  created := true;
  warning := (spent_after::numeric * 100) >= (limits.monthly_limit_micro_usd::numeric * limits.warning_percent);
  return next;
end $$;

create function public.ai_gateway_settle(
  target_company uuid,
  target_request_key uuid,
  new_cost_micro_usd bigint,
  new_input_tokens bigint,
  new_cached_input_tokens bigint,
  new_output_tokens bigint,
  new_provider_request_id text
)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  item public.ai_gateway_usage%rowtype;
begin
  if new_cost_micro_usd is null or new_cost_micro_usd < 0
    or new_input_tokens is null or new_input_tokens < 0
    or new_cached_input_tokens is null or new_cached_input_tokens < 0
    or new_cached_input_tokens > new_input_tokens
    or new_output_tokens is null or new_output_tokens < 0
    or length(coalesce(new_provider_request_id, '')) > 200
  then raise exception 'SC021_INVALID_USAGE' using errcode = '22023'; end if;
  -- Match reserve() lock order: tenant budget first, then usage row.
  -- A settlement above its estimate must not race a new reservation that would
  -- otherwise read stale accounted usage and admit an over-budget provider call.
  perform 1 from public.ai_gateway_limits
    where company_id = target_company for update;
  if not found then raise exception 'SC021_BUDGET_UNCONFIGURED' using errcode = 'P0001'; end if;
  select * into item from public.ai_gateway_usage
    where company_id = target_company and request_key = target_request_key for update;
  if not found then raise exception 'SC021_UNKNOWN_RESERVATION' using errcode = 'P0001'; end if;
  if item.status = 'settled' then
    if item.actual_micro_usd <> new_cost_micro_usd
      or item.input_tokens <> new_input_tokens
      or item.cached_input_tokens <> new_cached_input_tokens
      or item.output_tokens <> new_output_tokens
      or item.provider_request_id is distinct from new_provider_request_id
    then raise exception 'SC021_SETTLEMENT_CONFLICT' using errcode = '23505'; end if;
    return false;
  end if;
  if item.status not in ('reserved','unknown') then
    raise exception 'SC021_NOT_SETTLEABLE' using errcode = 'P0001';
  end if;
  update public.ai_gateway_usage set
    actual_micro_usd = new_cost_micro_usd, input_tokens = new_input_tokens,
    cached_input_tokens = new_cached_input_tokens, output_tokens = new_output_tokens,
    provider_request_id = new_provider_request_id, status = 'settled', finalized_at = now()
  where id = item.id;
  return true;
end $$;

create function public.ai_gateway_mark_unknown(
  target_company uuid, target_request_key uuid
)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare item public.ai_gateway_usage%rowtype;
begin
  select * into item from public.ai_gateway_usage
    where company_id = target_company and request_key = target_request_key for update;
  if not found then raise exception 'SC021_UNKNOWN_RESERVATION' using errcode = 'P0001'; end if;
  if item.status in ('settled','released') then return false; end if;
  update public.ai_gateway_usage set status = 'unknown' where id = item.id;
  return true;
end $$;

-- No PUBLIC execution on SECURITY DEFINER functions.
revoke all on function public.ai_gateway_reserve(uuid,uuid,uuid,uuid,text,text,text,text,text,text,bigint) from public, anon, authenticated;
revoke all on function public.ai_gateway_settle(uuid,uuid,bigint,bigint,bigint,bigint,text) from public, anon, authenticated;
revoke all on function public.ai_gateway_mark_unknown(uuid,uuid) from public, anon, authenticated;
grant execute on function public.ai_gateway_reserve(uuid,uuid,uuid,uuid,text,text,text,text,text,text,bigint)
  to ai_meter_worker, screening_worker;
grant execute on function public.ai_gateway_settle(uuid,uuid,bigint,bigint,bigint,bigint,text)
  to ai_meter_worker, screening_worker;
grant execute on function public.ai_gateway_mark_unknown(uuid,uuid)
  to ai_meter_worker, screening_worker;
