# SC-OPS-DB-SCOPE — klasyfikacja izolowanego SQL

TASK: SC-OPS-DB-SCOPE, [Issue #132](https://github.com/krzysztofsyska/skillcheck-core/issues/132).
LEVEL: L3.
SCOPE: OPERATIONS.
OWNER: ChatGPT / orchestrator i builder.
REVIEWER: niezależny przegląd aktualnego SHA oraz wymagane CI.
DEPENDS ON: integration `b511eeb4cd0aca92ea979738a9753b56e82e9439`.

## STATUS

IMPLEMENTED. Bieżące dowody testów, review, SHA i stan integracji znajdują się w PR.

## BRANCH / COMMIT

`fix/sc-ops-isolated-sql-scope-20261017`. Dokładny commit oraz tree podaje PR;
ten dokument nie wpisuje swojego własnego SHA.

## Problem i zmiana

Klasyfikator pomijał `db/isolated/*.sql` i `db/prototypes/*.sql`. Zadanie z samym
izolowanym SQL, testami i dokumentacją błędnie wykrywał jako OPERATIONS, a sam SQL
nie powodował automatycznej eskalacji do L3. Błąd ujawniono przy [#131](https://github.com/krzysztofsyska/skillcheck-core/issues/131).

Jawny wzorzec rozpoznaje pliki SQL w obu istniejących katalogach, również pod
podkatalogami. Przypisuje BACKEND oraz flagi database/security; razem z interfejsem
wykrywa FULLSTACK. L1/L2 i błędne zadeklarowanie scope nadal powodują odmowę.
Dokumentacja w tych katalogach nie staje się kodem bazy danych.

## CHANGED FILES

- `tools/agent-pipeline/classify-pr.mjs` — jeden wzorzec i dwa warunki klasyfikacji.
- `tests/agent-pipeline/isolated-database-scope.test.mjs` — regresje klasyfikacji i odmów.
- `docs/sc-ops-db-scope-handoff.md` — ten handoff.

## DB/MIGRATIONS

Brak zmian SQL, uruchamiania migracji i połączeń z bazą.

## TESTS

Sześć testów sprawdza sam SQL, SQL z dokumentacją/testami, oba katalogi,
podkatalog, L1/L2, błędny scope, FULLSTACK, dokumentację, dotychczasowe migracje,
controller oraz odmowy bezpośredniego main/promotion. Wymagany jest też cały
istniejący zestaw agent-pipeline oraz typecheck/build w aktualnym CI.

## SECURITY CHECKS

Poprawka zaostrza klasyfikację istniejącego kodu DB. Nie zmienia reguł merge,
akceptacji, ochrony gałęzi, produkcji ani aktywacji controllera. Nie pobiera
proponowanych wyjątków produkcyjnych z innych otwartych PR.

## KNOWN ISSUES / BLOCKERS

Otwarte #126 i #128 również dotykają klasyfikatora, ale innych warunków.
Ten PR ma samodzielną, minimalną zmianę opartą na zaakceptowanym integration.
Scalenie wymaga bieżącego CI, niezależnego PASS i weryfikacji bramek.

## NEXT ACTION

Po PASS scalić zgodnie z `AGENTS.md`, zsynchronizować gałąź #131 z integration
i dokończyć jej normalne testy/review. Brak Production Approval.
