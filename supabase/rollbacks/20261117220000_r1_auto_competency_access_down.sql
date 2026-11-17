-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback R1-AUTO-ACCESS: usuwa wyłącznie funkcję Data API
-- public.issue_exercise_ai_auto_access. Dostępy już wydane przez automat zostają
-- (nic nie jest kasowane); rekruter odwołuje je istniejącą funkcją C3
-- (public.revoke_competency_test_grant). Migracja nie zmieniała relacji, więc
-- sygnatura inwentarza SC-010 ma zostać ta sama.
-- Idempotentny: ponowne uruchomienie na czystej bazie nic nie robi.
begin;
set local lock_timeout = '500ms';

do $preflight$
begin
  perform set_config('r1_auto_access.signature_before', private.erasure_schema_signature(), true);
end
$preflight$;

drop function if exists public.issue_exercise_ai_auto_access(uuid, uuid);

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from current_setting('r1_auto_access.signature_before', true) then
    raise exception 'r1_auto_access_rollback_inventory_changed' using errcode = '55000';
  end if;
end
$postflight$;
commit;
