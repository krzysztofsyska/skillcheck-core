-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback R3-AC-NAMES: usuwa wyłącznie funkcję public.ac_assessor_display_names.
-- Żadne dane nie są kasowane; aplikacja wraca do etykiet z PR #500 („Ty”, „Właściciel firmy”,
-- „Członek zespołu N”), bo przy błędzie RPC nie pokazuje nazw.
-- Migracja nie zmieniała relacji, więc sygnatura inwentarza SC-010 ma zostać ta sama.
-- Idempotentny: ponowne uruchomienie na czystej bazie nic nie robi.
begin;
set local lock_timeout = '500ms';

do $preflight$
begin
  perform set_config('ac_assessor_names.signature_before', private.erasure_schema_signature(), true);
end
$preflight$;

drop function if exists public.ac_assessor_display_names(uuid, uuid);

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from current_setting('ac_assessor_names.signature_before', true) then
    raise exception 'ac_assessor_names_rollback_inventory_changed' using errcode = '55000';
  end if;
  if to_regprocedure('public.ac_assessor_display_names(uuid,uuid)') is not null then
    raise exception 'ac_assessor_names_rollback_incomplete' using errcode = '55000';
  end if;
end
$postflight$;
commit;
