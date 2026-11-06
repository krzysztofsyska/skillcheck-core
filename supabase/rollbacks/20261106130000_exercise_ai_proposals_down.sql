-- Operational rollback: close AI writes while retaining provenance and lifecycle FKs.
-- R14 and its four erasure readers remain valid; restoration needs reviewed forward SQL.
begin;
do $$begin
 if to_regclass('private.erasure_inventory_baseline_r14') is null then
  raise exception 'c6_r14_required' using errcode='55000';end if;
end;$$;
revoke all on function exercise_ai.approve_proposal(uuid),
 exercise_ai.record_proposal(uuid,uuid,jsonb,integer),exercise_ai.set_auto_release(uuid,boolean)
 from public,anon,authenticated;
commit;
