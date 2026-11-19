-- Operational rollback for R6-1c part 7: keep every transcript, the transcript
-- guard, the recruitment closed_at stamp, the retention purge function, the R23
-- erasure adapter and the inventory baseline (dropping a table or trigger would
-- change the SC-010 schema signature and block every candidate erasure; removing
-- a transcript outside retention or erasure would lose the only record of a
-- candidate's answers). The forward migration grants nothing to API roles; this
-- only re-asserts that the table and functions stay closed to anon,
-- authenticated and service_role (the retention purge stays owner-only).
-- A reviewed forward migration is required for any further change.
begin;
do $$begin
 if to_regclass('private.erasure_inventory_baseline_r23') is null then
  raise exception 'voice_transcripts_r23_required' using errcode='55000';end if;
end;$$;
revoke all on function private.sc011b_transcript_guard(),private.sc011b_purge_voice_transcripts(),
 private.sc011b_recruitment_closed_at() from public;
do $$
declare r text;
begin
 foreach r in array array['anon','authenticated','service_role'] loop
  if to_regrole(r) is not null then
   execute format('revoke all on function private.sc011b_transcript_guard(),private.sc011b_purge_voice_transcripts(),private.sc011b_recruitment_closed_at() from %I',r);
   execute format('revoke all on private.sc011b_voice_transcripts from %I',r);
  end if;
 end loop;
end;$$;
commit;
