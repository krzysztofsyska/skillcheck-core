-- Operational rollback for R6-1c part 8: keep both reviewed function bodies.
-- Restoring the previous private.erasure_check_purge_scope would drop a
-- fail-closed check (an unresolvable voice plan request key would no longer
-- block the purge manifest), and restoring the previous
-- private.retention_observe_candidate would let idempotent replays keep
-- candidate data longer. The forward migration changes no table, row or grant;
-- this only re-asserts that both functions stay closed to public, anon,
-- authenticated and service_role. A reviewed forward migration is required for
-- any further change.
begin;
do $$begin
 if to_regclass('private.erasure_inventory_baseline_r23') is null
  or to_regprocedure('private.erasure_check_purge_scope(uuid)') is null
  or to_regprocedure('private.retention_observe_candidate()') is null then
  raise exception 'voice_retention_r23_required' using errcode='55000';end if;
end;$$;
revoke all on function private.erasure_check_purge_scope(uuid),private.retention_observe_candidate() from public;
do $$
declare r text;
begin
 foreach r in array array['anon','authenticated','service_role'] loop
  if to_regrole(r) is not null then
   execute format('revoke all on function private.erasure_check_purge_scope(uuid),private.retention_observe_candidate() from %I',r);
  end if;
 end loop;
end;$$;
commit;
