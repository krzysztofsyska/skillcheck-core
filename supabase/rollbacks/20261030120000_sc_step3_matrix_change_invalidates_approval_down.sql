-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Restores the Step 3 row review function and the pre-Step 3 approval function.
begin;
create or replace function public.review_screening_evidence_row(
  target_company uuid,
  target_analysis uuid,
  target_criterion uuid,
  expected_updated_at timestamptz,
  next_status text,
  next_note text default null,
  next_verdict text default null,
  next_missing_info text default null,
  next_question text default null,
  next_evidence jsonb default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  analysis public.screening_analysis_versions%rowtype;
  row_data public.screening_criterion_results%rowtype;
  effective_verdict text;
  effective_evidence jsonb;
begin
  if actor is null or not private.has_company_access(target_company, true) then
    raise exception 'No write access' using errcode = '42501';
  end if;
  if next_status not in ('unreviewed','accepted','rejected','edited')
    or length(coalesce(next_note,'')) > 10000
    or length(coalesce(next_missing_info,'')) > 4000
    or length(coalesce(next_question,'')) > 4000
    or next_verdict is not null and next_verdict not in ('supported','partial','missing','contradicted')
    then raise exception 'Invalid row review' using errcode = '22023'; end if;

  select * into analysis from public.screening_analysis_versions
  where company_id = target_company and id = target_analysis;
  if not found then raise exception 'Analysis not found' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('screening:' || analysis.application_id::text, 0));
  select * into analysis from public.screening_analysis_versions
  where company_id = target_company and id = target_analysis for update;
  if not found or analysis.execution_status <> 'completed' or analysis.stale_at is not null
    or private.screening_stale_reason(analysis.id) is not null
    or exists (select 1 from public.screening_analysis_versions later
      where later.company_id = target_company and later.application_id = analysis.application_id
        and later.analysis_version > analysis.analysis_version)
    then raise exception 'Result is not current' using errcode = '55000'; end if;
  select * into row_data from public.screening_criterion_results
  where company_id = target_company and analysis_id = target_analysis and id = target_criterion for update;
  if not found then raise exception 'Criterion not found' using errcode = '42501'; end if;
  if row_data.updated_at is distinct from expected_updated_at
    then raise exception 'Review changed' using errcode = 'PT409'; end if;
  if row_data.verdict is null
    then raise exception 'Legacy results cannot be reviewed as evidence matrix' using errcode = '55000'; end if;
  if next_status <> 'edited' and (next_verdict is not null or next_missing_info is not null
    or next_question is not null or next_evidence is not null)
    then raise exception 'Edits require edited status' using errcode = '22023'; end if;
  effective_verdict := case when next_status = 'edited' then coalesce(next_verdict, row_data.verdict)
    else row_data.verdict end;
  effective_evidence := case when next_status = 'edited' then coalesce(next_evidence, row_data.evidence)
    else row_data.evidence end;
  if not private.screening_valid_evidence(
      analysis.input_cv_text_snapshot, effective_evidence, effective_verdict <> 'missing'
    ) or (effective_verdict = 'missing' and jsonb_array_length(effective_evidence) <> 0)
    then raise exception 'Evidence and verdict mismatch' using errcode = '22023'; end if;
  update public.screening_criterion_results
  set human_status = next_status,
      human_note = nullif(btrim(next_note),''),
      human_verdict = case when next_status = 'edited' then next_verdict else null end,
      human_missing_info = case when next_status = 'edited' then next_missing_info else null end,
      human_suggested_question = case when next_status = 'edited' then next_question else null end,
      human_evidence = case when next_status = 'edited' then next_evidence else null end,
      updated_by = actor, updated_at = clock_timestamp()
  where company_id = target_company and analysis_id = target_analysis and id = target_criterion;
  return target_criterion;
end;
$$;
revoke all on function public.review_screening_evidence_row(uuid,uuid,uuid,timestamptz,text,text,text,text,text,jsonb)
  from public, anon, authenticated, screening_worker;
grant execute on function public.review_screening_evidence_row(uuid,uuid,uuid,timestamptz,text,text,text,text,text,jsonb)
  to authenticated;

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
  perform private.erasure_lock_candidate(candidate_id) from public.applications where id=analysis.application_id;
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
revoke all on function public.review_screening_result(uuid,integer,text,text,jsonb)
  from public, anon, authenticated, screening_worker;
grant execute on function public.review_screening_result(uuid,integer,text,text,jsonb)
  to authenticated;
commit;
