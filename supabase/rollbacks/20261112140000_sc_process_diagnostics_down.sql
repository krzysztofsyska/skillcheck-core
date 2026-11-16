-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback SC-PROCESS / #277 część A (diagnostyka rekrutacji i wskaźniki czasu).
-- Odtwarza stan sprzed migracji: schemat `process` nie istniał i nie było funkcji
-- public.process_*.
--
-- Zapisy diagnozy są w migracji NIEZMIENNE i są zapisem pracy rekrutera. Dlatego —
-- wzorem 20261112100000_sc_method_profile_down.sql — rollback wykonuje się
-- WYŁĄCZNIE, gdy tabela jest pusta. Usunięcie istniejących zapisów to decyzja
-- właściciela, nie rollback.
--
-- Migracja nie zmieniała relacji w 'public'/'private' (dodała tylko funkcje), więc
-- sygnatura inwentarza SC-010 ma pozostać ta sama. Tak jak migracja, rollback nie
-- przypina konkretnej wartości: zapamiętuje ją na wejściu i porównuje na wyjściu.
-- Idempotentny: ponowne uruchomienie na czystej bazie nic nie robi i nie zgłasza błędu.
-- Uruchamiaj przez `psql -v ON_ERROR_STOP=1` przy wstrzymanym ruchu aplikacji:
-- przy równoległym ruchu skrypt świadomie rezygnuje (55P03) zamiast czekać.
begin;
set local lock_timeout = '500ms';

do $preflight$
begin
  perform set_config('sc_process.signature_before', private.erasure_schema_signature(), true);
end
$preflight$;

-- Zagnieżdżone `if` celowo: odwołania do process.* nie są parsowane, gdy schematu nie ma.
do $guard$
begin
  if to_regnamespace('process') is not null then
    if to_regclass('process.diagnostic_records') is null then
      raise exception 'sc_process_rollback_partial_install' using errcode = '55000';
    end if;
    -- Blokada przed sprawdzeniem pustości: inaczej wiersz zapisany między
    -- sprawdzeniem a `drop schema` zostałby skasowany.
    lock table process.diagnostic_records in access exclusive mode nowait;
    if exists (select 1 from process.diagnostic_records) then
      raise exception 'sc_process_rollback_not_empty' using errcode = '55000';
    end if;
  end if;
end
$guard$;

-- Funkcje public.process_* najpierw: zależą od typów i funkcji schematu `process`.
drop function if exists public.process_recruitment_metrics(uuid, uuid);
drop function if exists public.process_diagnostics_state(uuid, uuid);
drop function if exists public.process_record_diagnostic(uuid, uuid, jsonb, text, text, integer);

-- CASCADE jest bezpieczne: guard potwierdził brak danych, a migracja nie tworzyła
-- kluczy obcych z 'public'/'private' do `process`.
drop schema if exists process cascade;

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from current_setting('sc_process.signature_before', true) then
    raise exception 'sc_process_rollback_inventory_changed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if to_regnamespace('process') is not null then
    raise exception 'sc_process_rollback_incomplete' using errcode = '55000';
  end if;
end
$postflight$;

commit;
