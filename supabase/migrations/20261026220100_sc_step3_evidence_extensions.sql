-- SC Step 3: additive changes to the existing tenant-scoped screening model.
-- Legacy results retain verdict = NULL; no reinterpretation of v1 ratings.
begin;

alter table public.screening_criterion_results
  add column verdict text check (verdict is null or verdict in ('supported','partial','missing','contradicted')),
  add column missing_info text check (missing_info is null or length(missing_info) <= 4000),
  add column suggested_question text check (suggested_question is null or length(suggested_question) <= 4000),
  add column human_status text not null default 'unreviewed'
    check (human_status in ('unreviewed','accepted','rejected','edited')),
  add column human_note text check (human_note is null or length(human_note) <= 10000),
  add column human_verdict text check (human_verdict is null or human_verdict in ('supported','partial','missing','contradicted')),
  add column human_missing_info text check (human_missing_info is null or length(human_missing_info) <= 4000),
  add column human_suggested_question text check (human_suggested_question is null or length(human_suggested_question) <= 4000),
  add column human_evidence jsonb check (human_evidence is null or jsonb_typeof(human_evidence) = 'array'),
  add column updated_by uuid references auth.users(id) on delete set null,
  add column updated_at timestamptz;

-- Existing read RLS: screening_criterion_read USING (private.has_company_access(company_id)).
-- Maintain NO direct INSERT/UPDATE/DELETE grants for authenticated. RPC is the only write.
alter table public.screening_criterion_results enable row level security;
revoke insert, update, delete on public.screening_criterion_results from public, anon, authenticated;
grant select on public.screening_criterion_results to authenticated;

create function public.review_screening_evidence_row(
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
commit;
