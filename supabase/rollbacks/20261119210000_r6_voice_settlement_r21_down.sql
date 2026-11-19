-- Operational rollback for R6-1c part 5: keep every settlement row, the
-- settlement and do-not-call triggers, the R21 erasure adapter and the inventory
-- baseline (dropping a table or trigger would change the SC-010 schema signature
-- and block every candidate erasure; removing the settlement would let a finished
-- call keep its reserved unit). The forward migration grants nothing to API roles;
-- this only re-asserts that the table and functions stay closed to anon,
-- authenticated and service_role.
-- A reviewed forward migration is required for any further change.
begin;
do $$begin
 if to_regclass('private.erasure_inventory_baseline_r21') is null then
  raise exception 'voice_settlement_r21_required' using errcode='55000';end if;
end;$$;
revoke all on function private.sc011b_settlement_guard(),private.sc011b_block_candidate_contact(uuid,uuid),
 private.sc011b_attempt_settlement(),private.sc011b_keep_candidate_block() from public;
do $$
declare r text;
begin
 foreach r in array array['anon','authenticated','service_role'] loop
  if to_regrole(r) is not null then
   execute format('revoke all on function private.sc011b_settlement_guard(),private.sc011b_block_candidate_contact(uuid,uuid),private.sc011b_attempt_settlement(),private.sc011b_keep_candidate_block() from %I',r);
   execute format('revoke all on private.sc011b_voice_settlements from %I',r);
  end if;
 end loop;
end;$$;
commit;
