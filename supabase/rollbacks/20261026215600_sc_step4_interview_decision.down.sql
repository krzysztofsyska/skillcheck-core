-- Reverts 20261026215600_sc_step4_interview_decision.sql (data in audit logs lost).
begin;
drop function if exists public.set_application_human_decision(uuid,uuid,uuid,text,text);
drop function if exists public.move_application_stage(uuid,uuid,uuid,uuid);
drop function if exists public.move_assessment_stage(uuid,uuid,uuid,integer);
drop trigger if exists candidate_assessment_note_history on public.candidate_assessments;
drop function if exists private.track_candidate_assessment_notes();
drop table if exists public.candidate_assessment_note_revisions;
drop table if exists public.application_decision_events;
drop table if exists public.application_stage_events;
revoke update (guide_question_id) on public.candidate_assessments from authenticated;
alter table public.candidate_assessments drop column if exists guide_question_id;
alter table public.applications drop constraint if exists application_current_stage_fk;
alter table public.applications drop constraint if exists application_decision_reason_pair;
alter table public.applications
  drop column if exists human_decision_reason,
  drop column if exists human_decision,
  drop column if exists current_stage_id;
commit;
