# SC-SALES-006B — prompt implementacyjny

Wklej treść od linii „ZADANIE” do nowej rozmowy Cursora w repozytorium `krzysztofsyska/skillcheck-core`, dopiero gdy `docs/sc-sales-006a-lead-architecture.md` jest na `main` i review tej wersji jest zaakceptowane. Nie wklejaj tego promptu do rozmowy review i nie zaczynaj 006C ani 006D w tym samym zadaniu.

---

ZADANIE: SC-SALES-006B — migracja, RLS i RPC zgłoszeń kontaktowych

WYKONAWCA: Cursor
POZIOM: L3
REVIEW: Codex
REPOZYTORIUM: krzysztofsyska/skillcheck-core
PROJEKT: docs/sc-sales-006a-lead-architecture.md
GAŁĄŹ: feat/sc-sales-006b-sales-leads

Ten prompt jest wykonawczy. Nie projektuj innego modelu bezpieczeństwa. Jeśli pliku projektu nie ma na aktualnym `main`, przerwij i napisz, że 006A nie jest jeszcze zmergowane. Implementuj sekcje 6–11 projektu. Przy rozbieżności z tym promptem zatrzymaj się i opisz ją, zamiast wybierać starszą sygnaturę.

## Cel

Dodać zapis i odczyt zgłoszeń kontaktowych wyłącznie przez RPC opisane w projekcie. Nie dodawać strony, przycisku, server action ani widoku operatora.

## Baza

Wyjdź z aktualnego `integration`. PR kieruj do `integration`. Nie resetuj repozytorium. Ostatnia istniejąca migracja w momencie projektu to `supabase/migrations/20261005000100_screening_worker_claim_payload.sql`. Utwórz wyłącznie:

`supabase/migrations/20261007000200_sales_leads.sql`

Jeśli ten plik albo nowszy numer już istnieje, przerwij. Nie edytuj i nie uruchamiaj ponownie starszych migracji. Nie wykonuj migracji na zdalnym Supabase. Nie używaj `service_role`. Nie wstawiaj UUID operatora ani wartości sekretu.

Korekta metadanych 2026-10-07 (Issue #45): baza i cel PR `integration`; numer po migracji SC-007. Kontrakt bezpieczeństwa bez zmian.

## ALLOWED_FILES

- `supabase/migrations/20261007000200_sales_leads.sql`
- `docs/sc-sales-006a-lead-architecture.md` — wyłącznie numer migracji
- `docs/sc-sales-006b-cursor-prompt.md` — wyłącznie aktualizacja metadanych wykonawczych
- `lib/sales-lead-signature.ts`
- `lib/supabase/database.types.ts`
- `tests/database-types.contract.ts`
- `tests/database-types.test.mjs`
- `tests/sales-leads-database.test.mjs`
- `tests/sales-leads-concurrency.mjs`
- `package.json` — skrypt `test:sales-leads`, skrypt `test:sales-leads-concurrency` oraz devDependency `pg` i nic poza tym
- `package-lock.json` — wyłącznie wpisy wynikające z dodania `pg` i jego zależności; nie aktualizuj innych pakietów
- `.github/workflows/checks.yml` — tylko `npm run test:sales-leads` obok `npm run test:db`; nie dodawaj skryptu współbieżności do CI
- `docs/database.md` — dopisanie nowych tabel, RPC, `pgcrypto` i faktu, że zgłoszenie nie ma `company_id`
- `docs/BACKLOG.md` — status 006B na REVIEW, bez zmiany zakresu SC-001–SC-020 i bez zmiany znaczenia SC-006
- `docs/sc-sales-006b-handoff.md`

Poza tą listą nic nie zmieniaj. W szczególności nie twórz `app/rozmowa`, `app/operator`, zmian `proxy.ts`, marketingu, auth ani `.env`. Nie edytuj testów, które mają własną, zamkniętą listę starszych migracji i nie wykonują nowego pliku.

## Kontrakt migracji

Zaimplementuj sekcje 6–9 i 11 projektu. Poniżej jest skrót, który nie zastępuje projektu. Nie zostawiaj sygnatury zwracającej samo `uuid`, argumentu `fingerprint_hash` ani `returns void` dla nadawania i odbierania operatora.

Na początku migracji, zanim powstaną tabele, zrób sprawdzian z sekcji 6 projektu. Nie używaj `CREATE EXTENSION IF NOT EXISTS` jako sygnału złego schematu. Brak `pgcrypto` instaluje je zwykłym `CREATE EXTENSION` w schemacie `extensions`. Inny schemat kończy się `sales_lead_pgcrypto_schema` bez przenoszenia i bez drugiej kopii. Brak `extensions.hmac(text, text, text)` kończy się `sales_lead_pgcrypto_hmac`.

Tabele:

- `public.sales_leads` z kolumnami `id`, `idempotency_key`, `first_name`, `company_name`, `email`, `phone`, `needs`, `status`, `submitted_by`, `fingerprint_hash`, `created_at`.
- `submitted_by` jest `uuid null` bez klucza obcego.
- `public.platform_operators` z kolumnami `user_id`, `granted_at`, `granted_by`, `revoked_at`.
- `private.sales_lead_settings` z jednym wierszem: `leads_enabled = false`, oba sekrety `null`, `request_secret_rotated_at` puste. Trigger `BEFORE UPDATE` pilnuje 60 minut historii poprzedniego sekretu i zabrania podmiany jednego niepustego poprzedniego sekretu na inny.
- `private.sales_lead_attempts` bez danych kontaktowych; `result` tylko `accepted`, `rejected`, `rate_limited`.
- `private.sales_lead_replay_state` z jednym wierszem na zgłoszenie i `replay_count` od 1 do 20.

`sales_leads` nie ma `company_id`. `status` przyjmuje tylko `received`. Trigger `BEFORE UPDATE OR DELETE` przerywa zmianę tokenem `sales_lead_immutable`, z dwoma wyjątkami opisanymi w projekcie: odczepienie autora i funkcja sprzątania wskazanych UUID. Nie używaj `ON DELETE SET NULL` na `submitted_by`. Nie wyłączaj triggera w funkcji sprzątania.

Dla obu tabel publicznych: `enable row level security`, potem `revoke all` od `public`, `anon` i `authenticated`. Nie nadawaj im CRUD. To samo `revoke all` dla nowych tabel w `private`. Nie nadawaj `anon` uprawnienia `usage` do schematu `private`. Nie odbieraj istniejącego `USAGE` roli `authenticated` na schemacie `private`.

Funkcje publiczne, każda `security definer` i `set search_path = ''`:

- `submit_sales_lead(idempotency_key uuid, first_name text, company_name text, email text, phone text, needs text, source_ip text, issued_at_us bigint, request_signature text) returns table(lead_id uuid, result_code text)`
  - `execute`: `anon`, `authenticated`
  - podpis, okno 120 sekund i 30 sekund, kanoniczny tekst, IP i kolejność walidacji dokładnie jak w sekcji 7 projektu
  - `fingerprint_hash` liczy funkcja; nie przyjmuj go jako argumentu
  - `submitted_by` tylko z `auth.uid()` przy INSERT
  - kody biznesowe wracają jako wiersz, bez `RAISE`; wyjątek techniczny nie jest sukcesem
  - zła autoryzacja nie dopisuje próby i nie bierze blokad
  - wstępna autoryzacja jest bez blokad; jej niepowodzenie nie dopisuje próby; odcisk z tego kroku nie wchodzi do limitu ani zapisu
  - po ważnym wstępnym podpisie najpierw blokada 6101 i odczyt klucza; zgodne pięć pól wraca `replay` także przy wyłączonej fladze, bez blokady ustawień i bez odcisku
  - każda inna ścieżka bierze potem `for update` na cały wiersz ustawień i trzyma go do końca transakcji; pod nim ponawia MAC oraz okno czasu i dopiero wtedy liczy odciski
  - wyłączona flaga dla nowego klucza, błędnych pól i konfliktu zwraca `sales_lead_unavailable` bez zgłoszenia i bez próby
  - błędne pola, konflikt i limit przyjęć dopisują co najwyżej jedną próbę tylko przy włączonej fladze i gdy prób w 10 minut jest mniej niż 8
  - dziewiąta próba zwraca `sales_lead_rate_limited` i nie dodaje wiersza
  - limity przyjęć: 5 na odcisk w 60 minut, 3 na e-mail w 24 godziny, 30 globalnie w 60 minut
  - blokady ścieżki z licznikiem: 6101, wiersz ustawień, 6102, 6103, 6104; nie odwracaj jej
  - rotate i retire biorą tylko `for update` tego samego wiersza ustawień, przed zmianą i do końca swojej transakcji; nie biorą 6101–6104
  - poprzedni sekret wlicza się do limitu źródła przez 60 minut od rotacji; okno podpisu zostaje 120 sekund i 30 sekund; nie kasuj poprzedniego sekretu po 120 sekundach
  - zgodne ponowienie zwraca istniejące `lead_id` także przy wyłączonej fladze, nie zmienia `submitted_by` i nie zużywa limitu przyjęć
  - agregacja ponowień ma sufit 20 i nie dopisuje dziennika prób
  - inna treść przy tym samym kluczu i włączonej fladze zwraca `sales_lead_idempotency_conflict` i nie zmienia wiersza
  - telefon: pusty tekst to `null`; inaczej 5–32 znaki zgodne z `^[0-9+().\-\s]{5,32}$`
  - User-Agent nie występuje w argumentach, tekście kanonicznym ani odcisku
- `list_sales_leads(result_limit integer) returns setof public.sales_leads`
  - `execute`: `authenticated`
  - brak operatora: wyjątek `sales_lead_forbidden`
  - limit przycięty do 1–100, domyślnie 50, sortowanie `created_at desc, id desc`
- `platform_operator_status() returns boolean`
  - `execute`: `authenticated`
  - brak aktywnego wiersza albo puste `auth.uid()` zwraca `false`
  - rola `anon` nie dostaje `execute`
- `grant_platform_operator(target_user uuid) returns text`
- `revoke_platform_operator(target_user uuid) returns text`
  - obie najpierw biorą `pg_advisory_xact_lock(6105, 1)` i ponownie sprawdzają wywołującego pod blokadą
  - grant wymaga istniejącego `auth.users`
  - revoke nie zostawia zera aktywnych operatorów i zwraca wtedy `sales_lead_last_operator`
  - kody: `ok`, `sales_lead_forbidden`, `sales_lead_last_operator`, `sales_lead_invalid`

`private.is_platform_operator(uuid)`, `private.detach_sales_lead_author(uuid)`, `private.purge_expired_sales_lead_attempts()`, `private.purge_sales_leads(uuid[])`, `private.rotate_sales_lead_request_secret(text)` i `private.retire_sales_lead_previous_secret()` są `security definer` z `search_path = ''`. Po `revoke all` funkcja operatora dostaje `execute` tylko dla `authenticated`. Funkcje sprzątania, odczepienia i sekretu nie dostają grantu dla `anon` ani `authenticated`. Rotacja i retire zachowują się jak w sekcji 7 projektu, łącznie z tokenami `sales_lead_secret_invalid`, `sales_lead_secret_rotation_busy` i `sales_lead_secret_history_open`. Trigger `AFTER DELETE` na `auth.users` woła odczepienie autora. Po każdej funkcji publicznej: `revoke all ... from public`, potem tylko wskazany grant.

Helper `lib/sales-lead-signature.ts` składa ten sam kanoniczny tekst i HMAC co baza. Nie woła sieci i nie czyta zmiennych środowiska. Test porównuje jeden fixture z `extensions.hmac`.

## Typy

W `lib/supabase/database.types.ts` dopisz obie tabele publiczne i RPC. Bezpośredni `Insert` i `Update` dla `sales_leads` oraz `platform_operators` ustaw jako niedostępne. `submit_sales_lead` zwraca `lead_id` i `result_code`. Grant i revoke zwracają `text`. Rozszerz zamrożenie w `tests/database-types.contract.ts` i mapę kolumn oraz sygnatur w `tests/database-types.test.mjs`. Nowa migracja musi wejść do tablicy `migrations` tego testu. Konstruktor PGlite w tym teście musi załadować `@electric-sql/pglite/contrib/pgcrypto` przed wykonaniem migracji, bo zwykłe `new PGlite()` nie ma rozszerzenia.

## Testy

Utwórz `tests/sales-leads-database.test.mjs` na wzór PGlite z `tests/database.test.mjs`: role `anon` i `authenticated`, schemat `auth`, `auth.uid()`, oraz contrib `pgcrypto`.

Pokryj każdą kontrolę lokalną z sekcji 12 projektu, łącznie z usunięciem autora i sprzątaniem przez funkcję. Test włącza `leads_enabled` i sekret samodzielnie, jako właściciel bazy. Nie łącz się ze zdalnym Supabase. Nie wysyłaj wiadomości. Nie uruchamiaj `test:live`. W raporcie nie nazywaj tych testów dowodem współbieżności.

Utwórz `tests/sales-leads-concurrency.mjs` według sekcji 12. Wyścig zapisu może iść przez `Promise.all`. Wyścig sekretu wymusza kolejność barierą sesji `skillcheck.sales_lead_submit_barrier`: `before_settings` z `pg_advisory_lock(6190, 1)` oraz `after_settings` z `6191`. Sprawdź `pg_locks`, zanim druga sesja zrobi rotację albo retire. Obejmij oba kierunki i nakładanie z retire, łącznie z wynikiem `sales_lead_rate_limited` albo `sales_lead_unauthorized` opisanym w projekcie. Samo `Promise.all` nie wystarcza. Bez `SALES_LEADS_TEST_DATABASE_URL` skrypt kończy się kodem 0 i komunikatem, że został pominięty. Nie dodawaj go do CI. Nie uruchamiaj go na zdalnej bazie projektu. W handoff napisz wprost, że CI go nie wykonało i że to nie jest PASS współbieżności.

Skrypty:

```json
"test:sales-leads": "node --test tests/sales-leads-database.test.mjs"
"test:sales-leads-concurrency": "node tests/sales-leads-concurrency.mjs"
```

W CI uruchom tylko `npm run test:sales-leads`, bezpośrednio po `npm run test:db`.

Uruchom na Node 24:

- `npm ci`
- `npm run typecheck`
- `npm run test:db`
- `npm run test:sales-leads`
- `npm run build`

`npm run test:sales-leads-concurrency` bez adresu bazy ma pokazać pominięcie. Nie traktuj pominięcia jako zaliczenia wyścigu.

## Odbiór

1. Ważny podpis zapisuje jeden wiersz i zwraca jego `lead_id` z kodem `accepted`.
2. Zły podpis, zły kontekst użytkownika i przeterminowany czas nie tworzą wiersza ani próby.
3. Złe pola po ważnym podpisie i przy włączonej fladze nie tworzą zgłoszenia, a odmowa zostaje w dzienniku prób po zakończeniu funkcji. Przy wyłączonej fladze ten sam przypadek nie tworzy ani zgłoszenia, ani próby.
4. Dziewiąta próba nie wydłuża dziennika.
5. Ponowienie zgodne z kontraktem nie tworzy drugiego zgłoszenia, nie nadpisuje `submitted_by` i nie rośnie bez limitu.
6. Konflikt przy włączonej fladze nie nadpisuje pierwszego wiersza. Przy wyłączonej fladze nie dopisuje próby.
7. Anonim, właściciel firmy, rekruter i viewer nie odczytują tabeli ani listy.
8. Operator odczytuje listę, odebrany operator już nie.
9. Bezpośredni `insert` i `select` przez role API kończą się odmową.
10. Wyłączona flaga bazy blokuje nowy klucz także przy ważnym podpisie i nie kasuje zapisanych wierszy. Zgłoszenia sprzed rotacji nadal zużywają limit źródła przez całe okno 60 minut.
11. Usunięcie autora nie jest blokowane przez trigger, a bezpośrednia edycja zgłoszenia jest.
12. Diff zawiera tylko ALLOWED_FILES. `package-lock.json` zmienia się wyłącznie przez `pg` i jego zależności.
13. Test dwóch połączeń jest dostarczony, oznaczony jako niewykonany w CI i nie jest raportowany jako PASS.

## Raport

Utwórz `docs/sc-sales-006b-handoff.md` i zakończ odpowiedź blokiem:

TASK
STATUS: REVIEW
BRANCH
BASE_COMMIT
COMMIT
CHANGED FILES
DB / MIGRATIONS: plik migracji dodany w repozytorium, niewykonany na zdalnej bazie
WYKONANE KONTROLE
ODCHYLENIA OD PROJEKTU
NEXT ACTION

Nie rób merge i nie wdrażaj. Nie zaczynaj 006C ani 006D. Następny krok po review to osobny prompt formularza `/rozmowa`, zgodny z sekcją 13 projektu. Publiczne `leads_enabled = true` czeka na wynik testu współbieżności z sekcji 12.
