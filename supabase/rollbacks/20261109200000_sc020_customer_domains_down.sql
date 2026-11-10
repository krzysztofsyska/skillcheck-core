-- Rollback SC-020-B (domeny klienta, white-label etap B).
-- Odtwarza stan sprzed migracji: schemat `tenant_domains` nie istniał, nie było funkcji
-- public.tenant_domain_* ani nadań dla roli `tenant_domain_verifier`.
--
-- WAŻNE — kolejność względem SC-020-D: ten rollback usuwa cały schemat `tenant_domains`,
-- w którym SC-020-D (20261109220000) tworzy swoje funkcje. Jeśli SC-020-D jest wgrana,
-- najpierw uruchom 20261109220000_sc020d_domain_reverification_down.sql. Poniższy guard
-- odmawia, dopóki tego nie zrobiono, zamiast po cichu usuwać cudze obiekty.
--
-- Zgłoszenia domen i ich dziennik są dowodem, kto i kiedy objął dany host (tabele są
-- niezmienne dla wszystkich ról). Dlatego — wzorem
-- 20261109210000_sc021_ai_ledger_down.sql
-- — rollback wykonuje się WYŁĄCZNIE, gdy nie ma żadnej domeny ani zdarzenia. Wiersz
-- `settings` zakłada sama migracja (wartości domyślne), więc nie blokuje cofnięcia.
--
-- Rola `tenant_domain_verifier` (NOLOGIN) obejmuje cały klaster i ZOSTAJE: operator mógł
-- nadać jej login lub członków poza tą migracją. Bez schematu i bez nadań nic nie może.
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
-- się ono zaraz po guardzie, a wszystkie pozostałe instrukcje (revoke,
-- drop function, postflight) idą PO nim. Każda instrukcja to osobna podróż do
-- serwera, więc przy zdalnym połączeniu to one wydłużały drogę do tej jednej
-- instrukcji, która naprawdę może czekać.
--
-- UWAGA NA NAZWĘ: skraca się okno POBIERANIA blokad, czyli czas, w którym może
-- powstać cykl — NIE czas blokowania aplikacji. Same blokady są trzymane do
-- COMMIT-u w obu kolejnościach. Zmierzone na łączu 30 ms, ten plik:
--   * okno pobierania blokad: 719 ms -> 166 ms (to jest zysk),
--   * łączny czas trzymania blokad: ok. 840 ms -> 715 ms (krócej, ale nie o to
--     tu chodzi — zysk jest w linijce wyżej).
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
-- druga awaria — ten sam mechanizm dotyczy tego pliku (pomiary w pliku SC-020-A).
-- UCZCIWIE O BILANSIE, bo łatwo tu o zbyt optymistyczny wniosek. Przestawienie
-- ELIMINUJE tryb ZAKLESZCZENIA (40P01): stara kolejność formowała je w 11 z 18
-- prób, nowa w 0 z 54. NIE eliminuje natomiast awarii klienta — zamienia jeden
-- tryb na drugi, w szerszym oknie: zmierzone 6 z 27 prób (stara) wobec 18 z 27
-- (nowa). Co istotne, 40P01 jest klasą ponawialną, a XX000 nie.
-- Nie twierdzimy więc, że jest bezpieczniej dla klienta pod ruchem. Zyskiem jest
-- to, że rollback kończy się przewidywalnie (zawsze commit albo czysta odmowa),
-- zamiast losowo ginąć lub zabijać klienta zakleszczeniem.
-- WNIOSEK PRAKTYCZNY: ŻADNA z tych kolejności nie jest bezpieczna przy
-- równoległym ruchu. To nie jest ostrożnościowa formułka — to wynik pomiaru.
--
-- I TO JEST KONKRETNY POWÓD poniższego zalecenia, nie ostrożnościowy frazes:
-- uruchamiaj ten skrypt przy wstrzymanym ruchu aplikacji, a nie w szczycie.
set local lock_timeout = '500ms';

do $preflight$
begin
  if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
    raise exception 'sc020b_rollback_schema_unreviewed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
end
$preflight$;

do $guard$
begin
  if to_regnamespace('tenant_domains') is not null then
    if to_regprocedure('tenant_domains.reverify_due(integer,timestamptz,uuid)') is not null
       or to_regprocedure('tenant_domains.record_scheduled_dns_check(uuid,uuid,text,boolean)') is not null then
      raise exception 'sc020b_rollback_requires_sc020d_down' using errcode = '55000';
    end if;
    -- Schemat bez kompletu tabel = przerwana instalacja. Mówimy to wprost, zamiast
    -- wysypywać się na „relation does not exist" przy pierwszym `exists`.
    if to_regclass('tenant_domains.domains') is null or to_regclass('tenant_domains.events') is null
       or to_regclass('tenant_domains.settings') is null then
      raise exception 'sc020b_rollback_partial_install' using errcode = '55000';
    end if;
    -- Blokada MUSI poprzedzać sprawdzenie pustości — patrz komentarz w
    -- 20261109190000_sc020_brand_configuration_down.sql. Samo `select` nie
    -- wstrzymuje INSERT-u, więc bez tego zgłoszenie domeny wstawione i
    -- zatwierdzone w trakcie sprawdzania zostałoby skasowane przez CASCADE.
    -- `settings` jest na liście dlatego, że `drop schema cascade` ją usuwa —
    -- i tylko dlatego. Nie liczy się do pustości (jej wiersz zakłada sama migracja).
    --
    -- NOWAIT JEST ISTOTNE, nie ozdobne. Rozstrzyga ono problem KOLEJNOŚCI BLOKAD
    -- MIĘDZY TABELAMI, opisany niżej. Czym innym jest KOLEJNOŚĆ INSTRUKCJI w tym
    -- pliku (patrz nagłówek) — ona skraca okno powstania cyklu. Obie rzeczy są
    -- potrzebne i dotyczą różnych problemów. Problemu zakleszczenia nie rozwiąże żadna
    -- stała kolejność blokad, bo aplikacja
    -- używa OBU: tenant_domain_claim czyta settings przed zapisem do domains, ale
    -- record_dns_check, tenant_domain_state, tenant_domain_activate,
    -- tenant_domain_resolve i record_scheduled_dns_check (SC-020-D) dotykają
    -- domains przed settings. Aplikacja sama się nie zakleszcza, bo jej blokady
    -- nie kolidują ze sobą; koliduje dopiero ACCESS EXCLUSIVE rollbacku.
    -- `lock table` bierze pozycje z listy SEKWENCYJNIE, więc bez NOWAIT rollback
    -- czeka na pozycję n, trzymając już 1..n-1 — i to oczekiwanie domyka cykl.
    -- Z NOWAIT rollback nie czeka na blokadę żadnej tabeli, którą WYMIENIA: albo
    -- bierze je od razu, albo odmawia (55P03), a transakcja klienta przechodzi bez
    -- szwanku. `drop schema ... cascade` bierze dodatkowo, niejawnie i bez NOWAIT,
    -- ACCESS EXCLUSIVE na indeksach, sekwencji events_id_seq i relacjach toast tych
    -- tabel. Dla indeksów i toastów żadna ścieżka aplikacji nie dosięgnie ich bez
    -- blokady na rodzicu.
    -- DLA SEKWENCJI NIE: `select ... from pg_sequences` blokuje ją bez blokady na
    -- tabeli, a `lock table` nie umie objąć sekwencji. Ta reszta jest NIE ograniczona
    -- przez `lock_timeout`: na tej ścieżce czekającym jest klient, nie rollback
    -- (patrz akapit "CZEGO TO NIE ZAŁATWIA" na początku pliku). Czekania na
    -- poziomie WIERSZA NOWAIT by nie objął, ale ten
    -- plik nie wykonuje żadnego DML, więc kwestia nie powstaje.
    --
    -- UWAGA PRZY ROZBUDOWIE: nowa TABELA w schemacie `tenant_domains` wypada poza
    -- listę NOWAIT — dopisz ją. To samo dotyczy dodania instrukcji DML.
    lock table tenant_domains.settings, tenant_domains.domains, tenant_domains.events
      in access exclusive mode nowait;
    if exists (select 1 from tenant_domains.domains) or exists (select 1 from tenant_domains.events) then
      raise exception 'sc020b_rollback_domains_not_empty' using errcode = '55000';
    end if;
  end if;
end
$guard$;

-- 1. Schemat `tenant_domains` wraz z tabelami, indeksami, wyzwalaczami i funkcjami.
--    CASCADE jest bezpieczne: guard powyżej potwierdził brak zgłoszeń domen i zdarzeń
--    oraz brak obiektów SC-020-D, a migracja nie tworzyła kluczy obcych z
--    'public'/'private' do tego schematu. Ginie też wiersz `settings`, ale to
--    konfiguracja, którą migracja zakłada na nowo z wartościami domyślnymi — jego
--    utrata jest zamierzona i dlatego nie liczy się do guardu pustości.
drop schema if exists tenant_domains cascade;

-- 2. Nadania dla roli weryfikatora: NIE MA CZEGO ZDEJMOWAĆ.
--    `drop schema ... cascade` wyżej usuwa schemat razem z funkcjami i razem z
--    wszystkimi nadaniami na nich oraz na samym schemacie. Wcześniejsza wersja
--    miała tu blok `revoke` wykonywany PRZED usunięciem schematu; po przestawieniu
--    kolejności (patrz nagłówek) jego warunek `to_regnamespace('tenant_domains')`
--    jest już NULL, więc blok nigdy się nie wykonywał — został usunięty zamiast
--    zostawiony jako martwy kod w skrypcie niszczącym.
--    UWAGA PRZY ROZBUDOWIE: gdyby trzeba było zdjąć nadanie, którego `drop schema`
--    NIE obejmuje (na funkcji w `public`, członkostwo w roli), musi ono trafić
--    PRZED `drop schema` — tutaj byłoby bez efektu.
--    Rola `tenant_domain_verifier` zostaje (patrz nagłówek).

-- 3. Nadanie dla anon na publicznym rozpoznawaniu hosta (migracja nadaje je warunkowo).
do $anon$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
     and to_regprocedure('public.tenant_domain_resolve(text)') is not null then
    revoke execute on function public.tenant_domain_resolve(text) from anon;
  end if;
end
$anon$;


-- 4. Funkcje wystawione aplikacji (public.tenant_domain_*), odwrotnie niż w migracji.
drop function if exists public.tenant_domain_resolve(text);
drop function if exists public.tenant_domain_state(uuid);
drop function if exists public.tenant_domain_revoke(uuid, uuid);
drop function if exists public.tenant_domain_deactivate(uuid, uuid);
drop function if exists public.tenant_domain_activate(uuid, uuid);
drop function if exists public.tenant_domain_claim(uuid, text, text);

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
    raise exception 'sc020b_rollback_inventory_changed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if to_regnamespace('tenant_domains') is not null then
    raise exception 'sc020b_rollback_incomplete' using errcode = '55000';
  end if;
end
$postflight$;

commit;
