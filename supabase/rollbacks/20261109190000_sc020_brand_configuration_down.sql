-- Rollback SC-020-A (konfiguracja marki firmy, white-label etap A).
-- Odtwarza stan sprzed migracji: schemat `branding` nie istniał, nie było funkcji
-- public.brand_*/private.brand_*, koszyka `brand-assets` ani polityk na storage.objects.
--
-- Historia marki jest w migracji NIEZMIENNA dla wszystkich ról (wyzwalacze
-- guard_immutable/guard_version), a wersje opublikowane są dokumentem decyzji klienta.
-- Dlatego — wzorem 20261109210000_sc021_ai_ledger_down.sql — ten rollback wykonuje się
-- WYŁĄCZNIE, gdy nie ma żadnej wersji, pliku ani zdarzenia. Usunięcie istniejącej marki
-- klienta to decyzja właściciela, nie rollback.
--
-- Koszyk `brand-assets` usuwamy tylko wtedy, gdy jest pusty. Obiekty w Storage nie są
-- objęte transakcją bazy, a ich kasowanie nie jest odwracalne.
--
-- Rola: migracja nie tworzy żadnej roli, więc nie ma czego cofać.
--
-- Migracja nie zmieniała relacji w 'public'/'private' (dodała tylko funkcje), więc
-- sygnatura inwentarza SC-010 ma pozostać ta sama — sprawdzane na wejściu i na wyjściu.
-- Idempotentny: ponowne uruchomienie na czystej bazie nic nie robi i nie zgłasza błędu.
begin;
-- UWAGA DLA OPERATORA: odmowa jest NORMALNYM wynikiem tego skryptu. Przy
-- równoległym ruchu rollback świadomie rezygnuje (55P03) zamiast czekać lub
-- zakleszczyć się z aplikacją — wtedy po prostu uruchom go ponownie. Uruchamiaj
-- przez `psql -v ON_ERROR_STOP=1` albo sprawdzaj kod wyjścia: bez tego psql
-- kończy się zerem nawet gdy transakcja została wycofana, a nieudane cofnięcie
-- wygląda jak udane.
--
-- Całą ochronę przed zakleszczeniem daje `lock table ... nowait` niżej, NIE ten
-- limit: przy deadlock_timeout = 1 s detektor zakleszczeń zadziała cztery sekundy
-- wcześniej, więc limit nigdy nie uchroni przed cyklem. Jest tu tylko po to, żeby
-- zwykłe, bezcykliczne czekanie nie trwało w nieskończoność.
set local lock_timeout = '5s';

-- Storage blokujemy PIERWSZY i POZA gałęzią `branding`, bo `drop policy` oraz
-- `delete from storage.buckets` niżej wykonują się także wtedy, gdy schematu
-- `branding` już nie ma — bez tego brałyby swoje blokady zupełnie bez NOWAIT.
-- Oba obiekty są konieczne: brand_register_asset czyta storage.objects przed
-- zapisem do branding.assets, a `delete from storage.buckets` bierze blokadę na
-- storage.buckets DOPIERO na końcu skryptu. Nieobjęta blokada = rollback znów
-- może czekać, a wtedy cykl się domyka i ofiarą pada transakcja klienta.
do $storagelock$
begin
  if to_regclass('storage.objects') is not null then
    lock table storage.objects in access exclusive mode nowait;
  end if;
  if to_regclass('storage.buckets') is not null then
    lock table storage.buckets in access exclusive mode nowait;
  end if;
end
$storagelock$;

-- Zagnieżdżone `if` celowo: PL/pgSQL przygotowuje zapytanie dopiero przy wykonaniu
-- instrukcji, więc odwołanie do branding.* nie jest parsowane, gdy schematu nie ma.
-- Pojedynczy warunek z `and` wysypałby się na czystej bazie (brak relacji), co
-- odebrałoby plikowi idempotentność.
do $guard$
begin
  if to_regnamespace('branding') is not null then
    -- Schemat bez kompletu tabel = przerwana instalacja. Mówimy to wprost, zamiast
    -- wysypywać się na „relation does not exist" przy pierwszym `exists`.
    if to_regclass('branding.versions') is null or to_regclass('branding.assets') is null
       or to_regclass('branding.events') is null then
      raise exception 'sc020a_rollback_partial_install' using errcode = '55000';
    end if;
    -- Blokada MUSI poprzedzać sprawdzenie pustości. Samo `select` bierze tylko
    -- AccessShareLock, który nie wstrzymuje INSERT-u: bez tego aplikacja mogła
    -- wstawić i zatwierdzić wiersz między sprawdzeniem a `drop schema cascade`,
    -- i ten wiersz zostałby skasowany. Skrypt bywa uruchamiany ręcznie na żywym
    -- Preview, więc okno jest realne.
    --
    -- NOWAIT JEST ISTOTNE, nie ozdobne. `lock table` bierze pozycje z listy
    -- SEKWENCYJNIE, więc bez NOWAIT rollback czeka na pozycję n, trzymając już
    -- 1..n-1 — i to oczekiwanie domyka cykl z aplikacją. Żadna stała kolejność
    -- tego nie rozwiąże, bo aplikacja używa obu kolejności (np. brand_save_draft
    -- czyta assets przed zapisem do versions). Z NOWAIT rollback nigdy nie jest
    -- stroną czekającą: albo bierze wszystko od razu, albo odmawia (55P03), a
    -- transakcja klienta przechodzi bez szwanku. Dla ręcznego skryptu to właściwy
    -- wybór — lepiej spróbować ponownie niż przerwać pracę klienta.
    lock table branding.versions, branding.assets, branding.events
      in access exclusive mode nowait;
    if exists (select 1 from branding.versions)
       or exists (select 1 from branding.assets)
       or exists (select 1 from branding.events) then
      raise exception 'sc020a_rollback_branding_not_empty' using errcode = '55000';
    end if;
  end if;
end
$guard$;

do $preflight$
begin
  if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
    raise exception 'sc020a_rollback_schema_unreviewed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
end
$preflight$;

-- 1. Storage: najpierw polityki, potem pusty koszyk (odwrotnie niż w migracji).
--    Liczenie obiektów poniżej jest wolne od wyścigu dzięki blokadom NOWAIT na
--    storage.objects i storage.buckets wziętym na początku skryptu — nie dzięki
--    kolejności `drop policy`, jak mówił wcześniejszy komentarz.
--    Koszyk `brand-assets` należy do SC-020-A i jest usuwany bezwarunkowo, choć
--    migracja zakłada go przez `on conflict do update`: gdyby ktoś utworzył koszyk
--    o tej nazwie wcześniej, rollback zabierze też jego ustawienia. Żaden plik nie
--    ginie — guard wyżej przepuszcza wyłącznie pusty koszyk.
do $storage$
declare leftover bigint;
begin
  if to_regclass('storage.objects') is null then
    raise notice 'sc020a: brak schematu storage, polityki i koszyk pominięte';
  else
    execute 'drop policy if exists sc020_brand_assets_insert on storage.objects';
    execute 'drop policy if exists sc020_brand_assets_read on storage.objects';
    if to_regclass('storage.buckets') is not null then
      execute 'select count(*) from storage.objects where bucket_id = $1' into leftover using 'brand-assets';
      if leftover > 0 then
        raise exception 'sc020a_rollback_bucket_not_empty:%', leftover using errcode = '55000';
      end if;
      execute 'delete from storage.buckets where id = $1' using 'brand-assets';
    end if;
  end if;
end
$storage$;

-- 2. Funkcje wystawione aplikacji (public.brand_*).
drop function if exists public.brand_editor_state(uuid);
drop function if exists public.brand_asset(uuid, uuid);
drop function if exists public.brand_published(uuid);
drop function if exists public.brand_rollback(uuid, uuid);
drop function if exists public.brand_publish_draft(uuid, uuid, timestamptz);
drop function if exists public.brand_save_draft(uuid, jsonb, uuid, uuid);
drop function if exists public.brand_register_asset(uuid, text, text, text, integer, text);

-- 3. Funkcje pomocnicze w `private` (kolejność odwrotna do migracji).
drop function if exists private.brand_check_asset(uuid, uuid, text);
drop function if exists private.brand_require_owner(uuid);
drop function if exists private.brand_validate_config(jsonb);
drop function if exists private.brand_valid_text(jsonb, integer, integer);
drop function if exists private.brand_contrast(text, text);
drop function if exists private.brand_luminance(text);
drop function if exists private.brand_storage_quota_ok(text);
drop function if exists private.brand_object_company(text);

-- 4. Schemat `branding` wraz z tabelami, indeksami, wyzwalaczami i funkcjami guard.
--    CASCADE jest bezpieczne: guard powyżej już potwierdził, że nie ma w nim danych,
--    a migracja nie tworzyła kluczy obcych z 'public'/'private' do `branding`.
drop schema if exists branding cascade;

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
    raise exception 'sc020a_rollback_inventory_changed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if to_regnamespace('branding') is not null then
    raise exception 'sc020a_rollback_incomplete' using errcode = '55000';
  end if;
end
$postflight$;

commit;
