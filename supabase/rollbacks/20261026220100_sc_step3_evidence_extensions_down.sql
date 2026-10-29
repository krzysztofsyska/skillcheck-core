-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
begin;
drop function if exists public.review_screening_evidence_row(uuid,uuid,uuid,timestamptz,text,text,text,text,text,jsonb);
alter table public.screening_criterion_results
  drop column if exists updated_at,
  drop column if exists updated_by,
  drop column if exists human_evidence,
  drop column if exists human_suggested_question,
  drop column if exists human_missing_info,
  drop column if exists human_verdict,
  drop column if exists human_note,
  drop column if exists human_status,
  drop column if exists suggested_question,
  drop column if exists missing_info,
  drop column if exists verdict;
commit;
