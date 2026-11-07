-- #233: individual screening gets the same provisional group as bulk intake.
-- Functions only: no schema/trigger/table change, erasure inventory unchanged.
-- No historical backfill; only newly completed single analyses are grouped.
begin;

create function private.screening_apply_single_group(target_application uuid, target_analysis uuid) returns void
language plpgsql security definer set search_path='' as $$
declare a public.screening_analysis_versions; app public.applications; total integer;
begin
  select * into app from public.applications where id=target_application;
  select * into a from public.screening_analysis_versions where id=target_analysis;
  if app.id is null or a.id is null or a.application_id is distinct from app.id
    or a.company_id is distinct from app.company_id or a.recruitment_id is distinct from app.recruitment_id
    or a.execution_status <> 'completed' or a.stale_at is not null
    or exists(select 1 from public.screening_analysis_versions newer where newer.application_id=app.id
      and newer.company_id=app.company_id and newer.analysis_version>a.analysis_version)
    -- Bulk settlement retains its own guarded lifecycle and notifications.
    or exists(select 1 from private.cv_bulk_items where application_id=app.id and analysis_id=a.id)
    then return; end if;
  -- Finalizers already hold candidate -> analysis -> company locks. Rechecking
  -- the erasure guard is reentrant and ensures no path writes frozen data.
  perform private.erasure_lock_candidate(app.candidate_id);
  if exists(select 1 from private.application_preselection_groups where application_id=app.id and analysis_id=a.id)
    then return; end if; -- idempotent v2 replay, including manual placement
  select count(*) into total from public.screening_criterion_results r
    where r.analysis_id=a.id and r.company_id=a.company_id;
  if total=0 or total<>jsonb_array_length(a.criteria_snapshot)
    or exists(select 1 from public.screening_criterion_results r where r.analysis_id=a.id
      and (r.company_id is distinct from a.company_id or (a.result_schema_version=2 and r.verdict is null)))
    then return; end if;
  perform private.cv_bulk_apply_auto_group(app.id,a.id);
end;$$;
revoke all on function private.screening_apply_single_group(uuid,uuid) from public,anon,authenticated,screening_worker;

-- Patch only the final return, after all rows and final status are persisted.
-- v2 delegates to v1 before its verdict rows are set, so v1 groups only v1.
-- pg_get_functiondef preserves existing ACLs, arguments, security and guards.
do $install$
declare definition text; anchor text; replacement text;
begin
  definition:=pg_get_functiondef('public.complete_screening_analysis(uuid,text,text,text,jsonb,text,text,integer,integer,integer,numeric,text)'::regprocedure);
  anchor:=E'  return analysis.id;\nexception';
  replacement:=E'  if analysis.result_schema_version = 1 then\n    perform private.screening_apply_single_group(analysis.application_id,analysis.id);\n  end if;\n  return analysis.id;\nexception';
  if position(anchor in definition)=0 or position('screening_apply_single_group' in definition)>0 then
    raise exception 'single_group_unexpected_v1_definition' using errcode='55000'; end if;
  execute replace(definition,anchor,replacement);
  definition:=pg_get_functiondef('public.complete_screening_evidence(uuid,text,text,text,jsonb,text,text,integer,integer,integer,numeric,text)'::regprocedure);
  anchor:=E'  return finished_id;\nend;';
  replacement:=E'  perform private.screening_apply_single_group(a.application_id,finished_id);\n  return finished_id;\nend;';
  if position(anchor in definition)=0 or position('screening_apply_single_group' in definition)>0 then
    raise exception 'single_group_unexpected_v2_definition' using errcode='55000'; end if;
  execute replace(definition,anchor,replacement);
end $install$;
commit;
