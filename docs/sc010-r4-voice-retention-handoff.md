# SC-010-R4-VOICE — inventory, purge i restore przygotowanych rozmów

Data: 2026-10-18. TASK: Issue #131. LEVEL: L3. SCOPE: BACKEND.
OWNER: ChatGPT / builder, zgodnie z Issue #131. REVIEWER: niezależny Codex.
DEPENDS ON: scalone R1–R4, PR #130 i klasyfikacja SQL z PR #133.
PRODUCTION_APPROVAL: NO. STATUS: IMPLEMENTATION / TESTING.

Baza: `integration`, `ab82270e97be49af6fe936b4d6a961c02898d555`.
Gałąź: `feat/sc-010-r4-voice-retention-20261018`.
Dokładny HEAD, aktualne wyniki CI i werdykt review są w PR.

## Kontrakt i architektura

Jedyny nowy moduł SQL to `db/isolated/sc010-r4-voice-retention.sql`.
Instaluje się po pełnym zaakceptowanym łańcuchu migracji i siedmiu modułach
SC-012/SC-010-C z fixture. Nie zmienia zastosowanych migracji.

Rozszerza istniejące `erasure_inventory_rows`, `erasure_row_candidates`,
`erasure_purge_key`, preview, manifest i ten sam `erasure_purge_engine`.
Zachowuje podpisany ledger, freeze, retired IDs, receipt, replay i izolację
restore. Nowy literalny baseline obejmuje dokładnie czysty zaakceptowany
łańcuch i ten zakres; nigdy nie uczy się katalogu działającej bazy.

Dziewięć tabel osoby obejmuje plany, review/release/current pointer,
klucze żądań planu, receipts/revocations wywiadu i preparations/request keys.
Wspólne template catalog, policies, issuers oraz voice entitlements pozostają.
Request key rozwiązuje osobę przez rodzaj operacji i rzeczywisty wynik w tej
samej firmie. NULL, obcy lub nieznany wynik blokuje preview i wykonanie.

Uprawnienie DELETE wymaga roli `erasure_purge_owner`, kontekstu tej transakcji
oraz dokładnego hasha OLD. Normalne historie pozostają niezmienne. Legalne
usunięcie nieaktualnego current-release nadal działa przez istniejące RPC.
Purge kasuje request keys i przygotowania przed rodzicami, current/releases
przed historią, a reviews/plans naprzemiennie od najnowszej wersji. Nie wyłącza
FK, RLS ani triggerów. Istniejący silnik kończy usuwanie grafu SC-010.

AFTER DELETE rzeczywiście usuniętego `prepared_offline` zwalnia dokładnie
jedną jednostkę w tym samym COMMIT. `cancelled_offline` nie zmienia licznika.
`used`, historia FREE i wszystkie wspólne konfiguracje pozostają. Przed
usunięciem granty są blokowane w stałej kolejności; licznik `reserved` musi
odpowiadać wszystkim aktywnym przygotowaniom firmy/grantu. Niespójna kopia
przywracająca operację bez odpowiadającej jej rezerwacji powoduje PT409 i
rollback, zamiast pobrania jednostki innej osoby. Nie naprawiamy liczników
przez ich reset. Przy restore pozostaje obowiązkowa spójność kopii całego
grafu i księgowości; sama podpisana decyzja usunięcia nie upoważnia do
rekonstrukcji brakujących rezerwacji lub utraconych operacji innych osób.

Nowe dane i revocations aktualizują istniejący zegar retencji. Dokładny
UPDATE bez zmiany przygotowania przy replay nie resetuje czasu. Obserwacje
podczas purge są pomijane zgodnie z obecnym kontraktem R4.

## Walidacja

Nowe testy:
- `tests/voice-retention-database.test.mjs`: pełny graf, shared data, izolacja,
  rollback/retry, cancelled accounting, drift tabel/kolumn/FK, typed request
  resolution, lineage, clock/replay, signed restore i hostile default ACL.
- `tests/voice-retention-concurrency.test.mjs`: rzeczywisty PostgreSQL,
  prepare/freeze, purge/replay/cancel, współdzielony grant, restore locks dla
  prepare/replay/permission/source/review/release, withdrawal/manifest refresh.
- Wspólny helper `tests/helpers/voice-retention-fixture.mjs` używa istniejącego
  buildera syntetycznego grafu oraz rzeczywistego podpisanego ledger.

Workflow `voice-preparation.yml` uruchamia oba nowe pliki bez skip razem
z regresjami SC-010-C/SC-012/SC-019. Główne Checks zachowują R1–R4,
typecheck i build. Nie zmieniono polityki, ochrony gałęzi ani aktywacji usług.

Lokalne polecenie kontraktowe:
`VOICE_RETENTION_TEST_ENGINE=pglite node --test --test-isolation=none --test-concurrency=1 tests/voice-retention-database.test.mjs`.
Jest to jawny dodatkowy przebieg embedded; nie zastępuje wymaganych testów PG.
Domyślne uruchomienie bez tej zmiennej wymaga jednorazowego PostgreSQL na
loopback przez `SCREENING_TEST_DATABASE_URL`. Brak serwera kończy się błędem.

W sesji lokalne środowisko nie pozwoliło instalatorowi PostgreSQL przełączyć
UID. Testy współbieżności są uruchamiane przez CI. Nie osłabiono testów ani
zabezpieczeń w celu obejścia tego ograniczenia.

## Granice i kolejny krok

Nie zastosowano SQL w Supabase ani na produkcji. Brak dispatch, telefonów,
provider writes, płatności, nowych zasobów i zmian sekretów. Ten SQL jest
izolowanym kandydatem do dalszego osobnego procesu wdrożeniowego.

NEXT ACTION: uzyskać wyniki PostgreSQL CI i niezależny przegląd aktualnego
HEAD, poprawić findings i zweryfikować bramki przed integracją. Procent
całego SC-010 pozostaje nieustalony; ta sesja nie odświeża całego monitora.
