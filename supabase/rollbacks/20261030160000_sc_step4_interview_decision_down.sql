-- Reverts 20261030160000_sc_step4_interview_decision.sql (data in audit logs lost).
begin;
do $step4_down_preflight$
begin
  if to_regclass('private.erasure_inventory_baseline_r8') is not null then
    raise exception 'sc_step4_down_requires_r8_down_first' using errcode='55000';
  end if;
end $step4_down_preflight$;
drop trigger if exists application_manual_fields_insert_guard on public.applications;
drop function if exists private.reject_unaudited_application_insert();
drop function if exists public.set_application_human_decision(uuid,uuid,uuid,text,text);
drop function if exists public.move_application_stage(uuid,uuid,uuid,uuid);
drop function if exists public.move_assessment_stage(uuid,uuid,uuid,integer);
drop trigger if exists candidate_assessment_note_history on public.candidate_assessments;
drop function if exists private.track_candidate_assessment_notes();
drop table if exists public.candidate_assessment_note_revisions;
drop table if exists public.application_decision_events;
drop table if exists public.application_stage_events;
alter table public.applications drop constraint if exists application_current_stage_fk;
alter table public.applications drop constraint if exists application_decision_reason_pair;
alter table public.applications
  drop column if exists human_decision_reason,
  drop column if exists human_decision,
  drop column if exists current_stage_id;
commit;
