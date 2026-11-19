-- Operational rollback for R6-1c part 1: keep every voice plan row, the R18 erasure
-- adapters and the inventory baseline (dropping a table would change the SC-010
-- schema signature and block every candidate erasure). The forward migration grants
-- nothing to API roles; this only re-asserts that the RPCs stay closed.
-- A reviewed forward migration is required for any further change.
begin;
do $$begin
 if to_regclass('private.erasure_inventory_baseline_r18') is null then
  raise exception 'voice_plan_r18_required' using errcode='55000';end if;
end;$$;
revoke all on function private.sc012b_review_plan(uuid,bigint,text,text,text,uuid),
 private.sc012b_release_plan(uuid,uuid,text,bigint,uuid,uuid),private.sc012b_current_release(uuid) from public;
do $$
declare r text;
begin
 foreach r in array array['anon','authenticated','service_role'] loop
  if to_regrole(r) is not null then
   execute format('revoke all on function private.sc012b_review_plan(uuid,bigint,text,text,text,uuid),private.sc012b_release_plan(uuid,uuid,text,bigint,uuid,uuid),private.sc012b_current_release(uuid) from %I',r);
   execute format('revoke all on public.voice_plan_versions,private.voice_plan_review_entries,private.voice_plan_release_entries,private.voice_plan_current_releases,private.voice_plan_request_keys,private.voice_plan_template_catalog from %I',r);
  end if;
 end loop;
end;$$;
commit;
