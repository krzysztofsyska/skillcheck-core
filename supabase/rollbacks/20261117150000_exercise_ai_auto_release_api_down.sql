-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback R1-SWITCH: usuwa wyłącznie dwie funkcje Data API
-- public.read_exercise_ai_settings i public.set_exercise_ai_auto_release.
-- Tabela exercise_ai.recruitment_settings, zapisane w niej wybory rekruterów
-- i funkcja exercise_ai.set_auto_release zostają nietknięte (nic nie jest kasowane).
-- Migracja nie zmieniała relacji, więc sygnatura inwentarza SC-010 ma zostać ta sama.
-- Idempotentny: ponowne uruchomienie na czystej bazie nic nie robi.
begin;
set local lock_timeout = '500ms';

do $preflight$
begin
  perform set_config('r1_switch.signature_before', private.erasure_schema_signature(), true);
end
$preflight$;

drop function if exists public.set_exercise_ai_auto_release(uuid, uuid, boolean);
drop function if exists public.read_exercise_ai_settings(uuid, uuid);

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from current_setting('r1_switch.signature_before', true) then
    raise exception 'r1_switch_rollback_inventory_changed' using errcode = '55000';
  end if;
end
$postflight$;
commit;
