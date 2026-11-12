-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback SC-METHOD / #275 (profil metody stanowiska i macierz dowodów).
-- Odtwarza stan sprzed migracji: schemat `method` nie istniał i nie było funkcji
-- public.method_*.
--
-- Zatwierdzone wersje metody są w migracji NIEZMIENNE i są zapisem decyzji
-- rekrutera, a powiązania wskazują, z którą wersją powstała definicja zadania.
-- Dlatego — wzorem 20261109190000_sc020_brand_configuration_down.sql — rollback
-- wykonuje się WYŁĄCZNIE, gdy obie tabele są puste. Usunięcie istniejących
-- profili metody to decyzja właściciela, nie rollback.
--
-- Migracja nie zmieniała relacji w 'public'/'private' (dodała tylko funkcje), więc
-- sygnatura inwentarza SC-010 ma pozostać ta sama — sprawdzane na wejściu i na wyjściu.
-- Idempotentny: ponowne uruchomienie na czystej bazie nic nie robi i nie zgłasza błędu.
-- Uruchamiaj przez `psql -v ON_ERROR_STOP=1` przy wstrzymanym ruchu aplikacji:
-- przy równoległym ruchu skrypt świadomie rezygnuje (55P03) zamiast czekać.
begin;
set local lock_timeout = '500ms';

do $preflight$
begin
  if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
    raise exception 'sc_method_rollback_schema_unreviewed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
end
$preflight$;

-- Zagnieżdżone `if` celowo: odwołania do method.* nie są parsowane, gdy schematu nie ma.
do $guard$
begin
  if to_regnamespace('method') is not null then
    if to_regclass('method.profile_versions') is null or to_regclass('method.definition_bindings') is null then
      raise exception 'sc_method_rollback_partial_install' using errcode = '55000';
    end if;
    -- Blokada przed sprawdzeniem pustości: inaczej wiersz zapisany między
    -- sprawdzeniem a `drop schema` zostałby skasowany.
    lock table method.profile_versions, method.definition_bindings in access exclusive mode nowait;
    if exists (select 1 from method.profile_versions) or exists (select 1 from method.definition_bindings) then
      raise exception 'sc_method_rollback_not_empty' using errcode = '55000';
    end if;
  end if;
end
$guard$;

-- CASCADE jest bezpieczne: guard potwierdził brak danych, a migracja nie tworzyła
-- kluczy obcych z 'public'/'private' do `method`.
drop schema if exists method cascade;

drop function if exists public.method_definition_binding(uuid, uuid);
drop function if exists public.method_bind_recruitment_definitions(uuid, uuid);
drop function if exists public.method_bind_definition(uuid, uuid);
drop function if exists public.method_profile_version(uuid, uuid);
drop function if exists public.method_profile_state(uuid, uuid);
drop function if exists public.method_profile_approve(uuid, uuid, integer);
drop function if exists public.method_profile_save_draft(uuid, uuid, jsonb, integer);

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
    raise exception 'sc_method_rollback_inventory_changed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if to_regnamespace('method') is not null then
    raise exception 'sc_method_rollback_incomplete' using errcode = '55000';
  end if;
end
$postflight$;

commit;
