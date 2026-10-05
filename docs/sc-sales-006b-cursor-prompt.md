# SC-SALES-006B — prompt implementacyjny

Wklej treść od linii „ZADANIE” do nowej rozmowy Cursora w repozytorium `krzysztofsyska/skillcheck-core`, dopiero gdy `docs/sc-sales-006a-lead-architecture.md` jest na `main`. Nie wklejaj tego promptu do bieżącej rozmowy projektowej i nie zaczynaj 006C ani 006D w tym samym zadaniu.

---

ZADANIE: SC-SALES-006B — migracja, RLS i RPC zgłoszeń kontaktowych

WYKONAWCA: Cursor
POZIOM: L3
REVIEW: Codex
REPOZYTORIUM: krzysztofsyska/skillcheck-core
PROJEKT: docs/sc-sales-006a-lead-architecture.md
GAŁĄŹ: feat/sc-sales-006b-sales-leads

Ten prompt jest wykonawczy. Nie projektuj innego modelu bezpieczeństwa. Jeśli pliku projektu nie ma na aktualnym `main`, przerwij i napisz, że 006A nie jest jeszcze zmergowane.

## Cel

Dodać zapis i odczyt zgłoszeń kontaktowych wyłącznie przez RPC opisane w projekcie. Nie dodawać strony, przycisku, server action ani widoku operatora.

## Baza

Wyjdź z aktualnego `main`. Nie resetuj repozytorium. Ostatnia istniejąca migracja w momencie projektu to `supabase/migrations/20261005000100_screening_worker_claim_payload.sql`. Utwórz wyłącznie:

`supabase/migrations/20261006000100_sales_leads.sql`

Jeśli ten plik albo nowszy numer już istnieje, przerwij. Nie edytuj i nie uruchamiaj ponownie starszych migracji. Nie wykonuj migracji na zdalnym Supabase. Nie używaj `service_role`.

## ALLOWED_FILES

- `supabase/migrations/20261006000100_sales_leads.sql`
- `lib/supabase/database.types.ts`
- `tests/database-types.contract.ts`
- `tests/database-types.test.mjs`
- `tests/sales-leads-database.test.mjs`
- `package.json` — tylko skrypt `test:sales-leads`
- `.github/workflows/checks.yml` — tylko uruchomienie `npm run test:sales-leads` obok `npm run test:db`
- `docs/database.md` — dopisanie nowych tabel, RPC i faktu, że zgłoszenie nie ma `company_id`
- `docs/BACKLOG.md` — status 006B na REVIEW, bez zmiany zakresu SC-001–SC-020 i bez zmiany znaczenia SC-006
- `docs/sc-sales-006b-handoff.md`

Poza tą listą nic nie zmieniaj. W szczególności nie twórz `app/rozmowa`, `app/operator`, zmian `proxy.ts`, marketingu, auth ani `.env`.

## Kontrakt migracji

Zaimplementuj sekcje 6–9 i 11 projektu.

Tabele:

- `public.sales_leads` z kolumnami `id`, `idempotency_key`, `first_name`, `company_name`, `email`, `phone`, `needs`, `status`, `submitted_by`, `fingerprint_hash`, `created_at`.
- `public.platform_operators` z kolumnami `user_id`, `granted_at`, `granted_by`, `revoked_at`.
- `private.sales_lead_settings` z jednym wierszem `leads_enabled = false`.
- `private.sales_lead_attempts` bez danych kontaktowych.

`sales_leads` nie ma `company_id`. `status` przyjmuje tylko `received`. Trigger `BEFORE UPDATE OR DELETE` przerywa zmianę tokenem `sales_lead_immutable`.

Dla obu tabel publicznych: `enable row level security`, potem `revoke all` od `public`, `anon` i `authenticated`. Nie nadawaj im `select`, `insert`, `update` ani `delete`. To samo `revoke all` dla tabel w `private`. Nie nadawaj `anon` uprawnienia `usage` do schematu `private`.

Nie wstawiaj żadnego UUID operatora.

Funkcje publiczne, każda `security definer` i `set search_path = ''`:

- `submit_sales_lead(idempotency_key uuid, first_name text, company_name text, email text, phone text, needs text, fingerprint_hash text) returns uuid`
  - `execute`: `anon`, `authenticated`
  - normalizacja i limity dokładnie jak w projekcie: 1–80, 1–160, e-mail 3–254 i wzorzec z projektu, telefon `null` albo 5–32, opis 10–1000, odcisk 64 znaki hex
  - `submitted_by` tylko z `auth.uid()`
  - brak wiersza i flaga włączona: po limitach `INSERT` i nowe `id`
  - brak wiersza i flaga wyłączona: `sales_lead_unavailable`, bez wiersza w `sales_leads` i bez wiersza w `sales_lead_attempts`
  - ten sam klucz i ta sama znormalizowana treść zwracają istniejące `id` także przy wyłączonej fladze; dopisz attempt `replay` i nie zwiększaj liczników
  - inna treść przy tym samym kluczu zwraca `sales_lead_idempotency_conflict` i nie zmienia wiersza
  - telefon: pusty tekst to `null`; inaczej 5–32 znaki zgodne z `^[0-9+().\-\s]{5,32}$`
  - limity: 8 prób na odcisk w 10 minut, licząc attempty inne niż `replay`; 5 przyjęć na odcisk w 60 minut; 3 przyjęcia na znormalizowany e-mail w 24 godziny; 30 przyjęć globalnie w 60 minut
  - tokeny błędów nie zawierają treści pól
- `list_sales_leads(result_limit integer) returns setof public.sales_leads`
  - `execute`: `authenticated`
  - brak operatora: `sales_lead_forbidden`
  - limit przycięty do 1–100, domyślnie 50, sortowanie `created_at desc, id desc`
- `platform_operator_status() returns boolean`
  - `execute`: `authenticated`
  - brak aktywnego wiersza albo puste `auth.uid()` zwraca `false`
  - rola `anon` nie dostaje `execute`
- `grant_platform_operator(target_user uuid) returns void`
- `revoke_platform_operator(target_user uuid) returns void`
  - oba tylko dla aktywnego operatora
  - grant wymaga istniejącego `auth.users`
  - revoke ostatniego aktywnego operatora na nim samym zwraca `sales_lead_last_operator`

`private.is_platform_operator(uuid)` jest `security definer` z `search_path = ''`. Po `revoke all` nadaj `execute` tylko roli `authenticated`, tak jak przy `private.is_company_owner`. Nie nadawaj jej `anon` i nie dodawaj schematu `private` do wystawionego API. Po każdej funkcji publicznej: `revoke all ... from public`, potem tylko wskazany grant.

## Typy

W `lib/supabase/database.types.ts` dopisz obie tabele publiczne i pięć RPC. Bezpośredni `Insert` i `Update` dla `sales_leads` oraz `platform_operators` ustaw jako niedostępne, tak jak przy obiektach zapisywanych tylko przez RPC. Rozszerz zamrożenie w `tests/database-types.contract.ts` i mapę kolumn oraz sygnatur w `tests/database-types.test.mjs`. Nowa migracja musi wejść do tablicy `migrations` tego testu.

## Testy

Utwórz `tests/sales-leads-database.test.mjs` na wzór PGlite z `tests/database.test.mjs`: role `anon` i `authenticated`, schemat `auth`, `auth.uid()`.

Pokryj każdą kontrolę lokalną z sekcji 12 projektu. Test włącza `leads_enabled` samodzielnie, jako właściciel bazy, i przywraca wyłączenie tam, gdzie sprawdza odmowę. Nie łącz się ze zdalnym Supabase. Nie wysyłaj wiadomości. Nie uruchamiaj `test:live`.

Skrypt:

```json
"test:sales-leads": "node --test tests/sales-leads-database.test.mjs"
```

W CI uruchom go bezpośrednio po `npm run test:db`.

Uruchom na Node 24:

- `npm run typecheck`
- `npm run test:db`
- `npm run test:sales-leads`
- `npm run build`

## Odbiór

1. Poprawne wywołanie funkcji zapisuje jeden wiersz i zwraca jego `id`.
2. Złe i zbyt długie dane nie tworzą wiersza.
3. Ponowienie zgodne z kontraktem nie tworzy drugiego wiersza, a konflikt nie nadpisuje pierwszego.
4. Anonim, właściciel firmy, rekruter i viewer nie odczytują tabeli ani listy.
5. Operator odczytuje listę, odebrany operator już nie.
6. Bezpośredni `insert` i `select` przez role API kończą się odmową.
7. Limity działają w funkcji, nie w interfejsie.
8. Wyłączona flaga nie kasuje zapisanych wierszy.
9. Nie powstała firma, członkostwo ani powiązanie po domenie e-maila.
10. Diff zawiera tylko ALLOWED_FILES.

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

Nie rób merge i nie wdrażaj. Nie zaczynaj 006C ani 006D. Następny krok po review to osobny prompt formularza `/rozmowa`, zgodny z sekcją 13 projektu.
