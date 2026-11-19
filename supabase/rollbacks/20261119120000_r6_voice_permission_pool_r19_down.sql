-- Operational rollback for R6-1c part 2: keep every permission receipt, revocation,
-- pool grant and preparation row, the R19 erasure adapters, the reservation refund
-- and the inventory baseline (dropping a table would change the SC-010 schema
-- signature and block every candidate erasure). The forward migration grants
-- nothing to API roles; this only re-asserts that tables and entry points stay
-- closed to anon, authenticated and service_role.
-- A reviewed forward migration is required for any further change.
begin;
do $$begin
 if to_regclass('private.erasure_inventory_baseline_r19') is null then
  raise exception 'voice_pool_r19_required' using errcode='55000';end if;
end;$$;
revoke all on function private.ingest_voice_interview_permission_receipt(jsonb),
 private.voice_interview_permission_status(uuid,uuid,uuid),private.sc010c_lock_voice_contact(uuid,uuid,uuid,uuid),
 private.sc19_voice_entitlement_eligible(private.sc19_voice_entitlements) from public;
do $$
declare r text;
begin
 foreach r in array array['anon','authenticated','service_role'] loop
  if to_regrole(r) is not null then
   execute format('revoke all on function private.ingest_voice_interview_permission_receipt(jsonb),private.voice_interview_permission_status(uuid,uuid,uuid),private.sc010c_lock_voice_contact(uuid,uuid,uuid,uuid),private.sc19_voice_entitlement_eligible(private.sc19_voice_entitlements) from %I',r);
   execute format('revoke all on private.voice_interview_permission_policies,private.voice_interview_permission_issuers,private.voice_interview_permission_receipts,private.voice_interview_permission_revocations,private.sc19_voice_entitlements,private.sc010c_voice_preparations,private.sc010c_voice_preparation_requests from %I',r);
  end if;
 end loop;
end;$$;
commit;
