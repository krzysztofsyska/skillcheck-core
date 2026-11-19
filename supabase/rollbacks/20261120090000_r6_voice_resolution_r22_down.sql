-- Operational rollback for R6-1c part 6: keep every resolution row, the
-- resolution guard, the operator functions, the R22 erasure adapter and the
-- inventory baseline (dropping a table or trigger would change the SC-010 schema
-- signature and block every candidate erasure; removing a resolution would hide
-- why a claim left 'unknown' and how its reserved unit was settled). The forward
-- migration grants nothing to API roles; this only re-asserts that the table and
-- functions stay closed to anon, authenticated and service_role (the operator
-- functions stay owner-only).
-- A reviewed forward migration is required for any further change.
begin;
do $$begin
 if to_regclass('private.erasure_inventory_baseline_r22') is null then
  raise exception 'voice_resolution_r22_required' using errcode='55000';end if;
end;$$;
revoke all on function private.sc011b_resolution_guard(),private.sc011b_list_unknown_dispatches(integer),
 private.sc011b_resolve_unknown_dispatch(uuid,uuid,text,text,text,text) from public;
do $$
declare r text;
begin
 foreach r in array array['anon','authenticated','service_role'] loop
  if to_regrole(r) is not null then
   execute format('revoke all on function private.sc011b_resolution_guard(),private.sc011b_list_unknown_dispatches(integer),private.sc011b_resolve_unknown_dispatch(uuid,uuid,text,text,text,text) from %I',r);
   execute format('revoke all on private.sc011b_dispatch_resolutions from %I',r);
  end if;
 end loop;
end;$$;
commit;
