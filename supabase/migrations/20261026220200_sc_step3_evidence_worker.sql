-- SC evidence v2: transactional completion reuses legacy leases/locks and CV validator.
begin;
drop function public.claim_screening_attempt(uuid);
create function public.claim_screening_attempt(target_attempt uuid)
returns table (
  analysis_id uuid,
  candidate_document_id uuid,
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
    analysis.candidate_document_id,
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

revoke all on function public.claim_screening_attempt(uuid) from public, anon, authenticated, screening_worker;
grant execute on function public.claim_screening_attempt(uuid) to screening_worker;

create function public.complete_screening_evidence(
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
  a public.screening_analysis_versions%rowtype;
  row_item jsonb;
  citation jsonb;
  clean_evidence jsonb;
  legacy_findings jsonb := '[]'::jsonb;
  finished_id uuid;
begin
  select analysis.* into a from public.screening_analysis_versions analysis
    join public.screening_analysis_attempts attempt
      on attempt.company_id = analysis.company_id and attempt.analysis_id = analysis.id
    where attempt.id = target_attempt;
  if not found or a.result_schema_version <> 2
    or jsonb_typeof(findings) is distinct from 'array'
    or jsonb_array_length(findings) <> jsonb_array_length(a.criteria_snapshot)
    then raise exception 'Invalid evidence result' using errcode = '22023'; end if;
  for row_item in select value from jsonb_array_elements(findings) loop
    if jsonb_typeof(row_item) is distinct from 'object'
      or exists (select 1 from jsonb_object_keys(row_item) key
        where key not in ('criterion_id','verdict','evidence','missing_info','suggested_question','explanation'))
      or row_item->>'verdict' not in ('supported','partial','missing','contradicted')
      or jsonb_typeof(row_item->'evidence') is distinct from 'array'
      or length(coalesce(row_item->>'missing_info','')) > 4000
      or length(coalesce(row_item->>'suggested_question','')) > 4000
      or length(coalesce(row_item->>'explanation','')) > 4000
      then raise exception 'Invalid evidence row' using errcode = '22023'; end if;
    clean_evidence := '[]'::jsonb;
    for citation in select value from jsonb_array_elements(row_item->'evidence') loop
      if jsonb_typeof(citation) is distinct from 'object'
        or exists (select 1 from jsonb_object_keys(citation) key
          where key not in ('start','end','quote','document_id'))
        or citation->>'document_id' is distinct from a.candidate_document_id::text
        then raise exception 'Citation refers to another source' using errcode = '22023'; end if;
      clean_evidence := clean_evidence || jsonb_build_array(jsonb_build_object(
        'start', citation->'start', 'end', citation->'end', 'quote', citation->'quote'
      ));
    end loop;
    if not private.screening_valid_evidence(a.input_cv_text_snapshot, clean_evidence, row_item->>'verdict' <> 'missing')
      or (row_item->>'verdict' = 'missing' and jsonb_array_length(clean_evidence) <> 0)
      then raise exception 'Invalid verified quote' using errcode = '22023'; end if;
    -- Evidence states have NO safe mathematical mapping to performance ratings.
    -- Always use neutral legacy rating so existing shortlist code cannot score v2.
    legacy_findings := legacy_findings || jsonb_build_array(jsonb_build_object(
      'criterion_id', row_item->>'criterion_id', 'rating', 'insufficient_data',
      'evidence', clean_evidence, 'explanation', row_item->'explanation'
    ));
  end loop;
  finished_id := public.complete_screening_analysis(
    target_attempt, provided_lease_token, expected_input_fingerprint,
    expected_analysis_contract_hash, legacy_findings,
    new_provider_request_id, new_provider_response_id, new_input_tokens,
    new_output_tokens, new_cached_input_tokens, new_cost_amount, new_cost_currency
  );
  for row_item in select value from jsonb_array_elements(findings) loop
    update public.screening_criterion_results result
    set verdict = row_item->>'verdict',
        missing_info = nullif(row_item->>'missing_info',''),
        suggested_question = nullif(row_item->>'suggested_question','')
    where result.company_id = a.company_id and result.analysis_id = finished_id
      and result.criterion_id = row_item->>'criterion_id';
    if not found then raise exception 'Criterion not found' using errcode = '22023'; end if;
  end loop;
  return finished_id;
end;
$$;
revoke all on function public.complete_screening_evidence(uuid,text,text,text,jsonb,text,text,integer,integer,integer,numeric,text)
  from public, anon, authenticated, screening_worker;
grant execute on function public.complete_screening_evidence(uuid,text,text,text,jsonb,text,text,integer,integer,integer,numeric,text)
  to screening_worker;
commit;
