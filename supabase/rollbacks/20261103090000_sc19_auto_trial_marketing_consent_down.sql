-- Reverts 20261103090000_sc19_auto_trial_marketing_consent.sql. Run it AFTER
-- the R11 rollback (20261103090100_sc_erasure_inventory_r11_down.sql), so the
-- baseline readers are back on R10 before the four tables disappear; once both
-- have run, the schema matches R10 again and erasure previews work.
--
-- DATA LOSS. Dropping private.marketing_consent_events destroys the consent
-- history, and dropping private.sc19_trial_auto_checks destroys the record of
-- which companies were verified automatically and on what evidence. Neither can
-- be reconstructed. Export both tables before running this if any real company
-- has used them. FREE packs already granted are NOT withdrawn: the balances,
-- the credit journal and the approval rows in private.sc19_trial_approvals all
-- stay, so no company loses analyses it was given.
begin;

do $auto_down_preflight$
begin
  if to_regclass('private.sc19_trial_auto_settings') is null then
    raise exception 'sc19_auto_down_not_installed' using errcode='55000';
  end if;
  -- R11 reads these tables through the baseline; it must be reverted first.
  if to_regclass('private.erasure_inventory_baseline_r11') is not null then
    raise exception 'sc19_auto_down_requires_r11_rollback' using errcode='55000';
  end if;
end $auto_down_preflight$;

drop function if exists public.sc19_daily_digest(timestamptz,timestamptz,uuid,bigint,text);
drop function if exists public.sc19_operator_auto_free_grants();
drop function if exists public.sc19_operator_marketing_consents(text);
drop function if exists public.marketing_consent_state(uuid);
drop function if exists public.marketing_consent_withdraw(uuid);
drop function if exists public.marketing_consent_grant(uuid,text,text);
drop function if exists public.sc19_operator_auto_free_settings();
drop function if exists public.sc19_operator_set_auto_free(boolean);
drop function if exists public.sc19_auto_record_failure(uuid,text,text,uuid,bigint,text);
drop function if exists public.sc19_auto_claim_trial(uuid,text,text,text,text,uuid,bigint,text);
drop function if exists private.sc19_trial_auto_verify_signature(text,uuid,bigint,text,text);
drop function if exists private.marketing_consent_text(text);

drop table if exists private.marketing_consent_events;
drop table if exists private.sc19_trial_auto_checks;
drop table if exists private.sc19_trial_auto_nonces;
drop table if exists private.sc19_trial_auto_settings;

do $auto_down_postflight$
begin
  if to_regclass('private.sc19_trial_approvals') is null or to_regclass('private.sc19_balances') is null then
    raise exception 'sc19_auto_down_removed_accounting' using errcode='55000';
  end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private')
      and (p.proname like 'marketing_consent%' or p.proname like 'sc19_trial_auto%'
        or p.proname in ('sc19_auto_claim_trial','sc19_auto_record_failure','sc19_daily_digest',
          'sc19_operator_set_auto_free','sc19_operator_auto_free_settings',
          'sc19_operator_auto_free_grants','sc19_operator_marketing_consents'))) then
    raise exception 'sc19_auto_down_incomplete' using errcode='55000';
  end if;
end $auto_down_postflight$;
commit;
