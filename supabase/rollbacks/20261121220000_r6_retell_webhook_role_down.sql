-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback R6-1e part 2 (20261121220000_r6_retell_webhook_role.sql): removes the
-- Retell webhook role's policies and grants, then the role itself. No application
-- data is touched; the migration created none, and the SC-010 erasure signature
-- stays the same.
--
-- WHAT TO DO FIRST. Removing the role is what turns the webhook off at the
-- database, so a running Preview deployment would fail its connection instead of
-- answering 404 cleanly. Clean order: remove RETELL_WEBHOOK_ENABLED and
-- RETELL_WEBHOOK_DATABASE_URL from the Preview environment and redeploy (the
-- route is then 404), and only then run this script.
--
-- Policies go before the role: PostgreSQL refuses to drop a role a policy still
-- names. `drop owned by` is deliberately not used. The role is cluster-wide: if
-- another database of the same cluster still grants it something, only this
-- database is cleaned and the role is kept (notice), never forced.
-- Idempotent. Run with `psql -v ON_ERROR_STOP=1`.
begin;
set local lock_timeout='500ms';

do $preflight$
begin
 perform set_config('r6_retell_webhook_role.signature_before',private.erasure_schema_signature(),true);
end $preflight$;

drop policy if exists retell_webhook_select on private.sc011b_voice_attempts;
drop policy if exists retell_webhook_update on private.sc011b_voice_attempts;
drop policy if exists retell_webhook_select on private.sc011b_voice_webhook_receipts;
drop policy if exists retell_webhook_insert on private.sc011b_voice_webhook_receipts;
drop policy if exists retell_webhook_insert on private.sc011b_voice_transcripts;
drop policy if exists retell_webhook_select on private.sc010c_voice_preparations;
drop policy if exists retell_webhook_select on voice_budget.charges;

do $revoke$
begin
 if not exists(select 1 from pg_catalog.pg_roles where rolname='retell_webhook') then return; end if;
 revoke all on private.sc011b_voice_attempts, private.sc011b_voice_webhook_receipts,
  private.sc011b_voice_transcripts, private.sc010c_voice_preparations from retell_webhook;
 revoke all on voice_budget.charges from retell_webhook;
 revoke all on function voice_budget.record_call_cost(uuid,uuid,integer) from retell_webhook;
 revoke all on function private.erasure_lock_candidate(uuid) from retell_webhook;
 revoke all on function private.erasure_normal_row_guard(text,text,text,jsonb,jsonb) from retell_webhook;
 revoke all on function private.erasure_purge_allowed(text,jsonb,text) from retell_webhook;
 revoke all on schema private, voice_budget from retell_webhook;
 if exists(select 1 from pg_catalog.pg_shdepend d where d.refclassid='pg_catalog.pg_authid'::regclass
   and d.refobjid='retell_webhook'::regrole) then
  raise notice 'retell_webhook_kept: still referenced in another database of this cluster';
 else
  drop role retell_webhook;
 end if;
end $revoke$;

do $postflight$
begin
 if private.erasure_schema_signature() is distinct from current_setting('r6_retell_webhook_role.signature_before',true) then
  raise exception 'r6_retell_webhook_role_rollback_inventory_changed' using errcode='55000';end if;
 if exists(select 1 from pg_catalog.pg_policies where policyname like 'retell\_webhook\_%') then
  raise exception 'r6_retell_webhook_role_rollback_incomplete' using errcode='55000';end if;
end $postflight$;

commit;
