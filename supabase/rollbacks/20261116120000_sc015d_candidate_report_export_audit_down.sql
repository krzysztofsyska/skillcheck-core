-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback SC-015-D (dziennik eksportu raportu kandydata).
-- Odtwarza stan sprzed migracji: schemat `report_audit` nie istniał i nie było
-- funkcji public.record_candidate_report_export.
--
-- Wpisy dziennika są w migracji NIEZMIENNE i są zapisem dostępu do danych
-- kandydatów. Dlatego — wzorem 20261112140000_sc_process_diagnostics_down.sql —
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
  perform set_config('sc015d.signature_before', private.erasure_schema_signature(), true);
end
$preflight$;

-- Zagnieżdżone `if` celowo: odwołania do report_audit.* nie są parsowane, gdy schematu nie ma.
do $guard$
begin
  if to_regnamespace('report_audit') is not null then
    if to_regclass('report_audit.candidate_report_exports') is null then
      raise exception 'sc015d_rollback_partial_install' using errcode = '55000';
    end if;
    -- Blokada przed sprawdzeniem pustości: inaczej wpis dopisany między
    -- sprawdzeniem a `drop schema` zostałby skasowany.
    lock table report_audit.candidate_report_exports in access exclusive mode nowait;
    if exists (select 1 from report_audit.candidate_report_exports) then
      raise exception 'sc015d_rollback_not_empty' using errcode = '55000';
    end if;
  end if;
end
$guard$;

drop function if exists public.record_candidate_report_export(uuid, uuid, uuid, text, integer);

-- CASCADE jest bezpieczne: guard potwierdził brak danych, a migracja nie tworzyła
-- kluczy obcych z 'public'/'private' do `report_audit`.
drop schema if exists report_audit cascade;

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from current_setting('sc015d.signature_before', true) then
    raise exception 'sc015d_rollback_inventory_changed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if to_regnamespace('report_audit') is not null then
    raise exception 'sc015d_rollback_incomplete' using errcode = '55000';
  end if;
end
$postflight$;

commit;
