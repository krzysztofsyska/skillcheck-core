-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback R6-2 recruiter order check (20261121170000_r6_voice_order_check.sql).
-- Drops public.voice_interview_order_check only. Voice pools the package sync
-- created stay: they are the company's real package pools and the sync would
-- create the same rows again (idempotent by grant reference); removing them is
-- not a rollback. The migration added only a function, so the SC-010 erasure
-- signature stays the same.
-- Idempotent. Run with `psql -v ON_ERROR_STOP=1`.
begin;
set local lock_timeout='500ms';

do $preflight$
begin
 perform set_config('r6_voice_order_check.signature_before',private.erasure_schema_signature(),true);
end $preflight$;

drop function if exists public.voice_interview_order_check(uuid,uuid,uuid);

do $postflight$
begin
 if private.erasure_schema_signature() is distinct from current_setting('r6_voice_order_check.signature_before',true) then
  raise exception 'r6_voice_order_check_rollback_inventory_changed:%',private.erasure_schema_signature() using errcode='55000';end if;
 if to_regprocedure('public.voice_interview_order_check(uuid,uuid,uuid)') is not null then
  raise exception 'r6_voice_order_check_rollback_incomplete' using errcode='55000';end if;
end $postflight$;

commit;
