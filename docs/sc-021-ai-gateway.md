# SC-021 — Centralne routowanie i rozliczanie AI

TASK: SC-021-A/B/C (fundament) / issue #81. SCOPE: BACKEND. LEVEL: L3.
OWNER: ChatGPT orchestrator. REVIEWER: niezależny reviewer wymagany.
DEPENDS: SC-005, SC-019, SC-012/013. PRODUCTION_APPROVAL: NO.

## Dostarczony zakres
- lib/ai-gateway/core.ts: walidowane konfiguracje modeli, wersje polityk i cenników; dobór modelu według typu operacji; rozliczenie tokenów cached/uncached w integer mikro-USD.
- lib/ai-gateway/runtime.ts: adapter dostawcy, rezerwacja limitu PRZED wywołaniem providera, jeden fizyczny call na jeden requestKey, idempotentne rozliczenie wyniku, blokada wyniku przy braku wiarygodnych danych usage.
- PROTOTYPE SQL (tylko testowe PostgreSQL, niewdrożony): izolowany ledger per firma i miesiąc UTC, atomowy FOR UPDATE przy rezerwacji, progi ostrzegania, blokada wydatków, override operatora, statusy reserved/settled/unknown/released. Rezerwacja zapisuje rewizję modelu. authenticated ma wyłącznie SELECT z RLS. Modyfikacje wyłącznie przez pracownika DB z grantem (screening_worker / ai_meter_worker).
- Marża kontrybucyjna: przychód netto PLN, koszty API przeliczone jawnym snapshotem FX, osobne koszty voice/telefonii i inne koszty zmienne. Brak danych = wynik nieznany, a nie 0 zł.

## Przebieg wywołania
1. Zaufany backend uzyskuje companyId, operationId, ewentualny processId i pseudonim kandydata z weryfikowanego kontraktu serwerowego. Nigdy z samych parametrów przeglądarki.
2. Odczytuje aktywną politykę routingu i zatwierdzony cennik server-side.
3. Generuje odrębny requestKey UUID dla każdej fizycznej próby wywołania i stabilny operationId dla procesu. Retry po niepewnej odpowiedzi nie używa tego samego requestKey; każde nowe wywołanie jest oddzielnie rejestrowane.
4. Oblicza konserwatywną rezerwację na podstawie oszacowania najgorszego przypadku. Rezerwacja SQL blokuje wiersz budżetu firmy i odrzuca próby przekraczające limit, jeśli override jest wyłączony.
5. Wywołuje zatwierdzony adapter serwerowy. Po otrzymaniu usage zamienia je na mikro-USD, zapisuje koszt rzeczywisty i dopiero po zapisaniu zwraca wynik.
6. Brak usage lub niepewna awaria (sieć, timeout, 5xx) = status unknown, rezerwacja pozostaje policzona do limitu i wymaga rozliczenia. Odrzucenie przed płatnym wywołaniem (błąd serializacji albo 400/401/403/404/422/429) zwalnia rezerwację (`released`) i nie zjada limitu. Brak rozbicia cached tokens nie jest zerem: usage zostaje unknown. Rewizja modelu jest w ledgerze i w metadata żądania.

UWAGA: warstwa wykonawcza i SQL nie są jeszcze podłączone do istniejącego SC-005. Tamtejszy hash kontraktu modelu jest zamrożony i SC-021 nie może go zmieniać przez dynamiczny routing bez osobnej migracji/walidacji. SC-012/013 będą integrować się przez analogiczną kontrolę zaufanej tożsamości. Nie należy włączać SC-021 jako bramki produkcyjnej przed testami pełnego E2E i dopięciem identyfikatora tenanta do zaufanego worker-claim.

## Wymagania operacyjne
- Nie ma domyślnego limitu ani cennika. Brak ai_gateway_limits / cennika = fail closed.
- Limity miesięczne w mikro-USD ustala wyłącznie operator DB (nie użytkownik, nie provider).
- operator_override jest operacją uprzywilejowaną i wymaga osobnego audytu.
- warning=true oznacza próg >= domyślnego 80%; nie ma jeszcze automatycznego powiadamiania.
- Ceny modeli i kurs USD→PLN to zatwierdzone zewnętrzne wejścia wersjonowane, nie deklaracja bieżących stawek OpenAI.
- Nie przechowujemy CV, promptów, transkryptów, adresów e-mail ani raw odpowiedzi providera w ledger.
- Usunięcie firmy usuwa też powiązane rekordy ledger zgodnie z obowiązującą polityką retencji; polityka księgowa poza zakresem tego PR.
- Samo wykonanie migracji nie aktywuje wywołań ani kosztów OpenAI.

## Brakujący zakres przed DONE dla SC-021
1. Zaufana integracja SC-005 z atomowym billingiem (obecny claim celowo nie zawiera company_id): osobny kontrakt worker-only; E2E z rzeczywistym stanem Postgres/Preview.
2. Polityka priorytetów i rollback w panelu operatora; egzekwowanie budżetów oraz alertów w działających operacjach poza screening.
3. Dashboard koszty/kandydat/proces/pakiet, wielowalutowe koszty usług zewnętrznych i rzeczywiste przychody netto.
4. Review bezpieczeństwa SQL/RLS, pełne CI, pilotaż na Preview i jawna zgoda właściciela na produkcję.


## Release blocker confirmed by CI on 2026-10-12

The base integration commit 7a365794 passed the complete Checks workflow
(run 38219575738). After SC-021 initially added ai_gateway_limits and ai_gateway_usage to the deployable migration chain,
the new module's isolated PostgreSQL and Node tests pass, but global Checks
fails the SC-010 R4 reviewed schema signature:

- approved SC-010 R4 signature: d2e7725bd5051e15cb7e700a128026a3ad6f0d87f9d3bba3de8e1539c9d3eabd
- new schema signature: e0a0cbb529d469c9b2ead6c44c5b1b2edbb3c49e5e7578e6fc8adfc93b650752
- reason: SC-010 monitors all public/private tables and explicitly blocks unknown dependencies.

This is an expected safety guard, not a flaky CI failure. Never change the
SC-010 expected hash, disable the schema check, or move cost tables into an
unmonitored schema to make CI green.

Before enabling this migration: separately review candidate-linked usage
(including candidate_pseudonym, operation_id and process_id), extend the
inventory/purge/retention graph, issue a new immutable reviewed R5 baseline,
and test erasure plus retained aggregate financial accounting. Ledger records
must not retain an identifiable candidate after lawful erasure, and erasure
must not silently credit back real provider costs. Until these decisions are
implemented, PR #108 remains DRAFT and NO PRODUCTION. The ledger schema is now
moved to db/prototypes/sc021-ai-gateway-ledger.sql and can only be applied
by isolated tests. It is intentionally absent from supabase/migrations,
so it cannot silently change the live schema as part of this PR. The dedicated
SC-021 workflow demonstrates the module's correctness in isolation only.


## Change on 2026-10-12: safe phased delivery

The prototype is physically isolated under db/prototypes. SC-021-A's
routing and metered-adapter logic can proceed through review independently.
SC-021-B will be proposed as a separate real migration ONLY alongside a new
SC-010-reviewed schema inventory/purge adapter and R5 baseline.
The isolated SQL test runs in an ephemeral PostgreSQL database and must not
be represented as deployment readiness.
