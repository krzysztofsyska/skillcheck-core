begin;

-- SC-005: extend worker claim with the immutable analysis payload.
-- Does not change tables, RLS, or authenticated grants. Not applied to production
-- from this branch.

drop function if exists public.claim_screening_attempt(uuid);

create function public.claim_screening_attempt(target_attempt uuid)
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
begin
  select * into attempt from public.screening_analysis_attempts
    where id = target_attempt for update;
  if not found then raise exception 'Attempt unavailable' using errcode = '42501'; end if;
  select * into analysis from public.screening_analysis_versions
    where id = attempt.analysis_id and company_id = attempt.company_id for update;
  if not found then raise exception 'Analysis unavailable' using errcode = '42501'; end if;
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

revoke all on function public.claim_screening_attempt(uuid)
  from public, anon, authenticated, screening_worker;
grant execute on function public.claim_screening_attempt(uuid)
  to screening_worker;

commit;
