-- Operational rollback without deleting evidence or weakening retention.
-- Disable the Preview UI flag separately; this file only closes AC session RPCs.
-- R13 inventory, guards, immutable evidence and purge support MUST remain.
-- A later reviewed forward migration is needed to restore RPC access.
begin;
do $$begin
 if to_regclass('private.erasure_inventory_baseline_r13') is null then
  raise exception 'ac_r13_required' using errcode='55000';end if;
end;$$;
revoke all on function public.ac_assign_pair(uuid,uuid,uuid,uuid),public.ac_submit_sheet(uuid,jsonb),
 public.ac_find_pair(uuid,uuid),public.ac_read_pair(uuid) from public,anon,authenticated;
commit;
