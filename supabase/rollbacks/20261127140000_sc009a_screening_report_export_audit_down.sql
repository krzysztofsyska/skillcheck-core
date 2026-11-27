-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback R0 SC-009a (dziennik pobrań CSV raportu preselekcji).
-- Usuwa funkcję public.record_screening_report_export i tabelę
-- report_audit.screening_report_exports. Schemat `report_audit`, dziennik SC-015-D,
-- dziennik sesji AC i ich funkcje zostają nietknięte.
--
-- Wpisy dziennika są w migracji NIEZMIENNE i są zapisem dostępu do raportu z ocenami
-- kandydatów. Dlatego — wzorem 20261117120000_sc_ac_session_export_audit_down.sql —
-- rollback wykonuje się WYŁĄCZNIE, gdy tabela jest pusta. Usunięcie istniejących
-- wpisów to decyzja właściciela, nie rollback.
--
-- Migracja nie zmieniała relacji w 'public'/'private' (dodała tylko funkcję), więc
-- sygnatura inwentarza SC-010 ma pozostać ta sama: rollback zapamiętuje ją na
-- wejściu i porównuje na wyjściu.
-- Po rollbacku aplikacja z SC-009a nie wyda pliku CSV preselekcji (brak funkcji
-- zapisu = brak pliku); wycofaj najpierw kod albo uruchom rollback razem z nim.
-- Idempotentny: ponowne uruchomienie na czystej bazie nic nie robi i nie zgłasza błędu.
-- Uruchamiaj przez `psql -v ON_ERROR_STOP=1` przy wstrzymanym ruchu aplikacji:
-- przy równoległym ruchu skrypt świadomie rezygnuje (55P03) zamiast czekać.
begin;
set local lock_timeout = '500ms';

do $preflight$
begin
  perform set_config('sc009a.signature_before', private.erasure_schema_signature(), true);
end
$preflight$;

-- Funkcja najpierw: po jej usunięciu nikt nie dopisze wpisu między sprawdzeniem a `drop table`.
drop function if exists public.record_screening_report_export(uuid, uuid, text, integer);

-- Zagnieżdżone `if` celowo: odwołanie do tabeli nie jest parsowane, gdy jej nie ma.
do $guard$
begin
  if to_regclass('report_audit.screening_report_exports') is not null then
    -- Blokada przed sprawdzeniem pustości: inaczej wpis dopisany między
    -- sprawdzeniem a `drop table` zostałby skasowany.
    lock table report_audit.screening_report_exports in access exclusive mode nowait;
    if exists (select 1 from report_audit.screening_report_exports) then
      raise exception 'sc009a_rollback_not_empty' using errcode = '55000';
    end if;
  end if;
end
$guard$;

drop table if exists report_audit.screening_report_exports;

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from current_setting('sc009a.signature_before', true) then
    raise exception 'sc009a_rollback_inventory_changed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if to_regclass('report_audit.screening_report_exports') is not null
     or to_regprocedure('public.record_screening_report_export(uuid,uuid,text,integer)') is not null then
    raise exception 'sc009a_rollback_incomplete' using errcode = '55000';
  end if;
end
$postflight$;

commit;
