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
-- Potrzebna jest DOKŁADNIE JEDNA tabela: storage.objects, bo brand_register_asset
-- czyta ją przed zapisem do branding.assets, a `drop policy` niżej i tak bierze na
-- niej ACCESS EXCLUSIVE. Nic więcej ze schematu `storage` nie jest tu ruszane —
-- patrz komentarz przy koszyku poniżej.
do $storagelock$
begin
  if to_regclass('storage.objects') is not null then
    lock table storage.objects in access exclusive mode nowait;
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
    -- czyta assets przed zapisem do versions). Z NOWAIT rollback nie czeka na
    -- ŻADNĄ blokadę tabeli: albo bierze wszystko od razu, albo odmawia (55P03), a
    -- transakcja klienta przechodzi bez szwanku.
    --
    -- Zakres tej obietnicy: dotyczy blokad TABEL. NOWAIT nie obejmuje czekania na
    -- poziomie wiersza ani blokad branych niejawnie przez późniejsze instrukcje —
    -- dlatego ten skrypt celowo nie wykonuje już żadnego DML na schemacie
    -- `storage` (patrz komentarz przy koszyku). Każda nowa instrukcja DML w tym
    -- pliku ponownie otwiera tę furtkę. Dla ręcznego skryptu to właściwy
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

-- 1. Storage: zdejmujemy POLITYKI, a PUSTY KOSZYK ZOSTAWIAMY — świadomie.
--
--    Wcześniejsze wersje tego pliku kasowały wiersz `storage.buckets`. To jedno
--    `delete` okazało się źródłem powtarzających się zakleszczeń: usunięcie koszyka
--    uruchamia kontrolę więzów na KAŻDEJ tabeli, która ma klucz obcy do
--    storage.buckets (w Supabase to m.in. s3_multipart_uploads,
--    s3_multipart_uploads_parts i bucket_lifecycle_states — zestaw zależy od wersji
--    Storage). Te blokady brane są NIEJAWNIE, na końcu skryptu, gdy rollback trzyma
--    już ACCESS EXCLUSIVE na storage.objects — więc może czekać, a wtedy ofiarą
--    cyklu pada transakcja klienta. Część tego czekania jest na poziomie WIERSZA
--    (kontrola NO ACTION robi `select ... for key share`), czego `lock table ...
--    nowait` nie jest w stanie objąć w ogóle.
--
--    Zamiast blokować pół schematu `storage` na żywym projekcie, nie usuwamy
--    koszyka. Zostaje pusty wiersz konfiguracji — tak samo jak zostają role
--    NOLOGIN w rollbackach SC-020-B/D i w sc021_ai_ledger_down. Jest nieszkodliwy:
--    bez polityk nikt do niego nie zapisze ani nic z niego nie odczyta, a ponowne
--    wgranie migracji i tak zakłada go przez `on conflict do update`.
--
--    Guard pustości zostaje, bo pliki w koszyku oznaczają, że ktoś wciąż używa
--    marki — wtedy rollback ma odmówić, a nie zdejmować polityki chroniące te pliki.
--    Liczenie jest wolne od wyścigu dzięki blokadzie NOWAIT na storage.objects.
--    Jeśli chcesz usunąć sam koszyk, zrób to osobno, przez API Storage.
do $storage$
declare leftover bigint;
begin
  if to_regclass('storage.objects') is null then
    raise notice 'sc020a: brak schematu storage, polityki pominięte';
  else
    execute 'drop policy if exists sc020_brand_assets_insert on storage.objects';
    execute 'drop policy if exists sc020_brand_assets_read on storage.objects';
    execute 'select count(*) from storage.objects where bucket_id = $1' into leftover using 'brand-assets';
    if leftover > 0 then
      raise exception 'sc020a_rollback_bucket_not_empty:%', leftover using errcode = '55000';
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
