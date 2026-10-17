begin;

-- SC-007: close the start-versus-retry race on one application, input and
-- contract. retry_screening_analysis locked the failed analysis row before the
-- application advisory lock, so start_screening_analysis could commit a new
-- active version first. Retry then reactivated the failed row and raised
-- unique_violation (23505) on screening_analysis_active_contract_idx.
--
-- After the advisory lock is held, an active logical analysis for the same
-- fingerprint and contract is returned. A unique violation that still escapes
-- becomes PT409. Signature, RLS and grants stay as they were. This file is not
-- applied to production by SC-007.

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
  select * into analysis from public.screening_analysis_versions
    where id = target_analysis for update;
  if not found or not private.has_company_access(analysis.company_id, true)
    then raise exception 'No write access' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('screening:' || analysis.application_id::text, 0));

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

commit;
