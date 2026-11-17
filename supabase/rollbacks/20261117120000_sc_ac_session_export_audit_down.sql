-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback SC-AC-EXPORT-AUDIT (dziennik pobrań CSV sesji Assessment Center).
-- Usuwa funkcję public.record_assessment_center_session_export i tabelę
-- report_audit.assessment_center_session_exports. Schemat `report_audit`, dziennik
-- SC-015-D i jego funkcje zostają nietknięte.
--
-- Wpisy dziennika są w migracji NIEZMIENNE i są zapisem dostępu do ocen finalistów.
-- Dlatego — wzorem 20261116120000_sc015d_candidate_report_export_audit_down.sql —
-- rollback wykonuje się WYŁĄCZNIE, gdy tabela jest pusta. Usunięcie istniejących
-- wpisów to decyzja właściciela, nie rollback.
--
-- Migracja nie zmieniała relacji w 'public'/'private' (dodała tylko funkcję), więc
-- sygnatura inwentarza SC-010 ma pozostać ta sama: rollback zapamiętuje ją na
-- wejściu i porównuje na wyjściu.
-- Idempotentny: ponowne uruchomienie na czystej bazie nic nie robi i nie zgłasza błędu.
-- Uruchamiaj przez `psql -v ON_ERROR_STOP=1` przy wstrzymanym ruchu aplikacji:
-- przy równoległym ruchu skrypt świadomie rezygnuje (55P03) zamiast czekać.
begin;
set local lock_timeout = '500ms';

do $preflight$
begin
  perform set_config('sc_ac_export_audit.signature_before', private.erasure_schema_signature(), true);
end
$preflight$;

-- Funkcja najpierw: po jej usunięciu nikt nie dopisze wpisu między sprawdzeniem a `drop table`.
drop function if exists public.record_assessment_center_session_export(uuid, uuid, uuid, text);

-- Zagnieżdżone `if` celowo: odwołanie do tabeli nie jest parsowane, gdy jej nie ma.
do $guard$
begin
  if to_regclass('report_audit.assessment_center_session_exports') is not null then
    -- Blokada przed sprawdzeniem pustości: inaczej wpis dopisany między
    -- sprawdzeniem a `drop table` zostałby skasowany.
    lock table report_audit.assessment_center_session_exports in access exclusive mode nowait;
    if exists (select 1 from report_audit.assessment_center_session_exports) then
      raise exception 'sc_ac_export_audit_rollback_not_empty' using errcode = '55000';
    end if;
  end if;
end
$guard$;

drop table if exists report_audit.assessment_center_session_exports;

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from current_setting('sc_ac_export_audit.signature_before', true) then
    raise exception 'sc_ac_export_audit_rollback_inventory_changed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if to_regclass('report_audit.assessment_center_session_exports') is not null
     or to_regprocedure('public.record_assessment_center_session_export(uuid,uuid,uuid,text)') is not null then
    raise exception 'sc_ac_export_audit_rollback_incomplete' using errcode = '55000';
  end if;
end
$postflight$;

commit;
