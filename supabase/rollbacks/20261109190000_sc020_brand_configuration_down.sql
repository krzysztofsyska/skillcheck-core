-- Rollback SC-020-A (konfiguracja marki firmy, white-label etap A).
-- Odtwarza stan sprzed migracji: schemat `branding` nie istniał, nie było funkcji
-- public.brand_*/private.brand_* ani polityk na storage.objects. JEDEN wyjątek:
-- pusty wiersz koszyka `brand-assets` zostaje celowo — uzasadnienie w punkcie 2.
--
-- Historia marki jest w migracji NIEZMIENNA dla wszystkich ról (wyzwalacze
-- guard_immutable/guard_version), a wersje opublikowane są dokumentem decyzji klienta.
-- Dlatego — wzorem 20261109210000_sc021_ai_ledger_down.sql — ten rollback wykonuje się
-- WYŁĄCZNIE, gdy nie ma żadnej wersji, pliku ani zdarzenia. Usunięcie istniejącej marki
-- klienta to decyzja właściciela, nie rollback.
--
-- Koszyka `brand-assets` NIE usuwamy (patrz punkt 2). Jeżeli zostały w nim pliki,
-- rollback odmawia, zamiast zdejmować polityki, które ich pilnują. Obiekty w Storage
-- nie są objęte transakcją bazy, a ich kasowanie nie jest odwracalne — usunięcie
-- samego koszyka to osobny krok przez API Storage.
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
-- Limit jest mniejszy niż deadlock_timeout (domyślnie 1 s), ale UWAGA: sam w
-- sobie NICZEGO NIE GWARANTUJE i wcześniejsza wersja tego komentarza twierdziła
-- inaczej, błędnie. `lock_timeout` liczy się od KAŻDEJ pojedynczej próby pobrania
-- blokady, a `deadlock_timeout` — od chwili, gdy dany czekający się zablokował.
-- To dwa różne zegary startujące w różnych momentach, więc „limit poniżej
-- deadlock_timeout" nie przesądza, kto odpadnie pierwszy. Zawęża tylko okno,
-- w którym ofiarą może paść klient.
--
-- Prawdziwą ochroną jest SZYBKIE DOJŚCIE DO `drop schema ... cascade`: wykonuje
-- się ono zaraz po guardzie, a wszystkie pozostałe instrukcje (polityki,
-- drop function, postflight) idą PO nim. Każda instrukcja to osobna podróż do
-- serwera, więc przy zdalnym połączeniu to one wydłużały drogę do tej jednej
-- instrukcji, która naprawdę może czekać.
--
-- UWAGA NA NAZWĘ: skraca się okno POBIERANIA blokad, czyli czas, w którym może
-- powstać cykl — NIE czas blokowania aplikacji. Same blokady są trzymane do
-- COMMIT-u w obu kolejnościach. Zmierzone na łączu 30 ms, ten plik:
--   * okno pobierania blokad: 1274 ms -> 228 ms (to jest zysk),
--   * łączny czas trzymania blokad: ok. 1390 ms -> 1330 ms (praktycznie bez zmian).
-- Aplikacja czeka więc nadal mniej więcej tyle samo; rzadziej natomiast ginie.
--
-- CZEGO TO NIE ZAŁATWIA — i gdzie ta zmiana pogarsza sprawę. `drop schema ...
-- cascade` bierze blokady niejawne, bez NOWAIT, m.in. na sekwencji tożsamości,
-- której `lock table` w ogóle nie potrafi objąć (PostgreSQL odmawia: "not
-- supported for sequences"). Zostaje więc ścieżka, na której KLIENT blokuje się
-- na tej sekwencji, czeka całą resztę transakcji rollbacku i kończy błędem
-- `XX000 could not open relation with OID ...`, a rollback wychodzi z zerem.
-- `lock_timeout` tego NIE ogranicza — czekającym jest tu klient, nie rollback.
-- Co gorsza, `XX000` to klasa `internal_error`, więc logika ponawiania oparta na
-- 40001/40P01/55P03/57014 tego nie złapie.
--
-- To jest świadomy kompromis tej zmiany, nie przeoczenie: przestawienie
-- instrukcji ZWĘŻA okno powstania zakleszczenia (patrz liczby wyżej), ale
-- POSZERZA okno między `drop schema` a COMMIT-em, w którym realizuje się ta
-- druga awaria — zmierzone dla tego pliku ok. 150 ms -> ok. 1100 ms.
-- UCZCIWIE O BILANSIE, bo łatwo tu o zbyt optymistyczny wniosek. Wszystkie liczby
-- niżej zmierzono na pliku SC-020-A; dla SC-020-B mechanizm jest ten sam.
-- Pochodzą z DWÓCH RÓŻNYCH serii prób, więc nie da się ich wprost dodawać:
--   * seria licząca tylko zakleszczenia: stara kolejność formowała je w 11 z 18
--     prób, nowa w 0 z 54 — tryb 40P01 zostaje WYELIMINOWANY;
--   * seria licząca WSZYSTKIE tryby awarii klienta: stara 6 z 27, nowa 18 z 27.
-- Czyli przestawienie usuwa zakleszczenia, ale łączną liczbę awarii klienta pod
-- ruchem ZWIĘKSZA — i zamienia klasę ponawialną (40P01) na nieponawialną (XX000).
-- Nie twierdzimy zatem, że jest bezpieczniej dla klienta. Zyskiem jest wyłącznie
-- to, że znika tryb, w którym to baza arbitralnie wybiera ofiarę.
-- WNIOSEK PRAKTYCZNY: ŻADNA z tych kolejności nie jest bezpieczna przy
-- równoległym ruchu. To nie jest ostrożnościowa formułka — to wynik pomiaru.
--
-- I TO JEST KONKRETNY POWÓD poniższego zalecenia, nie ostrożnościowy frazes:
-- uruchamiaj ten skrypt przy wstrzymanym ruchu aplikacji, a nie w szczycie.
set local lock_timeout = '500ms';

do $preflight$
begin
  if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
    raise exception 'sc020a_rollback_schema_unreviewed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
end
$preflight$;

-- Storage blokujemy PIERWSZY i POZA gałęzią `branding`, bo `drop policy` niżej
-- wykonuje się także wtedy, gdy schematu `branding` już nie ma — bez tego brałby
-- swoją blokadę zupełnie bez NOWAIT. (Wcześniejsze wersje miały tu także
-- `delete from storage.buckets`; tej instrukcji już nie ma.)
-- Potrzebna jest DOKŁADNIE JEDNA tabela: storage.objects, bo brand_register_asset
-- czyta ją przed zapisem do branding.assets, a `drop policy` niżej i tak bierze na
-- niej ACCESS EXCLUSIVE. Skrypt nie wykonuje żadnego DML na schemacie `storage`,
-- więc nic więcej stamtąd nie jest blokowane — patrz komentarz przy koszyku poniżej.
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
    -- blokadę żadnej tabeli, którą WYMIENIA: albo bierze je od razu, albo odmawia
    -- (55P03), a transakcja klienta przechodzi bez szwanku.
    --
    -- Dokładny zakres tej obietnicy — ani szerzej, ani węziej:
    --  * `drop schema ... cascade` bierze dodatkowo, NIEJAWNIE i BEZ NOWAIT,
    --    ACCESS EXCLUSIVE na indeksach, sekwencji tożsamości (events_id_seq) i
    --    relacjach toast tych tabel. Dla indeksów i toastów żadna ścieżka APLIKACJI
    --    nie dosięgnie ich bez blokady na rodzicu (ręczny VACUUM na relacji toast
    --    by potrafił, ale autovacuum ustępuje przed żądaniem DDL). DLA SEKWENCJI TO NIEPRAWDA: samo
    --    `select ... from pg_sequences` blokuje sekwencję BEZ blokady na
    --    branding.events, a `lock table` nie umie jej objąć (PostgreSQL odmawia
    --    blokowania sekwencji). Ta reszta nie jest więc udowodniona jako niemożliwa
    --    — i NIE jest ograniczona przez `set local lock_timeout`: na tej ścieżce
    --    czekającym jest klient, a nie rollback. Patrz akapit "CZEGO TO NIE
    --    ZAŁATWIA" na początku pliku.
    --  * NOWAIT nie obejmuje czekania na poziomie WIERSZA. Dlatego ten skrypt
    --    celowo nie wykonuje żadnego DML (patrz komentarz przy koszyku).
    --
    -- UWAGA PRZY ROZBUDOWIE: nowa TABELA w schemacie `branding` wypada poza listę
    -- NOWAIT i przywraca ryzyko zakleszczenia — dopisz ją do `lock table`. To samo
    -- dotyczy dodania jakiejkolwiek instrukcji DML. Dla ręcznego skryptu to właściwy
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

-- 1. Schemat `branding` wraz z tabelami, indeksami, wyzwalaczami i funkcjami guard.
--    CASCADE jest bezpieczne: guard powyżej już potwierdził, że nie ma w nim danych,
--    a migracja nie tworzyła kluczy obcych z 'public'/'private' do `branding`.
drop schema if exists branding cascade;

-- 2. Storage: zdejmujemy POLITYKI, a PUSTY KOSZYK ZOSTAWIAMY — świadomie.
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
--    NOLOGIN w rollbackach SC-020-B/D i w sc021_ai_ledger_down. Zakres tej
--    nieszkodliwości, dokładnie: po zdjęciu polityk ŻADEN klient `anon` ani
--    `authenticated` nic do niego nie zapisze ani z niego nie odczyta. Rola
--    `service_role`, `postgres` i usługa Storage omijają RLS i nadal go widzą —
--    to nie jest koszyk nieosiągalny, tylko niedostępny z przeglądarki.
--    Ponowne wgranie migracji zakłada go przez `on conflict do update`.
--
--    Skutek uboczny: `on conflict do update` w migracji NADPISUJE ustawienia
--    istniejącego koszyka o tym samym `id` (public, file_size_limit, allowed_mime_types),
--    a rollback ich nie przywraca — zostają nadpisane na stałe.
--
--    Guard pustości zostaje, bo pliki w koszyku oznaczają, że ktoś wciąż używa
--    marki — wtedy rollback ma odmówić, a nie zdejmować polityki chroniące te pliki.
--    Liczenie jest wolne od wyścigu dzięki blokadzie NOWAIT na storage.objects.
--    Jeśli chcesz usunąć sam koszyk, zrób to osobno, przez API Storage.
--
--    Guard działa TYLKO dopóki polityki istnieją, i liczy PRZED ich zdjęciem.
--    Inaczej byłby pułapką: koszyk zostaje po rollbacku, więc plik wrzucony do niego
--    później (service_role, panel Storage) blokowałby na zawsze ponowne uruchomienie
--    już wykonanego rollbacku — mimo że nie ma czego chronić ani co cofać. A plik
--    wgrany legalnie i tak jest zarejestrowany w branding.assets, więc łapie go
--    wcześniejszy guard; ten dokłada się na osierocone wgrania. Powstają one także
--    przy całkowicie legalnym użyciu: klient `authenticated` najpierw wgrywa plik
--    do Storage (pozwala na to polityka sc020_brand_assets_insert), a dopiero potem
--    woła brand_register_asset — jeśli ta funkcja odrzuci zgłoszenie
--    (brand_asset_invalid) albo karta zostanie zamknięta, plik zostaje nieujęty
--    w branding.assets. To nie jest wyłącznie ślad po service_role.
--    Pozostaje jeden przypadek: jeśli migracja zostanie wgrana PONOWNIE na koszyk
--    z osieroconymi plikami, polityki wracają i rollback znów będzie odmawiał,
--    dopóki ktoś tych plików nie usunie ręcznie. To zamierzone — wtedy marka
--    znowu działa i pliki znowu są chronione.
do $storage$
declare leftover bigint;
begin
  if to_regclass('storage.objects') is null then
    raise notice 'sc020a: brak schematu storage, polityki pominięte';
  else
    if exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
               and policyname in ('sc020_brand_assets_read', 'sc020_brand_assets_insert')) then
      execute 'select count(*) from storage.objects where bucket_id = $1' into leftover using 'brand-assets';
      if leftover > 0 then
        raise exception 'sc020a_rollback_bucket_not_empty:%', leftover using errcode = '55000';
      end if;
    end if;
    execute 'drop policy if exists sc020_brand_assets_insert on storage.objects';
    execute 'drop policy if exists sc020_brand_assets_read on storage.objects';
  end if;
end
$storage$;


-- 3. Funkcje wystawione aplikacji (public.brand_*).
drop function if exists public.brand_editor_state(uuid);
drop function if exists public.brand_asset(uuid, uuid);
drop function if exists public.brand_published(uuid);
drop function if exists public.brand_rollback(uuid, uuid);
drop function if exists public.brand_publish_draft(uuid, uuid, timestamptz);
drop function if exists public.brand_save_draft(uuid, jsonb, uuid, uuid);
drop function if exists public.brand_register_asset(uuid, text, text, text, integer, text);

-- 4. Funkcje pomocnicze w `private` (kolejność odwrotna do migracji).
drop function if exists private.brand_check_asset(uuid, uuid, text);
drop function if exists private.brand_require_owner(uuid);
drop function if exists private.brand_validate_config(jsonb);
drop function if exists private.brand_valid_text(jsonb, integer, integer);
drop function if exists private.brand_contrast(text, text);
drop function if exists private.brand_luminance(text);
drop function if exists private.brand_storage_quota_ok(text);
drop function if exists private.brand_object_company(text);

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
