-- Operational rollback: preserve all evidence, freeze guards and R17 erasure adapters.
-- A reviewed forward migration is required to reopen these RPCs.
begin;
do $$begin
 if to_regclass('private.erasure_inventory_baseline_r17') is null then
  raise exception 'process_followup_r17_required' using errcode='55000';end if;
end;$$;
revoke all on function public.process_followup_create(uuid,text,date,text,text),public.process_followup_grant(uuid,uuid,boolean),
 public.process_followup_record(uuid,integer,jsonb),public.process_followup_read(uuid),public.process_followup_recruitment_metrics(uuid,uuid,integer) from public,anon,authenticated;
commit;
