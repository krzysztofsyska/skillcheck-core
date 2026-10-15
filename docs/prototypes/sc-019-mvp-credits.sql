-- SC-019 MVP: REVIEW-ONLY PostgreSQL PROTOTYPE. NOT A PRODUCTION MIGRATION.
-- Convert with Supabase CLI 'migration new' after independent review, production
-- migration-history reconciliation and explicit release approval.
-- Depends on SC-004/005/006 schemas (screening_analysis_versions).
begin;

create table private.sc19_balances (
  company_id uuid primary key references public.companies(id) on delete restrict,
  plan text not null check(plan in ('FREE','PRESELEKCJA')),
  available integer not null default 0 check (available >= 0),
  free_claimed boolean not null default false,
  updated_at timestamptz not null default now()
);
create table private.sc19_trial_nips (
  company_id uuid primary key references public.companies(id) on delete restrict,
  nip text not null unique check(nip ~ '^[0-9]{10}$'),
  claimed_at timestamptz not null default now()
);

-- An owner-selected checksum-valid NIP does not prove legal representation.
-- FREE activation is blocked until the operator verifies the company/NIP
-- relationship and inserts an approval using privileged, audited SQL.
create table private.sc19_trial_approvals (
  company_id uuid primary key references public.companies(id) on delete restrict,
  nip text not null unique check(nip ~ '^[0-9]{10}$'),
  proof_reference text not null unique check(length(btrim(proof_reference)) between 8 and 160),
  approved_at timestamptz not null default now()
);
create table private.sc19_analysis_spend (
  analysis_id uuid primary key,
  company_id uuid not null references public.companies(id) on delete restrict,
  state text not null check(state in ('reserved','released')),
  updated_at timestamptz not null default now()
);
create table private.sc19_credit_journal (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  analysis_id uuid,
  reason text not null check(reason in ('trial','paid_grant','analysis_reserve','analysis_release','analysis_retry')),
  delta integer not null check(delta <> 0),
  reference text,
  created_at timestamptz not null default now(),
  unique (reference)
);

-- Only SQL operator privileges can grant a paid pack. No user-facing direct
-- balance/journal CRUD. NIP is never included in public balance responses.
revoke all on private.sc19_balances, private.sc19_trial_nips,
  private.sc19_trial_approvals, private.sc19_analysis_spend,
  private.sc19_credit_journal from public, anon, authenticated;
alter table private.sc19_balances enable row level security;
alter table private.sc19_trial_nips enable row level security;
alter table private.sc19_trial_approvals enable row level security;
alter table private.sc19_analysis_spend enable row level security;
alter table private.sc19_credit_journal enable row level security;

create function private.sc19_valid_nip(value text)
returns boolean language sql immutable set search_path = '' as $$
  -- CASE ensures only digit strings reach integer casts, including in PG16.
  select case when value ~ '^[0-9]{10}$' then
    (
      (substring(value,1,1)::int*6 + substring(value,2,1)::int*5
      + substring(value,3,1)::int*7 + substring(value,4,1)::int*2
      + substring(value,5,1)::int*3 + substring(value,6,1)::int*4
      + substring(value,7,1)::int*5 + substring(value,8,1)::int*6
      + substring(value,9,1)::int*7) % 11
    ) = substring(value,10,1)::int
  else false end;
$$;
revoke all on function private.sc19_valid_nip(text) from public, anon, authenticated;

-- Every billing write locks the company row before the balance, spend, or journal
-- row. Analysis inserts also take a foreign-key key-share lock on the company,
-- so the opposite order deadlocks with sc19_grant_paid.
create function private.sc19_lock_company(target_company uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if target_company is null then
    raise exception 'sc19_company_missing' using errcode='22023';
  end if;
  perform 1 from public.companies where id=target_company for update;
  if not found then raise exception 'sc19_company_missing' using errcode='22023'; end if;
end;
$$;
revoke all on function private.sc19_lock_company(uuid) from public, anon, authenticated;

-- The analysis insert's foreign key takes a key-share lock on the company row
-- before an AFTER trigger runs. Taking the stronger company lock there deadlocks
-- two concurrent inserts. Lock first, while the insert is still BEFORE.
create function private.sc19_lock_analysis_company()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.sc19_lock_company(new.company_id);
  return new;
end;
$$;
revoke all on function private.sc19_lock_analysis_company() from public, anon, authenticated;

create function public.sc19_claim_trial(target_company uuid, supplied_nip text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  normalized text := replace(replace(btrim(coalesce(supplied_nip,'')), '-', ''), ' ', '');
  existing_nip text;
  current_credits integer;
begin
  if (select auth.uid()) is null or not private.is_company_owner(target_company) then
    raise exception 'sc19_company_forbidden' using errcode = '42501';
  end if;
  if not private.sc19_valid_nip(normalized) then
    raise exception 'sc19_invalid_nip' using errcode = '22023';
  end if;
  -- Serialize per company and use a globally UNIQUE NIP across all owners.
  perform private.sc19_lock_company(target_company);
  select nip into existing_nip from private.sc19_trial_nips where company_id=target_company;
  if existing_nip is not null then
    if existing_nip <> normalized then
      raise exception 'sc19_trial_already_claimed' using errcode = '23505';
    end if;
    select available into current_credits from private.sc19_balances where company_id=target_company;
    return current_credits; -- same company, same NIP = idempotent, no extra grant
  end if;
  if not exists (
    select 1 from private.sc19_trial_approvals approval
    where approval.company_id=target_company and approval.nip=normalized
  ) then
    raise exception 'sc19_trial_requires_verified_company' using errcode='42501';
  end if;
  -- FREE is only the pre-payment trial. A paid pack must not receive a late bonus.
  if exists (
    select 1 from private.sc19_balances
    where company_id=target_company and plan='PRESELEKCJA'
  ) then
    raise exception 'sc19_trial_after_payment' using errcode='23505';
  end if;
  insert into private.sc19_trial_nips(company_id,nip) values (target_company,normalized);
  insert into private.sc19_balances(company_id,plan,available,free_claimed)
    values(target_company,'FREE',5,true)
    on conflict(company_id) do update
      set available=private.sc19_balances.available+5,free_claimed=true,updated_at=now()
      where not private.sc19_balances.free_claimed
        and private.sc19_balances.plan<>'PRESELEKCJA';
  if not found then raise exception 'sc19_trial_already_claimed' using errcode='23505'; end if;
  insert into private.sc19_credit_journal(company_id,reason,delta,reference)
    values(target_company,'trial',5,'trial:'||normalized);
  select available into current_credits from private.sc19_balances where company_id=target_company;
  return current_credits;
end;
$$;
revoke all on function public.sc19_claim_trial(uuid,text) from public, anon, authenticated;
grant execute on function public.sc19_claim_trial(uuid,text) to authenticated;

create function public.sc19_get_balance(target_company uuid)
returns table(plan text,available integer,free_claimed boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not private.has_company_access(target_company, false) then
    raise exception 'sc19_company_forbidden' using errcode='42501';
  end if;
  return query select b.plan,b.available,b.free_claimed
    from private.sc19_balances b where b.company_id=target_company;
end;
$$;
revoke all on function public.sc19_get_balance(uuid) from public, anon, authenticated;
grant execute on function public.sc19_get_balance(uuid) to authenticated;

-- MANUAL PAID FULFILLMENT ONLY: call from trusted admin SQL after confirming
-- bank settlement / external processor settlement. Never GRANT to authenticated.
create function private.sc19_grant_paid(target_company uuid, settlement_reference text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  prior_company uuid;
  credits integer;
begin
  if length(btrim(coalesce(settlement_reference,''))) not between 8 and 160 then
    raise exception 'sc19_invalid_settlement' using errcode='22023';
  end if;
  perform private.sc19_lock_company(target_company);
  select company_id into prior_company from private.sc19_credit_journal
    where reference='settlement:'||btrim(settlement_reference);
  if prior_company is not null then
    if prior_company <> target_company then
      raise exception 'sc19_reference_conflict' using errcode='23505';
    end if;
    select available into credits from private.sc19_balances where company_id=target_company;
    return credits; -- same payment, no second grant
  end if;
  insert into private.sc19_balances(company_id,plan,available)
    values(target_company,'PRESELEKCJA',60)
    on conflict(company_id) do update
      set plan='PRESELEKCJA',available=private.sc19_balances.available+60,updated_at=now();
  insert into private.sc19_credit_journal(company_id,reason,delta,reference)
    values(target_company,'paid_grant',60,'settlement:'||btrim(settlement_reference));
  select available into credits from private.sc19_balances where company_id=target_company;
  return credits;
end;
$$;
revoke all on function private.sc19_grant_paid(uuid,text) from public, anon, authenticated;

-- DB TRIGGER, not frontend check: all entrypoints including legacy screening RPC
-- are billed on a newly INSERTed logical analysis. Completed reuse does not INSERT.
-- The company row is locked before the balance so a paid grant cannot deadlock.
create function private.sc19_charge_analysis()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.sc19_lock_company(new.company_id);
  update private.sc19_balances
    set available=available-1,updated_at=now()
    where company_id=new.company_id and available>0;
  if not found then raise exception 'sc19_quota_exhausted' using errcode='PT402'; end if;
  insert into private.sc19_analysis_spend(analysis_id,company_id,state)
    values(new.id,new.company_id,'reserved');
  insert into private.sc19_credit_journal(company_id,analysis_id,reason,delta)
    values(new.company_id,new.id,'analysis_reserve',-1);
  return null;
end;
$$;
revoke all on function private.sc19_charge_analysis() from public, anon, authenticated;

-- Fail/cancel refunds exactly once; same-analysis retry re-reserves exactly once.
-- Staling a pending or processing analysis abandons its active attempt, cancels
-- the analysis, and releases its reservation. A completed analysis that later
-- becomes stale keeps the credit already consumed.
create function private.sc19_reconcile_analysis()
returns trigger language plpgsql security definer set search_path = '' as $$
declare previous_state text;
begin
  perform private.sc19_lock_company(new.company_id);
  if old.stale_at is null and new.stale_at is not null
     and new.execution_status in ('pending','processing') then
    -- Same reconciliation as claim_screening_attempt: a pending or processing
    -- attempt cannot stay active after this cancellation, or the worker can
    -- no longer record token and cost metadata for the refunded credit.
    -- The analysis row is already locked by the statement that set stale_at.
    -- The company row is locked above, and the attempt row is locked here.
    -- claim_screening_attempt uses that same order when it is installed.
    -- The isolated billing fixture has no attempts table.
    if to_regclass('public.screening_analysis_attempts') is not null then
      update public.screening_analysis_attempts
        set status='abandoned', finished_at=clock_timestamp()
        where company_id=new.company_id and analysis_id=new.id
          and status in ('pending','processing');
    end if;
    update public.screening_analysis_versions
      set execution_status='cancelled'
      where id=new.id and company_id=new.company_id
        and execution_status in ('pending','processing');
    return null;
  end if;
  if old.execution_status is not distinct from new.execution_status then return null; end if;
  -- Terminal analyses cannot be resurrected or reclassified to obtain a free
  -- refund. Only a failed/cancelled analysis may re-enter 'pending', and that
  -- transition must reserve another credit atomically below.
  if old.execution_status in ('completed', 'failed', 'cancelled')
    and not (old.execution_status in ('failed', 'cancelled')
      and new.execution_status = 'pending') then
    raise exception 'sc19_invalid_terminal_transition' using errcode = '55000';
  end if;
  select state into previous_state from private.sc19_analysis_spend
    where analysis_id=new.id and company_id=new.company_id for update;
  if previous_state is null then raise exception 'sc19_spend_missing' using errcode='23503'; end if;
  if new.execution_status in ('failed','cancelled') and previous_state='reserved' then
    update private.sc19_balances set available=available+1,updated_at=now()
      where company_id=new.company_id;
    update private.sc19_analysis_spend set state='released',updated_at=now() where analysis_id=new.id;
    insert into private.sc19_credit_journal(company_id,analysis_id,reason,delta)
      values(new.company_id,new.id,'analysis_release',1);
  elsif new.execution_status='pending' and old.execution_status in ('failed','cancelled')
    and previous_state='released' then
    update private.sc19_balances set available=available-1,updated_at=now()
      where company_id=new.company_id and available>0;
    if not found then raise exception 'sc19_quota_exhausted' using errcode='PT402'; end if;
    update private.sc19_analysis_spend set state='reserved',updated_at=now() where analysis_id=new.id;
    insert into private.sc19_credit_journal(company_id,analysis_id,reason,delta)
      values(new.company_id,new.id,'analysis_retry',-1);
  end if;
  return null;
end;
$$;
revoke all on function private.sc19_reconcile_analysis() from public, anon, authenticated;

-- Refuse to arm billing while an in-flight or failed analysis has no reservation.
-- Those rows are reachable from the legacy start/retry RPC without a new INSERT,
-- so installing the trigger around them would either skip the debit or fail closed
-- mid-retry. Completed history is left unbilled and cannot be refunded.
-- SHARE ROW EXCLUSIVE waits for an open insert and then blocks new writes until
-- this transaction commits, so a pending analysis cannot land between the check
-- and trigger creation.
do $sc19_preexisting$
begin
  lock table public.screening_analysis_versions in share row exclusive mode;
  if exists (
    select 1 from public.screening_analysis_versions analysis
    where analysis.execution_status is distinct from 'completed'
      and not exists (
        select 1 from private.sc19_analysis_spend spend
        where spend.analysis_id=analysis.id
      )
  ) then
    raise exception 'sc19_preexisting_unbilled_analysis' using errcode='55000';
  end if;
end
$sc19_preexisting$;

create trigger sc19_analysis_lock before insert on public.screening_analysis_versions
  for each row execute function private.sc19_lock_analysis_company();
create trigger sc19_analysis_bill after insert on public.screening_analysis_versions
  for each row execute function private.sc19_charge_analysis();
create trigger sc19_analysis_reconcile after update of execution_status, stale_at
  on public.screening_analysis_versions
  for each row execute function private.sc19_reconcile_analysis();

-- The write-blocking lock from the check above is still held. Recheck after the
-- triggers exist so an analysis that committed while trigger creation waited
-- cannot remain unbilled.
do $sc19_preexisting_recheck$
begin
  if exists (
    select 1 from public.screening_analysis_versions analysis
    where analysis.execution_status is distinct from 'completed'
      and not exists (
        select 1 from private.sc19_analysis_spend spend
        where spend.analysis_id=analysis.id
      )
  ) then
    raise exception 'sc19_preexisting_unbilled_analysis' using errcode='55000';
  end if;
end
$sc19_preexisting_recheck$;

-- Claim, completion and failure must take the same row locks. A stale update
-- already holds the analysis row before its erasure guard locks the candidate,
-- then this rewrite locks the company and the attempt. Completion and failure
-- used to lock the attempt first, which deadlocks a reclaim of an expired
-- lease. The candidate lock, when SC-010 installed it, is taken immediately
-- after the analysis row and before the advisory lock. Taking it earlier makes
-- the stale update fail with PT409, because that update already holds the
-- analysis row and then uses NOWAIT. Taking it after the advisory lock makes
-- start or retry, which hold the candidate and wait for the advisory lock,
-- fail the finalizer the same way. A database that has the worker functions
-- but not erasure_lock_candidate still receives this rewrite; only the
-- candidate call is skipped. The minimal billing fixture has none of these
-- functions, so this step does nothing there.
do $sc19_claim_lock$
begin
  if to_regprocedure('public.claim_screening_attempt(uuid)') is null
     or to_regprocedure('public.complete_screening_analysis(uuid,text,text,text,jsonb,text,text,integer,integer,integer,numeric,text)') is null
     or to_regprocedure('public.fail_screening_attempt(uuid,text,text,text,text,text,text,integer,integer,integer,numeric,text)') is null then
    return;
  end if;
create or replace function public.claim_screening_attempt(target_attempt uuid)
returns table (
  analysis_id uuid,
  attempt_id uuid,
  lease_token text,
  lease_expires_at timestamptz,
  input_fingerprint text,
  analysis_contract_hash text,
  payload_schema_version integer,
  result_schema_version integer,
  prompt_version text,
  provider text,
  model text,
  model_revision text,
  input_cv_text_snapshot text,
  criteria_snapshot jsonb
) language plpgsql security definer set search_path = '' as $$
declare
  attempt public.screening_analysis_attempts%rowtype;
  analysis public.screening_analysis_versions%rowtype;
  stale_reason text;
  raw_token text;
  expires_at timestamptz;
  target_analysis uuid;
  target_company uuid;
  target_candidate uuid;
begin
  -- Reviewed claim body. The analysis row, the company, and then the attempt
  -- match a stale cancellation. The candidate lock follows the analysis row:
  -- the stale update already holds that row before its NOWAIT candidate guard.
  -- Locking the attempt first deadlocks with sc19_reconcile_analysis.
  -- The return column analysis_id is in scope, so this lookup is dynamic SQL.
  execute $claim_locate$
    select t.analysis_id, t.company_id, a.candidate_id
    from public.screening_analysis_attempts t
    join public.screening_analysis_versions v
      on v.id = t.analysis_id and v.company_id = t.company_id
    join public.applications a
      on a.id = v.application_id and a.company_id = v.company_id
    where t.id = $1
  $claim_locate$
  into target_analysis, target_company, target_candidate
  using target_attempt;
  if target_analysis is null or target_company is null or target_candidate is null then
    raise exception 'Attempt unavailable' using errcode = '42501';
  end if;
  select * into analysis from public.screening_analysis_versions
    where id = target_analysis and company_id = target_company for update;
  if not found then raise exception 'Analysis unavailable' using errcode = '42501'; end if;
  if to_regprocedure('private.erasure_lock_candidate(uuid)') is not null then
    perform private.erasure_lock_candidate(target_candidate);
  end if;
  perform private.sc19_lock_company(target_company);
  select * into attempt from public.screening_analysis_attempts
    where id = target_attempt for update;
  if not found
     or attempt.analysis_id is distinct from target_analysis
     or attempt.company_id is distinct from target_company then
    raise exception 'Attempt unavailable' using errcode = '42501';
  end if;
  if attempt.status <> 'pending'
    and not (attempt.status = 'processing' and attempt.lease_expires_at <= clock_timestamp())
    then raise exception 'Attempt is not claimable' using errcode = '55000'; end if;

  stale_reason := private.screening_stale_reason(analysis.id);
  if stale_reason is not null then
    update public.screening_analysis_attempts
      set status = 'abandoned', finished_at = clock_timestamp()
      where id = attempt.id;
    update public.screening_analysis_versions
      set execution_status = 'cancelled',
        stale_at = coalesce(stale_at, clock_timestamp()),
        stale_reason = coalesce(screening_analysis_versions.stale_reason, stale_reason),
        updated_at = clock_timestamp()
      where id = analysis.id;
    return;
  end if;

  raw_token := replace(gen_random_uuid()::text, '-', '')
    || replace(gen_random_uuid()::text, '-', '');
  expires_at := clock_timestamp() + interval '5 minutes';
  update public.screening_analysis_attempts
    set status = 'processing',
      lease_token_hash = private.screening_hash(raw_token),
      lease_expires_at = expires_at,
      started_at = coalesce(started_at, clock_timestamp())
    where id = attempt.id;
  update public.screening_analysis_versions
    set execution_status = 'processing',
      processing_started_at = coalesce(processing_started_at, clock_timestamp()),
      updated_at = clock_timestamp()
    where id = analysis.id;
  return query select
    analysis.id,
    attempt.id,
    raw_token,
    expires_at,
    analysis.input_fingerprint,
    analysis.analysis_contract_hash,
    analysis.payload_schema_version,
    analysis.result_schema_version,
    analysis.prompt_version,
    analysis.provider,
    analysis.model,
    analysis.model_revision,
    analysis.input_cv_text_snapshot,
    analysis.criteria_snapshot;
end;
$$;
create or replace function public.complete_screening_analysis(
  target_attempt uuid,
  provided_lease_token text,
  expected_input_fingerprint text,
  expected_analysis_contract_hash text,
  findings jsonb,
  new_provider_request_id text default null,
  new_provider_response_id text default null,
  new_input_tokens integer default null,
  new_output_tokens integer default null,
  new_cached_input_tokens integer default null,
  new_cost_amount numeric default null,
  new_cost_currency text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  attempt public.screening_analysis_attempts%rowtype;
  analysis public.screening_analysis_versions%rowtype;
  expected_criterion jsonb;
  finding jsonb;
  item_order bigint;
  rating text;
  evidence jsonb;
  explanation text;
  confidence numeric;
  computed_finalization_hash text;
  detected_stale_reason text;
  target_analysis uuid;
  target_company uuid;
  target_application uuid;
  target_candidate uuid;
begin
  if provided_lease_token is null or length(provided_lease_token) < 32
    or expected_input_fingerprint !~ '^[0-9a-f]{64}$'
    or expected_analysis_contract_hash !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(findings) is distinct from 'array'
    or new_input_tokens < 0 or new_output_tokens < 0 or new_cached_input_tokens < 0
    or new_cost_amount < 0
    or (new_cost_currency is not null and new_cost_currency !~ '^[A-Z]{3}$')
    or length(coalesce(new_provider_request_id, '')) > 500
    or length(coalesce(new_provider_response_id, '')) > 500
    then raise exception 'Invalid completion metadata' using errcode = '22023'; end if;
  computed_finalization_hash := private.screening_hash(jsonb_build_object(
    'findings', findings,
    'provider_request_id', new_provider_request_id,
    'provider_response_id', new_provider_response_id,
    'input_tokens', new_input_tokens,
    'output_tokens', new_output_tokens,
    'cached_input_tokens', new_cached_input_tokens,
    'cost_amount', new_cost_amount,
    'cost_currency', new_cost_currency
  )::text);

  -- The analysis row comes first, matching a stale update that already holds
  -- it before the candidate guard. The candidate lock comes before the
  -- advisory lock, so a start or retry waiting on that advisory lock cannot
  -- make this NOWAIT fail while this transaction holds the advisory lock.
  select attempts.analysis_id, attempts.company_id, versions.application_id, applications.candidate_id
    into target_analysis, target_company, target_application, target_candidate
  from public.screening_analysis_attempts attempts
  join public.screening_analysis_versions versions
    on versions.id = attempts.analysis_id and versions.company_id = attempts.company_id
  join public.applications applications
    on applications.id = versions.application_id and applications.company_id = versions.company_id
  where attempts.id = target_attempt;
  if not found then raise exception 'Attempt unavailable' using errcode = '42501'; end if;
  select * into analysis from public.screening_analysis_versions
    where id = target_analysis and company_id = target_company for update;
  if not found then raise exception 'Analysis unavailable' using errcode = '42501'; end if;
  if to_regprocedure('private.erasure_lock_candidate(uuid)') is not null then
    perform private.erasure_lock_candidate(target_candidate);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('screening:' || target_application::text, 0));
  perform private.sc19_lock_company(target_company);
  select * into attempt from public.screening_analysis_attempts
    where id = target_attempt for update;
  if not found
     or attempt.analysis_id is distinct from target_analysis
     or attempt.company_id is distinct from target_company then
    raise exception 'Attempt unavailable' using errcode = '42501';
  end if;

  if attempt.status = 'completed' then
    if attempt.lease_token_hash = private.screening_hash(provided_lease_token)
      and attempt.finalization_hash = computed_finalization_hash
      then return analysis.id; end if;
    raise exception 'Conflicting completion' using errcode = 'PT409';
  end if;
  if attempt.status <> 'processing'
    or attempt.lease_expires_at <= clock_timestamp()
    or attempt.lease_token_hash <> private.screening_hash(provided_lease_token)
    then raise exception 'Invalid or expired lease' using errcode = '42501'; end if;
  if analysis.execution_status <> 'processing'
    or analysis.input_fingerprint <> expected_input_fingerprint
    or analysis.analysis_contract_hash <> expected_analysis_contract_hash
    then raise exception 'Analysis binding changed' using errcode = 'PT409'; end if;
  if jsonb_array_length(findings) <> jsonb_array_length(analysis.criteria_snapshot)
    then raise exception 'Incomplete criterion set' using errcode = '22023'; end if;

  for expected_criterion, item_order in
    select value, ordinality
    from jsonb_array_elements(analysis.criteria_snapshot) with ordinality
  loop
    select value into finding
    from jsonb_array_elements(findings)
    where value->>'criterion_id' = expected_criterion->>'id';
    if not found or (
      select count(*) from jsonb_array_elements(findings)
      where value->>'criterion_id' = expected_criterion->>'id'
    ) <> 1 then raise exception 'Invalid criterion set' using errcode = '22023'; end if;
    if jsonb_typeof(finding) is distinct from 'object'
      or exists (
        select 1 from jsonb_object_keys(finding) key
        where key not in ('criterion_id', 'rating', 'evidence', 'explanation', 'confidence')
      )
      or jsonb_typeof(finding->'criterion_id') is distinct from 'string'
      or jsonb_typeof(finding->'rating') is distinct from 'string'
      or jsonb_typeof(finding->'evidence') is distinct from 'array'
      or (finding ? 'explanation'
        and jsonb_typeof(finding->'explanation') not in ('string', 'null'))
      or (finding ? 'confidence'
        and jsonb_typeof(finding->'confidence') not in ('number', 'null'))
      then raise exception 'Invalid criterion result' using errcode = '22023'; end if;
    rating := finding->>'rating';
    evidence := finding->'evidence';
    explanation := finding->>'explanation';
    confidence := case when jsonb_typeof(finding->'confidence') = 'number'
      then (finding->>'confidence')::numeric else null end;
    if rating not in ('insufficient_data', 'below', 'meets', 'above')
      or length(coalesce(explanation, '')) > 4000
      or confidence < 0 or confidence > 1
      or not private.screening_valid_evidence(
        analysis.input_cv_text_snapshot, evidence, rating <> 'insufficient_data'
      ) then raise exception 'Invalid evidence' using errcode = '22023'; end if;

    insert into public.screening_criterion_results(
      company_id, analysis_id, criterion_id, criterion_kind, criterion_order,
      criterion_text_snapshot, rating, evidence, explanation, confidence
    ) values (
      analysis.company_id, analysis.id, expected_criterion->>'id',
      expected_criterion->>'kind', item_order, expected_criterion->>'text',
      rating, evidence, explanation, confidence
    );
  end loop;

  detected_stale_reason := private.screening_stale_reason(analysis.id);
  if detected_stale_reason is null and exists (
    select 1 from public.screening_analysis_versions newer
    where newer.company_id = analysis.company_id
      and newer.application_id = analysis.application_id
      and newer.analysis_version > analysis.analysis_version
  ) then detected_stale_reason := 'manual_invalidation'; end if;
  if detected_stale_reason is null and analysis.stale_at is null then
    update public.screening_analysis_versions previous
    set stale_at = clock_timestamp(),
      stale_reason = case
        when previous.input_fingerprint <> analysis.input_fingerprint
          then coalesce(private.screening_stale_reason(previous.id), 'manual_invalidation')
        when previous.analysis_contract_hash <> analysis.analysis_contract_hash
          then 'screening_contract_changed'
        else 'manual_invalidation'
      end,
      superseded_by_analysis_id = analysis.id,
      updated_at = clock_timestamp()
    where previous.company_id = analysis.company_id
      and previous.application_id = analysis.application_id
      and previous.id <> analysis.id
      and previous.execution_status = 'completed'
      and previous.stale_at is null;
  end if;

  update public.screening_analysis_attempts
  set status = 'completed',
    provider_request_id = new_provider_request_id,
    provider_response_id = new_provider_response_id,
    input_tokens = new_input_tokens,
    output_tokens = new_output_tokens,
    cached_input_tokens = new_cached_input_tokens,
    cost_amount = new_cost_amount,
    cost_currency = new_cost_currency,
    finalization_hash = computed_finalization_hash,
    finished_at = clock_timestamp()
  where id = attempt.id;
  update public.screening_analysis_versions
  set execution_status = 'completed',
    completed_at = clock_timestamp(),
    failed_at = null,
    failure_code = null,
    failure_message = null,
    stale_at = case when detected_stale_reason is not null or stale_at is not null
      then coalesce(stale_at, clock_timestamp()) else null end,
    stale_reason = case when detected_stale_reason is not null or stale_at is not null
      then case when detected_stale_reason = 'manual_invalidation' then 'manual_invalidation' else 'input_changed_during_processing' end else null end,
    overall_score = null,
    updated_at = clock_timestamp()
  where id = analysis.id;
  return analysis.id;
exception
  when check_violation or invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Invalid completion payload' using errcode = '22023';
end;
$$;
create or replace function public.fail_screening_attempt(
  target_attempt uuid,
  provided_lease_token text,
  expected_input_fingerprint text,
  expected_analysis_contract_hash text,
  new_error_code text,
  new_error_message text default null,
  new_provider_request_id text default null,
  new_input_tokens integer default null,
  new_output_tokens integer default null,
  new_cached_input_tokens integer default null,
  new_cost_amount numeric default null,
  new_cost_currency text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  attempt public.screening_analysis_attempts%rowtype;
  analysis public.screening_analysis_versions%rowtype;
  computed_finalization_hash text;
  target_analysis uuid;
  target_company uuid;
  target_candidate uuid;
begin
  if provided_lease_token is null or length(provided_lease_token) < 32
    or expected_input_fingerprint !~ '^[0-9a-f]{64}$'
    or expected_analysis_contract_hash !~ '^[0-9a-f]{64}$'
    or new_error_code is null or new_error_code !~ '^[a-z0-9_:-]{1,100}$'
    or length(coalesce(new_error_message, '')) > 2000
    or length(coalesce(new_provider_request_id, '')) > 500
    or new_input_tokens < 0 or new_output_tokens < 0 or new_cached_input_tokens < 0
    or new_cost_amount < 0
    or (new_cost_currency is not null and new_cost_currency !~ '^[A-Z]{3}$')
    then raise exception 'Invalid failure metadata' using errcode = '22023'; end if;
  computed_finalization_hash := private.screening_hash(jsonb_build_object(
    'error_code', new_error_code,
    'error_message', new_error_message,
    'provider_request_id', new_provider_request_id,
    'input_tokens', new_input_tokens,
    'output_tokens', new_output_tokens,
    'cached_input_tokens', new_cached_input_tokens,
    'cost_amount', new_cost_amount,
    'cost_currency', new_cost_currency
  )::text);

  -- Same row locks as claim: analysis, candidate when SC-010 is present,
  -- company, then attempt. Failure takes no advisory lock.
  select attempts.analysis_id, attempts.company_id, applications.candidate_id
    into target_analysis, target_company, target_candidate
  from public.screening_analysis_attempts attempts
  join public.screening_analysis_versions versions
    on versions.id = attempts.analysis_id and versions.company_id = attempts.company_id
  join public.applications applications
    on applications.id = versions.application_id and applications.company_id = versions.company_id
  where attempts.id = target_attempt;
  if not found then raise exception 'Attempt unavailable' using errcode = '42501'; end if;
  select * into analysis from public.screening_analysis_versions
    where id = target_analysis and company_id = target_company for update;
  if not found then raise exception 'Analysis unavailable' using errcode = '42501'; end if;
  if to_regprocedure('private.erasure_lock_candidate(uuid)') is not null then
    perform private.erasure_lock_candidate(target_candidate);
  end if;
  perform private.sc19_lock_company(target_company);
  select * into attempt from public.screening_analysis_attempts
    where id = target_attempt for update;
  if not found
     or attempt.analysis_id is distinct from target_analysis
     or attempt.company_id is distinct from target_company then
    raise exception 'Attempt unavailable' using errcode = '42501';
  end if;
  if attempt.status = 'failed' then
    if attempt.lease_token_hash = private.screening_hash(provided_lease_token)
      and attempt.finalization_hash = computed_finalization_hash
      then return analysis.id; end if;
    raise exception 'Conflicting failure' using errcode = 'PT409';
  end if;
  if attempt.status <> 'processing'
    or attempt.lease_expires_at <= clock_timestamp()
    or attempt.lease_token_hash <> private.screening_hash(provided_lease_token)
    then raise exception 'Invalid or expired lease' using errcode = '42501'; end if;
  if analysis.execution_status <> 'processing'
    or analysis.input_fingerprint <> expected_input_fingerprint
    or analysis.analysis_contract_hash <> expected_analysis_contract_hash
    then raise exception 'Analysis binding changed' using errcode = 'PT409'; end if;

  update public.screening_analysis_attempts
  set status = 'failed',
    provider_request_id = new_provider_request_id,
    input_tokens = new_input_tokens,
    output_tokens = new_output_tokens,
    cached_input_tokens = new_cached_input_tokens,
    cost_amount = new_cost_amount,
    cost_currency = new_cost_currency,
    error_code = new_error_code,
    finalization_hash = computed_finalization_hash,
    finished_at = clock_timestamp()
  where id = attempt.id;
  update public.screening_analysis_versions
  set execution_status = 'failed',
    failure_code = new_error_code,
    failure_message = new_error_message,
    failed_at = clock_timestamp(),
    completed_at = null,
    updated_at = clock_timestamp()
  where id = analysis.id;
  return analysis.id;
end;
$$;
end
$sc19_claim_lock$;

-- When SC-010 is already installed, publish the next immutable inventory baseline
-- in this same transaction. Billing rows are company accounting: analysis_id is an
-- opaque retained reference with no foreign key to screening_analysis_versions, so
-- candidate purge is not blocked and CV text is not copied into the journal.
-- The rows are known to the schema signature and are not candidate purge adapters.
-- The R5 signature and the four retargeted function bodies are reviewed source.
-- Installation refuses a drifted R4 baseline, a live signature other than the
-- checked-in literal, or a relation missing from that literal. It does not read
-- pg_get_functiondef or the deployment catalog.
do $sc19_erasure$
declare
  role_name text;
  reviewed_r4 constant text := 'd2e7725bd5051e15cb7e700a128026a3ad6f0d87f9d3bba3de8e1539c9d3eabd';
  -- Generated from the clean reviewed migration chain plus this prototype on
  -- PGlite and PostgreSQL 16. Both engines returned the same digest.
  reviewed_r5 constant text := 'e764d74f5563805185807c6a37b5e08659771f2e8534c76df3651c9ea46ea7d9';
  reviewed_tables constant text[] := array[
 'private.candidate_retention_policies',
 'private.candidate_verified_contact_points',
 'private.candidate_verified_contact_receipts',
 'private.contact_audit',
 'private.contact_policy_templates',
 'private.contact_requests',
 'private.contact_trusted_issuers',
 'private.erasure_configuration_requests',
 'private.erasure_inventory_baseline',
 'private.erasure_subject_resolutions',
 'private.sales_lead_attempts',
 'private.sales_lead_closures',
 'private.sales_lead_replay_state',
 'private.sales_lead_settings',
 'private.sales_mail_outbox',
 'private.sales_mail_settings',
 'private.sales_pipeline',
 'private.sales_pipeline_events',
 'private.screening_ranking_policies',
 'public.applications',
 'public.assessment_stages',
 'public.behavior_assessment_entries',
 'public.candidate_assessments',
 'public.candidate_communication_approvals',
 'public.candidate_communication_events',
 'public.candidate_communications',
 'public.candidate_contact_permissions',
 'public.candidate_contact_preferences',
 'public.candidate_documents',
 'public.candidates',
 'public.companies',
 'public.company_members',
 'public.company_profiles',
 'public.exercise_definition_entries',
 'public.exercise_observation_entries',
 'public.platform_operators',
 'public.positions',
 'public.recruitment_shortlist_entries',
 'public.recruitments',
 'public.sales_leads',
 'public.screening_analysis_attempts',
 'public.screening_analysis_versions',
 'public.screening_criterion_results',
 'public.screening_criterion_review_overrides',
 'public.screening_result_reviews',
 'private.erasure_inventory_baseline_r2',
 'private.erasure_inventory_baseline_r3',
 'private.erasure_inventory_baseline_r4',
 'private.erasure_preview_tickets',
 'private.erasure_requests',
 'private.erasure_candidate_lifecycle',
 'private.erasure_lifecycle_events',
 'private.erasure_lifecycle_commands',
 'private.erasure_denial_context',
 'private.erasure_execution_config',
 'private.erasure_executions',
 'private.erasure_verified_ledger_events',
 'private.erasure_restore_checkpoint',
 'private.erasure_holds',
 'private.erasure_purge_manifest',
 'private.erasure_purge_context',
 'private.erasure_purge_context_rows',
 'private.retired_candidate_ids',
 'private.erasure_receipts',
 'private.retention_delegations',
 'private.retention_schedule_commands',
 'private.retention_candidate_clocks',
 'private.retention_suggestions',
 'private.retention_authorizations',
 'private.retention_ticks',
 'private.sc19_balances',
 'private.sc19_trial_nips',
 'private.sc19_trial_approvals',
 'private.sc19_analysis_spend',
 'private.sc19_credit_journal',
 'private.erasure_inventory_baseline_r5'];
begin
  if to_regclass('private.erasure_inventory_baseline_r4') is null
     or to_regprocedure('private.erasure_schema_signature()') is null
     or to_regprocedure('private.contact_immutable()') is null
     or to_regprocedure('public.preview_candidate_erasure(uuid,text,uuid)') is null
     or to_regprocedure('private.prepare_erasure_purge_manifest(uuid)') is null
     or to_regprocedure('private.authorize_retention_suggestion(uuid)') is null
     or to_regprocedure('public.get_retention_schedule(uuid)') is null then
    return;
  end if;
  if (select schema_signature from private.erasure_inventory_baseline_r4 where singleton) is distinct from reviewed_r4 then
    raise exception 'sc19_erasure_baseline_unreviewed' using errcode='55000';
  end if;
  if to_regclass('private.erasure_inventory_baseline_r5') is not null then
    raise exception 'sc19_erasure_baseline_exists' using errcode='55000';
  end if;
  create table private.erasure_inventory_baseline_r5 (
    singleton boolean primary key default true check (singleton),
    schema_signature text not null,
    known_tables text[] not null
  );
  alter table private.erasure_inventory_baseline_r5 enable row level security;
  revoke all on private.erasure_inventory_baseline_r5 from public;
  foreach role_name in array array['anon','authenticated','screening_worker','contact_verifier','erasure_worker','erasure_ledger_attestor','erasure_restore_attestor','erasure_purge_owner','erasure_scheduler']
  loop
    if exists (select 1 from pg_roles where rolname=role_name) then
      execute format('revoke all on private.erasure_inventory_baseline_r5 from %I', role_name);
    end if;
  end loop;
  create trigger immutable_history before update or delete
    on private.erasure_inventory_baseline_r5
    for each row execute function private.contact_immutable();
  insert into private.erasure_inventory_baseline_r5 values (true, reviewed_r5, reviewed_tables);

create or replace function public.preview_candidate_erasure(target_candidate uuid,scope_kind text default 'candidate_record',resolution_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare tenant uuid;subjects uuid[];p private.candidate_retention_policies;r private.erasure_subject_resolutions;
 baseline private.erasure_inventory_baseline_r5;signature text;counts jsonb:='{}';manifest text;row_digest jsonb:='[]';
 blockers text[]:=array['execution_not_provisioned','external_inventory_unverified','backup_policy_unverified','administrative_inventory_pending_execution'];generated timestamptz:=statement_timestamp();
begin
 select company_id into tenant from public.candidates where id=target_candidate;perform private.erasure_owner(tenant);
 if scope_kind is null or scope_kind not in ('candidate_record','confirmed_subject')
 or (scope_kind='candidate_record' and resolution_id is not null) or (scope_kind='confirmed_subject' and resolution_id is null)
 then raise exception using errcode='PT422',message='Invalid preview scope';end if;
 subjects:=array[target_candidate];
 if scope_kind='confirmed_subject' then
  select * into r from private.erasure_subject_resolutions where id=resolution_id and company_id=tenant and anchor_candidate_id=target_candidate;
  if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
  subjects:=r.candidate_ids;
  if r.revision<>(select max(revision) from private.erasure_subject_resolutions where company_id=tenant and anchor_candidate_id=target_candidate)
   or r.confirmed_by<>auth.uid() then blockers:=array_append(blockers,'subject_resolution_changed');end if;
  if cardinality(subjects)<>(select count(*) from public.candidates where company_id=tenant and id=any(subjects)) then
   blockers:=array_append(blockers,'subject_resolution_changed');end if;
 else blockers:=array_append(blockers,'subject_resolution_required');end if;
 select * into p from private.candidate_retention_policies where company_id=tenant order by revision desc limit 1;
 if p.id is null then blockers:=array_append(blockers,'retention_policy_required');
 elsif jsonb_array_length(p.rules)<8 then blockers:=array_append(blockers,'retention_policy_incomplete');end if;
 if p.id is not null and p.approved_by<>auth.uid() then blockers:=array_append(blockers,'policy_owner_changed');end if;
 select * into baseline from private.erasure_inventory_baseline_r5 where singleton;
 signature:=private.erasure_schema_signature();
 if baseline.singleton is null or baseline.known_tables is null or signature is distinct from baseline.schema_signature or exists(
  select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f')
  and not (n.nspname||'.'||c.relname)=any(baseline.known_tables)) then
  blockers:=array_append(blockers,'schema_dependency_unknown');
 else
  if exists(select 1 from private.contact_requests t where t.company_id=tenant
   and private.erasure_contact_request_candidate(t.company_id,t.operation,t.payload,t.result_id) is null) then blockers:=array_append(blockers,'contact_request_adapter_unknown');end if;
  if exists(select 1 from public.screening_analysis_versions a join public.applications ap on ap.company_id=a.company_id and ap.id=a.application_id
   where ap.company_id=tenant and ap.candidate_id=any(subjects) and a.execution_status in ('pending','processing')) then blockers:=array_append(blockers,'active_screening');end if;
  if exists(select 1 from private.erasure_subject_resolutions sr where sr.company_id=tenant and sr.candidate_ids && subjects and not sr.candidate_ids <@ subjects)
   then blockers:=array_append(blockers,'shared_resolution_requires_adapter');end if;
  with rows as materialized(select * from private.erasure_inventory_rows(tenant,subjects)),
  grouped as(select adapter,count(*) n from rows group by adapter)
  select coalesce((select jsonb_object_agg(adapter,n) from grouped),'{}'::jsonb),
   coalesce((select jsonb_agg(jsonb_build_array(adapter,row_key,private.erasure_hash(row_data)) order by adapter,row_key) from rows),'[]'::jsonb)
  into counts,row_digest;
 end if;
 manifest:=private.erasure_hash(jsonb_build_object('contract','sc010-r1-v1','tenant',tenant,'owner',auth.uid(),'scope',scope_kind,'subjects',subjects,
 'resolution',to_jsonb(r),'current_resolution_revision',(select coalesce(max(revision),0) from private.erasure_subject_resolutions where company_id=tenant and anchor_candidate_id=target_candidate),
 'policy',to_jsonb(p),'schema',signature,'rows',row_digest,'blockers',blockers));
 return jsonb_build_object('scope_kind',scope_kind,'candidate_count',cardinality(subjects),'counts',counts,'blockers',to_jsonb(blockers),
 'policy_revision',coalesce(p.revision,0),'resolution_revision',coalesce(r.revision,0),'manifest_hash',manifest,'schema_signature',signature,
 'generated_at',generated,'expires_at',generated+interval '5 minutes','execution_enabled',false);
end;$$;
create or replace function private.prepare_erasure_purge_manifest(target_request uuid) returns jsonb
language plpgsql volatile security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare e private.erasure_executions;digest text;signature text;counts jsonb;baseline text;
begin
 perform private.erasure_check_purge_scope(target_request);
 select * into e from private.erasure_executions where request_id=target_request;
 signature:=private.erasure_schema_signature();
 -- R4 final reviewed baseline is installed by the final migration, never learned at runtime.
 select schema_signature into baseline from private.erasure_inventory_baseline_r5 where singleton;
 if signature is distinct from baseline then raise exception using errcode='PT409',message='Unknown schema dependency';end if;
 select private.erasure_hash(coalesce(jsonb_agg(jsonb_build_array(adapter,row_key,private.erasure_hash(row_data)) order by adapter,row_key),'[]'::jsonb)) into digest from private.erasure_purge_rows(e.company_id,e.candidate_ids);
 insert into private.erasure_purge_manifest
 select target_request,digest,adapter,row_key,private.erasure_hash(row_data) from private.erasure_purge_rows(e.company_id,e.candidate_ids) on conflict do nothing;
 select coalesce(jsonb_object_agg(adapter,n),'{}'::jsonb) into counts from(select adapter,count(*) n from private.erasure_purge_rows(e.company_id,e.candidate_ids) group by adapter)c;
 return jsonb_build_object('manifest_hash',digest,'schema_signature',signature,'counts',counts);
end;$$;
create or replace function private.authorize_retention_suggestion(target_suggestion uuid) returns uuid
language plpgsql volatile security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare s private.retention_suggestions;d private.retention_delegations;r private.erasure_subject_resolutions;p jsonb;ticket uuid;result uuid;issued timestamptz;authz jsonb;
begin
 select * into s from private.retention_suggestions where id=target_suggestion for update nowait;
 select * into d from private.retention_delegations where id=s.delegation_id;
 if d.execution_mode<>'automatic' then raise exception using errcode='PT409',message='Automatic delegation required';end if;
 perform private.erasure_execution_gate(false);
 if private.erasure_schema_signature() is distinct from (select schema_signature from private.erasure_inventory_baseline_r5 where singleton) then raise exception using errcode='PT409',message='Unknown schema dependency';end if;
 p:=private.evaluate_retention_subject(s.resolution_id,d.id);
 if p->'blockers'<>'[]'::jsonb or p->>'evidence_hash'<>s.evidence_hash then raise exception using errcode='PT409',message='Retention eligibility changed';end if;
 if exists(select 1 from unnest(s.candidate_ids) x(id) where private.erasure_candidate_frozen(x.id)) then raise exception using errcode='PT409',message='Candidate workflow frozen';end if;
 select * into r from private.erasure_subject_resolutions where id=s.resolution_id;
 -- Fixed graph checks, with unknown schema/JSON/dependencies rejected by the R3 adapter before commit.
 if exists(select 1 from private.contact_requests c where c.company_id=s.company_id and private.erasure_contact_request_candidate(c.company_id,c.operation,c.payload,c.result_id) is null) then raise exception using errcode='PT409',message='Unknown candidate dependency';end if;
 issued:=clock_timestamp();
 insert into private.erasure_preview_tickets(company_id,actor_id,anchor_candidate_id,scope_kind,resolution_id,candidate_ids,manifest_hash,generations,created_at,expires_at)
 values(s.company_id,d.owner_id,r.anchor_candidate_id,'confirmed_subject',r.id,s.candidate_ids,s.evidence_hash,private.erasure_generation_snapshot(s.candidate_ids),issued,issued+interval '5 minutes') returning id into ticket;
 insert into private.erasure_requests(company_id,actor_id,anchor_candidate_id,candidate_ids,scope_kind,preview_ticket_id,manifest_hash,policy_revision,resolution_revision,status,generation)
 values(s.company_id,d.owner_id,r.anchor_candidate_id,s.candidate_ids,'confirmed_subject',ticket,s.evidence_hash,d.policy_revision,r.revision,'authorized',1) returning id into result;
 insert into private.erasure_candidate_lifecycle(candidate_id,company_id,generation,status,request_id)
 select id,s.company_id,1,'frozen',result from unnest(s.candidate_ids) x(id)
 on conflict(candidate_id) do update set generation=erasure_candidate_lifecycle.generation+1,status='frozen',request_id=excluded.request_id;
 authz:=jsonb_build_object('kind','retention_policy','actor_id',d.owner_id,'delegation_id',d.id,'activation_revision',d.revision,'policy_revision',d.policy_revision,'due_generation',s.due_generation,'due_at',s.due_at,'evidence_hash',s.evidence_hash);
 insert into private.retention_authorizations(request_id,authorization_json) values(result,authz);
 update private.retention_suggestions set status='authorized',request_id=result,blockers='[]'::jsonb where id=s.id;
 insert into private.erasure_lifecycle_events(company_id,request_id,actor_id,event,generation) values(s.company_id,result,d.owner_id,'authorized',1);
 -- Reuse the complete reviewed R3 scope validator inside this transaction. This
 -- temporary non-exportable execution never receives a reservation or ledger ACK.
 insert into private.erasure_executions(request_id,company_id,candidate_ids,scope_kind,owner_id,policy_copy,resolution_revision,generation,phase,recovery_retain_until)
 select result,s.company_id,s.candidate_ids,'confirmed_subject',d.owner_id,jsonb_build_object('revision',p2.revision,'rules',p2.rules),r.revision,1,'authorized',clock_timestamp()+interval '1 second'
 from private.candidate_retention_policies p2 where p2.id=d.policy_id;
 perform private.erasure_check_purge_scope(result);
 delete from private.erasure_executions where request_id=result;
 return result;
end;$$;
create or replace function public.get_retention_schedule(target_company uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare d private.retention_delegations;t private.retention_ticks;c private.erasure_execution_config;p private.candidate_retention_policies;schema_ok boolean;begin
 perform private.erasure_owner(target_company);
 select * into d from private.retention_delegations where company_id=target_company order by revision desc limit 1;
 select * into t from private.retention_ticks where company_id=target_company order by created_at desc,id desc limit 1;
 select * into c from private.erasure_execution_config where singleton;
 select * into p from private.candidate_retention_policies where company_id=target_company order by revision desc limit 1;
 schema_ok:=private.erasure_schema_signature() is not distinct from (select schema_signature from private.erasure_inventory_baseline_r5 where singleton);
 return jsonb_build_object('revision',coalesce(d.revision,0),'delegation_id',d.id,'policy_revision',d.policy_revision,'execution_mode',coalesce(d.execution_mode,'suggest_only'),
 'max_batch',coalesce(d.max_batch,25),'revoked',coalesce(d.revoked,true),'owner_current',d.owner_id is not distinct from auth.uid(),
 'authorization_enabled',coalesce(schema_ok and not d.revoked and d.execution_mode='automatic' and d.owner_id=auth.uid() and d.policy_id=p.id and d.policy_revision=p.revision and p.approved_by=auth.uid()
  and c.enabled and c.external_inventory_verified and c.backup_horizon_days is not null and c.artifact_horizon_days is not null and c.retention_margin_days is not null and not c.restore_isolated,false),
 'production_ready',false,
 'blockers',case when c.enabled and c.external_inventory_verified and c.backup_horizon_days is not null and c.artifact_horizon_days is not null and c.retention_margin_days is not null and not c.restore_isolated then '[]'::jsonb else jsonb_build_array('execution_not_provisioned') end || case when schema_ok then '[]'::jsonb else jsonb_build_array('schema_dependency_unknown') end,
 'oldest_pending_at',(select min(created_at) from (select created_at from private.erasure_executions where company_id=target_company and phase in ('authorized','erasing') union all select r.created_at from private.erasure_requests r where r.company_id=target_company and r.status='authorized' and not exists(select 1 from private.erasure_executions e where e.request_id=r.id)) pending),
 'expired_leases',(select count(*) from private.erasure_executions where company_id=target_company and (pending_phase is not null or (phase='erasing' and not local_purged)) and lease_until<clock_timestamp()),
 'last_tick_at',t.created_at,'lag_seconds',case when t.id is null then null else greatest(0,floor(extract(epoch from statement_timestamp()-t.created_at))) end,
 'suggestions',(select count(*) from private.retention_suggestions where company_id=target_company and status='suggested'),
 'authorized',(select count(*) from private.retention_suggestions where company_id=target_company and status='authorized'),
 'blocked',(select count(*) from private.retention_suggestions where company_id=target_company and status='blocked'),
 'holds',(select count(*) from private.erasure_holds where company_id=target_company and released_at is null));
end;$$;

  if exists (select 1 from pg_proc where prosrc like '%erasure_inventory_baseline_r4%') then
    raise exception 'sc19_erasure_baseline_not_retargeted' using errcode='55000';
  end if;
  if private.erasure_schema_signature() is distinct from reviewed_r5 then
    raise exception 'sc19_erasure_signature_mismatch:%', private.erasure_schema_signature() using errcode='55000';
  end if;
  if exists (
    select 1 from pg_class relation
    join pg_namespace namespace on namespace.oid=relation.relnamespace
    where namespace.nspname in ('public','private')
      and relation.relkind in ('r','p','f')
      and not (namespace.nspname||'.'||relation.relname) = any (reviewed_tables)
  ) then
    raise exception 'sc19_erasure_inventory_gap' using errcode='55000';
  end if;
end
$sc19_erasure$;
commit;
