-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback R7: podgląd limitu kosztu rozmów voicebota w panelu operatora
-- (20261121140000_r7_voice_cost_cap_operator_view.sql).
--
-- Usuwa wyłącznie dwie funkcje odczytu dla operatora. Limit kosztu, zapisane koszty
-- rozmów i alerty dla właściciela (schemat voice_budget) zostają nietknięte i działają
-- dalej; panel operatora pokaże wtedy, że podgląd jest niedostępny.
-- Migracja nie zmieniała relacji w 'public'/'private', więc sygnatura inwentarza SC-010
-- ma pozostać ta sama — sprawdzane na końcu.
-- Idempotentny: ponowne uruchomienie po udanym rollbacku nic nie zmienia.
-- Uruchamiaj przez `psql -v ON_ERROR_STOP=1`.
begin;
set local lock_timeout = '500ms';

do $preflight$
begin
 perform set_config('r7_voice_cost_cap_operator_view.signature_before',private.erasure_schema_signature(),true);
end $preflight$;

drop function if exists public.r7_operator_voice_owner_alerts(integer);
drop function if exists public.r7_operator_voice_cost_cap();

do $postflight$
begin
 if private.erasure_schema_signature() is distinct from current_setting('r7_voice_cost_cap_operator_view.signature_before',true) then
  raise exception 'r7_voice_cost_cap_operator_view_rollback_inventory_changed' using errcode='55000';end if;
 if to_regprocedure('public.r7_operator_voice_cost_cap()') is not null
  or to_regprocedure('public.r7_operator_voice_owner_alerts(integer)') is not null then
  raise exception 'r7_voice_cost_cap_operator_view_rollback_incomplete' using errcode='55000';end if;
end $postflight$;

commit;
