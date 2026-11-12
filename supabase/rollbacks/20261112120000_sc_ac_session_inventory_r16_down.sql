-- Operational rollback without deleting evidence or weakening retention.
-- Disable the Preview UI flag separately; this file only closes the AC session RPCs.
-- R16 inventory, guards, append-only evidence and purge support MUST remain: the
-- candidate-linked rows stay erasable through the manifest-checked purge.
-- The R13 pair RPCs are not touched. A later reviewed forward migration is needed
-- to restore RPC access.
begin;
do $$begin
 if to_regclass('private.erasure_inventory_baseline_r16') is null then
  raise exception 'ac_session_r16_required' using errcode='55000';end if;
end;$$;
revoke all on function public.ac_session_create(uuid,text,text[]),public.ac_session_add_stage(uuid,text,text,uuid,text),public.ac_session_remove_last_stage(uuid),
 public.ac_session_add_finalist(uuid,uuid),public.ac_session_remove_finalist(uuid,uuid),public.ac_session_set_status(uuid,text),
 public.ac_session_assign_pair(uuid,uuid,uuid,uuid,uuid),public.ac_record_reconciliation(uuid,jsonb),
 public.ac_confirm_reconciliation(uuid,text,text),public.ac_session_record_entry(uuid,uuid,uuid,text,jsonb),
 public.ac_session_find(uuid),public.ac_session_read(uuid) from public,anon,authenticated;
commit;
