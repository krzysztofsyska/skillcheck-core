# SC-WER-001 — Audyt punktu wejścia (2026-11-05)

TASK: SC-WER-001
LEVEL: L3
SCOPE: FULLSTACK
STATUS: AUDIT_IN_PROGRESS
BASE: integration @ 7f172d72176fa87719efb81d8db583d3ed5d21af

## Potwierdzone w kodzie

- `lib/competency-test.ts`: definicja rubryki, sanitizacja widoku kandydata, walidacja odpowiedzi i deterministyczna ocena człowieka z dokładnym cytatem. Wynik poniżej 60% pokrycia jest null; nie ma decyzji zatrudnieniowej.
- `app/api/competency/attempt/route.ts`: istnieje izolowany broker B3 z metodą POST; GET/HEAD i inne metody są odrzucane. Nie jest to pełny interfejs dla kandydata.
- `lib/competency-attempt-broker.ts`: broker obsługuje bootstrap, exchange, inspect, status, start, save, submit; wymaga walidacji pochodzenia, ograniczenia wejścia i sesji. Własny komentarz modułu wskazuje brak strony B4 i zaproszeń.
- `docs/sc-014-competency-test.md` opisuje etap A jako kontrakt domenowy, a etap B jako wymagający dalszej integracji. Dokument jest historyczny; przed implementacją trzeba zweryfikować obecne migracje i testy B1–B3.
- `lib/behavior-assessment.ts` oraz `docs/behavior-assessments.md` zapewniają odrębny model ocen zachowania z historią; nie wolno utożsamiać go automatycznie z oceną testu kompetencji.

## Następny bezpieczny zakres

1. Zweryfikować B1–B3 i testy uprawnień, sesji, wygaśnięcia, replay, izolacji firm oraz retencji, zanim powstanie UI B4.
2. Ustalić kontrakt odczytu raportu: wersja zadania, stan próby, dowody, brak danych, wersjonowana ocena rekrutera. Nie dodawać danych ani wyników do SC-015/SC-019.
3. Zbudować B4 i odczyt rekrutera dopiero po potwierdzeniu, że backend autoryzuje konkretną wersję zadania i konkretne zgłoszenie.
4. Weryfikować przez CI i niezależną sesję reviewer; nie wdrażać migracji ani usług na produkcję.

## Ryzyka

- Samo istnienie brokera nie dowodzi dostępności całego procesu dla kandydata.
- Dowody z CV, odpowiedzi testowej i obserwacji AC to trzy odrębne źródła; nie wolno mieszać ich statusów.
- Moduł AC #271 ma osobny kontrakt obserwacji; współdzielone mają być nazwy kompetencji i zasady braku automatycznej decyzji, nie tabele ani skale wyników.

Brak zmian w istniejącym kodzie, DB, billing, FREE i PRESELEKCJI.


## Uzupełnienie audytu — 2026-11-05: pokrycie i bramka B4

- W repo istnieją testy B2 na izolowanym PostgreSQL: `tests/competency-attempt.test.mjs` (rotacja i replay, wersja definicji, timer, ocena człowieka), `tests/competency-retention.test.mjs` (retencja i wycofanie) oraz `tests/competency-validation.test.mjs` (zgodność walidacji odpowiedzi i rubryki JS/SQL).
- B3 ma testy kontraktu HTTP i sesji w `tests/competency-broker-contract.test.mjs`, PostgreSQL/TLS i dwóch firm w `tests/competency-broker-postgres.test.mjs` oraz przeglądarkowy test izolowanego **harnessu** w `tests/competency-broker-browser.test.mjs`. Ich istnienie nie potwierdza przejścia najnowszego przebiegu; w tej iteracji przeanalizowano ich treść, ale nie uruchomiono pełnej bazy testowej.
- Na `integration` w `supabase/migrations/` nie ma aktywnej migracji SC-014 B2. Jest `db/isolated/`, ale nie stanowi wdrożonego schematu ani produkcyjnej autoryzacji kandydata. Najnowszy przeglądany łańcuch zawiera już inwentarz R11 (`20261103090100_sc_erasure_inventory_r11.sql`), więc historyczne założenie planu C1 o baseline R10 wymaga ponownej weryfikacji przed jakąkolwiek nową migracją.
- B4 nie można bezpiecznie podłączyć do realnego przepływu, dopóki C1 nie włączy aktualnego schematu z inwentarzem usuwania, C2 nie uruchomi brokera w Preview, a C3 nie zapewni autoryzowanego wydawania/rotacji uprawnień i reguły shortlisty R1. Sama strona w repo bez tych zależności byłaby pozornie gotowa i niezdatna do testu end-to-end.
- Następny etap implementacyjny: najpierw testy C1 (bieżąca sygnatura R11, izolacja firmy, TTL/replay/withdrawal, shortlist R1), następnie tylko zaakceptowana nowa migracja na środowisku testowym. Bez zmian w PRESELEKCJI, płatnościach ani produkcji.
