-- SC-006: serialize review/retry with start and reject historical mutations.
-- CREATE OR REPLACE preserves existing ACLs; no production apply in this task.
begin;

create or replace function public.review_screening_result(
  target_analysis uuid,
  expected_review_version integer,
  new_disposition text,
  new_review_note text,
  new_overrides jsonb default '[]'::jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  analysis public.screening_analysis_versions%rowtype;
  review_id uuid;
  override_item jsonb;
  criterion public.screening_criterion_results%rowtype;
  rating text;
  evidence jsonb;
  explanation text;
  detected_stale_reason text;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if expected_review_version is null or expected_review_version < 0
    or new_disposition not in ('approved', 'approved_with_changes', 'needs_reanalysis')
    or length(coalesce(new_review_note, '')) > 10000
    or jsonb_typeof(new_overrides) is distinct from 'array'
    then raise exception 'Invalid review' using errcode = '22023'; end if;

  -- Authorize before taking a lock on tenant data; match start's lock order.
  select * into analysis from public.screening_analysis_versions
    where id = target_analysis;
  if not found or not private.has_company_access(analysis.company_id, true)
    then raise exception 'No write access' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('screening:' || analysis.application_id::text, 0));
  select * into analysis from public.screening_analysis_versions
    where id = target_analysis for update;
  if not found or not private.has_company_access(analysis.company_id, true)
    then raise exception 'No write access' using errcode = '42501'; end if;
  if exists (
    select 1 from public.screening_analysis_versions newer
    where newer.company_id = analysis.company_id
      and newer.application_id = analysis.application_id
      and newer.analysis_version > analysis.analysis_version
  ) then raise exception 'Analysis superseded' using errcode = 'PT409'; end if;

  if analysis.execution_status <> 'completed'
    then raise exception 'Only completed results can be reviewed' using errcode = '55000'; end if;

  detected_stale_reason := private.screening_stale_reason(analysis.id);
  if detected_stale_reason is not null and analysis.stale_at is null then
    update public.screening_analysis_versions
      set stale_at = clock_timestamp(), stale_reason = detected_stale_reason,
        updated_at = clock_timestamp()
      where id = analysis.id;
    analysis.stale_at := clock_timestamp();
    analysis.stale_reason := detected_stale_reason;
  end if;
  if analysis.latest_review_version <> expected_review_version
    then raise exception 'Review changed' using errcode = 'PT409'; end if;
  if analysis.stale_at is not null
    and (new_disposition <> 'needs_reanalysis' or jsonb_array_length(new_overrides) <> 0)
    then raise exception 'Stale result requires reanalysis' using errcode = '55000'; end if;
  if (new_disposition = 'approved_with_changes' and jsonb_array_length(new_overrides) = 0)
    or (new_disposition in ('approved', 'needs_reanalysis')
      and jsonb_array_length(new_overrides) <> 0)
    then raise exception 'Overrides do not match disposition' using errcode = '22023'; end if;

  for override_item in select value from jsonb_array_elements(new_overrides) loop
    if jsonb_typeof(override_item) is distinct from 'object'
      or exists (
        select 1 from jsonb_object_keys(override_item) key
        where key not in (
          'criterion_result_id', 'rating_override',
          'evidence_override', 'explanation_override'
        )
      )
      or jsonb_typeof(override_item->'criterion_result_id') is distinct from 'string'
      or (override_item ? 'rating_override'
        and jsonb_typeof(override_item->'rating_override') not in ('string', 'null'))
      or (override_item ? 'evidence_override'
        and jsonb_typeof(override_item->'evidence_override') not in ('array', 'null'))
      or (override_item ? 'explanation_override'
        and jsonb_typeof(override_item->'explanation_override') not in ('string', 'null'))
      then raise exception 'Invalid review override' using errcode = '22023'; end if;
    begin
      select * into criterion from public.screening_criterion_results
      where id = (override_item->>'criterion_result_id')::uuid
        and company_id = analysis.company_id and analysis_id = analysis.id;
    exception when invalid_text_representation then
      raise exception 'Invalid criterion reference' using errcode = '22023';
    end;
    if not found then raise exception 'Criterion does not belong to analysis' using errcode = '22023'; end if;
    rating := coalesce(override_item->>'rating_override', criterion.rating);
    evidence := case when override_item ? 'evidence_override'
      and jsonb_typeof(override_item->'evidence_override') <> 'null'
      then override_item->'evidence_override' else criterion.evidence end;
    explanation := override_item->>'explanation_override';
    if not (override_item ? 'rating_override'
      or override_item ? 'evidence_override'
      or override_item ? 'explanation_override')
      or rating not in ('insufficient_data', 'below', 'meets', 'above')
      or length(coalesce(explanation, '')) > 4000
      or not private.screening_valid_evidence(
        analysis.input_cv_text_snapshot, evidence, rating <> 'insufficient_data'
      ) then raise exception 'Invalid review evidence' using errcode = '22023'; end if;
  end loop;
  if (
    select count(distinct value->>'criterion_result_id')
    from jsonb_array_elements(new_overrides)
  ) <> jsonb_array_length(new_overrides)
    then raise exception 'Duplicate review override' using errcode = '22023'; end if;

  insert into public.screening_result_reviews(
    company_id, analysis_id, review_version, reviewer_id,
    disposition, review_note
  ) values (
    analysis.company_id, analysis.id, expected_review_version + 1, actor,
    new_disposition, nullif(btrim(new_review_note), '')
  ) returning id into review_id;

  for override_item in select value from jsonb_array_elements(new_overrides) loop
    insert into public.screening_criterion_review_overrides(
      company_id, review_id, criterion_result_id,
      rating_override, evidence_override, explanation_override
    ) values (
      analysis.company_id,
      review_id,
      (override_item->>'criterion_result_id')::uuid,
      override_item->>'rating_override',
      case when override_item ? 'evidence_override'
        and jsonb_typeof(override_item->'evidence_override') <> 'null'
        then override_item->'evidence_override' else null end,
      override_item->>'explanation_override'
    );
  end loop;
  update public.screening_analysis_versions
    set latest_review_version = expected_review_version + 1,
      updated_at = clock_timestamp()
    where id = analysis.id;
  return review_id;
end;
$$;

create or replace function public.retry_screening_analysis(
  target_analysis uuid,
  request_idempotency_key uuid
) returns table (
  analysis_id uuid,
  attempt_id uuid,
  analysis_version integer
) language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  analysis public.screening_analysis_versions%rowtype;
  material jsonb;
  existing_attempt public.screening_analysis_attempts%rowtype;
  active_peer public.screening_analysis_versions%rowtype;
  next_attempt integer;
  next_version integer;
  new_analysis_id uuid;
  new_attempt_id uuid;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if target_analysis is null or request_idempotency_key is null
    then raise exception 'Invalid retry request' using errcode = '22023'; end if;
  -- Authorize before taking a lock on tenant data; match start's lock order.
  select * into analysis from public.screening_analysis_versions
    where id = target_analysis;
  if not found or not private.has_company_access(analysis.company_id, true)
    then raise exception 'No write access' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('screening:' || analysis.application_id::text, 0));
  select * into analysis from public.screening_analysis_versions
    where id = target_analysis for update;
  if not found or not private.has_company_access(analysis.company_id, true)
    then raise exception 'No write access' using errcode = '42501'; end if;

  select * into existing_attempt from public.screening_analysis_attempts
    where company_id = analysis.company_id and idempotency_key = request_idempotency_key;
  if found then
    if existing_attempt.analysis_id <> analysis.id
      then raise exception 'Idempotency key conflict' using errcode = 'PT409'; end if;
    return query select analysis.id, existing_attempt.id, analysis.analysis_version;
    return;
  end if;
  if analysis.execution_status not in ('failed', 'pending')
    or exists (
      select 1 from public.screening_analysis_attempts attempt
      where attempt.company_id = analysis.company_id and attempt.analysis_id = analysis.id
        and attempt.status in ('pending', 'processing')
    ) then raise exception 'Analysis cannot be retried' using errcode = '55000'; end if;

  material := private.screening_material(analysis.application_id, true);
  select * into active_peer
  from public.screening_analysis_versions peer
  where peer.company_id = analysis.company_id
    and peer.application_id = analysis.application_id
    and peer.id <> analysis.id
    and peer.input_fingerprint = material->>'input_fingerprint'
    and peer.analysis_contract_hash = analysis.analysis_contract_hash
    and peer.execution_status in ('pending', 'processing')
  order by peer.analysis_version desc
  limit 1;
  if found then
    select * into existing_attempt
    from public.screening_analysis_attempts attempt
    where attempt.company_id = active_peer.company_id
      and attempt.analysis_id = active_peer.id
      and attempt.status in ('pending', 'processing')
    order by attempt.attempt_no desc
    limit 1;
    if not found then raise exception 'Analysis cannot be retried' using errcode = '55000'; end if;
    return query select active_peer.id, existing_attempt.id, active_peer.analysis_version;
    return;
  end if;

  if exists (
    select 1 from public.screening_analysis_versions newer
    where newer.company_id = analysis.company_id
      and newer.application_id = analysis.application_id
      and newer.analysis_version > analysis.analysis_version
  ) then raise exception 'Analysis superseded' using errcode = 'PT409'; end if;

  begin
    if material->>'input_fingerprint' = analysis.input_fingerprint then
      select coalesce(max(item.attempt_no), 0) + 1 into next_attempt
        from public.screening_analysis_attempts item
        where item.company_id = analysis.company_id and item.analysis_id = analysis.id;
      insert into public.screening_analysis_attempts(
        company_id, analysis_id, attempt_no, idempotency_key
      ) values (
        analysis.company_id, analysis.id, next_attempt, request_idempotency_key
      ) returning id into new_attempt_id;
      update public.screening_analysis_versions
        set execution_status = 'pending', failed_at = null,
          failure_code = null, failure_message = null, updated_at = clock_timestamp()
        where id = analysis.id;
      return query select analysis.id, new_attempt_id, analysis.analysis_version;
      return;
    end if;

    update public.screening_analysis_versions
      set stale_at = coalesce(stale_at, clock_timestamp()),
        stale_reason = coalesce(screening_analysis_versions.stale_reason,
          private.screening_stale_reason(analysis.id), 'manual_invalidation'),
        updated_at = clock_timestamp()
      where id = analysis.id;
    select coalesce(max(item.analysis_version), 0) + 1 into next_version
      from public.screening_analysis_versions item
      where item.company_id = analysis.company_id and item.application_id = analysis.application_id;
    insert into public.screening_analysis_versions(
      company_id, recruitment_id, application_id, position_id,
      candidate_document_id, candidate_document_version, analysis_version,
      input_fingerprint, analysis_contract_hash, payload_schema_version,
      result_schema_version, prompt_version, provider, model, model_revision,
      input_cv_text_snapshot, criteria_snapshot, binding_snapshot, created_by
    ) values (
      analysis.company_id,
      (material->>'recruitment_id')::uuid,
      analysis.application_id,
      (material->>'position_id')::uuid,
      (material->>'candidate_document_id')::uuid,
      (material->>'candidate_document_version')::integer,
      next_version,
      material->>'input_fingerprint',
      analysis.analysis_contract_hash,
      analysis.payload_schema_version,
      analysis.result_schema_version,
      analysis.prompt_version,
      analysis.provider,
      analysis.model,
      analysis.model_revision,
      material->>'input_cv_text_snapshot',
      material->'criteria_snapshot',
      material->'binding_snapshot',
      actor
    ) returning id into new_analysis_id;
    insert into public.screening_analysis_attempts(
      company_id, analysis_id, attempt_no, idempotency_key
    ) values (
      analysis.company_id, new_analysis_id, 1, request_idempotency_key
    ) returning id into new_attempt_id;
    return query select new_analysis_id, new_attempt_id, next_version;
  exception
    when unique_violation then
      select * into existing_attempt
      from public.screening_analysis_attempts attempt
      where attempt.company_id = analysis.company_id
        and attempt.idempotency_key = request_idempotency_key;
      if found then
        if existing_attempt.analysis_id <> analysis.id
          then raise exception 'Idempotency key conflict' using errcode = 'PT409'; end if;
        return query select analysis.id, existing_attempt.id, analysis.analysis_version;
        return;
      end if;

      select * into active_peer
      from public.screening_analysis_versions peer
      where peer.company_id = analysis.company_id
        and peer.application_id = analysis.application_id
        and peer.id <> analysis.id
        and peer.input_fingerprint = material->>'input_fingerprint'
        and peer.analysis_contract_hash = analysis.analysis_contract_hash
        and peer.execution_status in ('pending', 'processing')
      order by peer.analysis_version desc
      limit 1;
      if found then
        select * into existing_attempt
        from public.screening_analysis_attempts attempt
        where attempt.company_id = active_peer.company_id
          and attempt.analysis_id = active_peer.id
          and attempt.status in ('pending', 'processing')
        order by attempt.attempt_no desc
        limit 1;
        if found then
          return query select active_peer.id, existing_attempt.id, active_peer.analysis_version;
          return;
        end if;
      end if;
      raise exception 'Screening concurrency conflict' using errcode = 'PT409';
  end;
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

  -- Serialize finalization with start/review/retry before taking row locks.
  select * into attempt from public.screening_analysis_attempts where id = target_attempt;
  if not found then raise exception 'Attempt unavailable' using errcode = '42501'; end if;
  select * into analysis from public.screening_analysis_versions
    where id = attempt.analysis_id and company_id = attempt.company_id;
  if not found then raise exception 'Analysis unavailable' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('screening:' || analysis.application_id::text, 0));
  select * into attempt from public.screening_analysis_attempts
    where id = target_attempt for update;
  if not found then raise exception 'Attempt unavailable' using errcode = '42501'; end if;
  select * into analysis from public.screening_analysis_versions
    where id = attempt.analysis_id and company_id = attempt.company_id for update;
  if not found then raise exception 'Analysis unavailable' using errcode = '42501'; end if;

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


commit;
