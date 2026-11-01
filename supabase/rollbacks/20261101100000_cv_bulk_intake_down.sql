-- Reverts 20261101100000_cv_bulk_intake.sql. Run the R9 rollback
-- (20261101100100_cv_bulk_erasure_inventory_r9_down.sql) first.
-- Fail closed while any bulk credit movement exists: held slots would otherwise
-- vanish from the SC-019 balance and the journal constraint could not return.
begin;

do $bulk_down_preflight$
begin
  if to_regclass('private.erasure_inventory_baseline_r9') is not null then
    raise exception 'cv_bulk_down_requires_r9_rollback' using errcode='55000';
  end if;
  if exists(select 1 from private.sc19_credit_journal where reason in ('bulk_reserve','bulk_release','bulk_transfer')) then
    raise exception 'cv_bulk_down_has_credit_history' using errcode='55000';
  end if;
end $bulk_down_preflight$;

drop function public.cv_bulk_create_batch(uuid,uuid,jsonb), public.cv_bulk_fail_item(uuid,text),
  public.cv_bulk_register_item(uuid,jsonb), public.cv_bulk_close_upload(uuid), public.cv_bulk_pump(uuid,jsonb,jsonb),
  public.cv_bulk_worker_pump(uuid,bigint,text,jsonb,jsonb), public.cv_bulk_finish_notification(uuid,text,uuid,bigint,text),
  public.cv_bulk_batch_status(uuid), public.cv_bulk_recruitment_batches(uuid), public.get_preselection_groups(uuid),
  public.move_preselection_group(uuid,text,timestamptz,text), public.get_preselection_group_history(uuid),
  public.cv_ai_usage_stats(integer);
drop function private.cv_bulk_pump_batch(private.cv_bulk_batches,jsonb,jsonb), private.cv_bulk_release_slot(private.cv_bulk_items),
  private.cv_bulk_item_for_write(uuid), private.cv_bulk_apply_auto_group(uuid,uuid), private.cv_bulk_touch(uuid),
  private.cv_bulk_verify_signature(text,uuid,bigint,uuid,text,text), private.cv_bulk_valid_contract(jsonb),
  private.cv_bulk_phone_digits(text), private.cv_bulk_group_for(numeric,numeric),
  private.cv_bulk_journal(uuid,text,integer,text), private.cv_bulk_act_as(uuid);
drop table private.application_preselection_group_events, private.application_preselection_groups,
  private.cv_bulk_items, private.cv_bulk_batches, private.cv_bulk_settings;
drop function private.cv_bulk_events_append_only();
alter table private.sc19_credit_journal drop constraint sc19_credit_journal_reason_check;
alter table private.sc19_credit_journal add constraint sc19_credit_journal_reason_check
  check (reason in ('trial','paid_grant','analysis_reserve','analysis_release','analysis_retry'));
commit;
