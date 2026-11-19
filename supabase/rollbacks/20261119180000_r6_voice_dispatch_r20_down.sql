-- Operational rollback for R6-1c part 4: keep every dispatch claim, call attempt
-- and webhook receipt row, the R20 erasure adapters and the inventory baseline
-- (dropping a table would change the SC-010 schema signature and block every
-- candidate erasure). The forward migration grants nothing to API roles; this
-- only re-asserts that the tables and functions stay closed to anon,
-- authenticated and service_role.
-- A reviewed forward migration is required for any further change.
begin;
do $$begin
 if to_regclass('private.erasure_inventory_baseline_r20') is null then
  raise exception 'voice_dispatch_r20_required' using errcode='55000';end if;
end;$$;
revoke all on function private.sc011b_attempt_guard(),private.sc011b_receipt_guard(),private.sc011b_dispatch_guard(),
 private.sc011b_block_cancel_after_dispatch(),private.sc011b_dispatch_rejected(),
 private.sc011b_block_cancel_while_dispatching() from public;
do $$
declare r text;
begin
 foreach r in array array['anon','authenticated','service_role'] loop
  if to_regrole(r) is not null then
   execute format('revoke all on function private.sc011b_attempt_guard(),private.sc011b_receipt_guard(),private.sc011b_dispatch_guard(),private.sc011b_block_cancel_after_dispatch(),private.sc011b_dispatch_rejected(),private.sc011b_block_cancel_while_dispatching() from %I',r);
   execute format('revoke all on private.sc011b_voice_attempts,private.sc011b_voice_webhook_receipts,private.sc011b_voice_dispatches from %I',r);
  end if;
 end loop;
end;$$;
commit;
