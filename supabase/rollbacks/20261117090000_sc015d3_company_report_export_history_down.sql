-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback SC-015-D3 (historia eksportów raportów na poziomie firmy).
-- Usuwa wyłącznie funkcję public.list_company_report_exports. Dziennik
-- `report_audit.candidate_report_exports`, funkcja zapisu z SC-015-D i odczyt
-- pojedynczego raportu z SC-015-D2 zostają nietknięte, a wpisy dziennika nie są usuwane.
--
-- Migracja nie zmieniała relacji w 'public'/'private', więc sygnatura inwentarza
-- SC-010 ma pozostać ta sama: rollback zapamiętuje ją na wejściu i porównuje na wyjściu.
-- Idempotentny: ponowne uruchomienie nic nie robi i nie zgłasza błędu.
-- Uruchamiaj przez `psql -v ON_ERROR_STOP=1`.
begin;

do $preflight$
begin
  perform set_config('sc015d3.signature_before', private.erasure_schema_signature(), true);
end
$preflight$;

drop function if exists public.list_company_report_exports(uuid, integer, timestamptz, uuid);

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from current_setting('sc015d3.signature_before', true) then
    raise exception 'sc015d3_rollback_inventory_changed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if to_regprocedure('public.list_company_report_exports(uuid,integer,timestamptz,uuid)') is not null then
    raise exception 'sc015d3_rollback_incomplete' using errcode = '55000';
  end if;
end
$postflight$;

commit;
