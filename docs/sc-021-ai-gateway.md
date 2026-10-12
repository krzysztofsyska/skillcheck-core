# SC-021 — Centralne routowanie i rozliczanie AI

TASK: SC-021-A/B/C (fundament) / issue #81. SCOPE: BACKEND. LEVEL: L3.
OWNER: ChatGPT orchestrator. REVIEWER: niezależny reviewer wymagany.
DEPENDS: SC-005, SC-019, SC-012/013. PRODUCTION_APPROVAL: NO.

## Dostarczony zakres
- lib/ai-gateway/core.ts: walidowane konfiguracje modeli, wersje polityk i cenników; dobór modelu według typu operacji; rozliczenie tokenów cached/uncached w integer mikro-USD.
- lib/ai-gateway/runtime.ts: adapter dostawcy, rezerwacja limitu PRZED wywołaniem providera, jeden fizyczny call na jeden requestKey, idempotentne rozliczenie wyniku, blokada wyniku przy braku wiarygodnych danych usage.
- SQL: izolowany ledger per firma i miesiąc UTC, atomowy FOR UPDATE przy rezerwacji, progi ostrzegania, blokada wydatków, override operatora, statusy reserved/settled/unknown. authenticated ma wyłącznie SELECT z RLS. Modyfikacje wyłącznie przez pracownika DB z grantem (screening_worker / ai_meter_worker).
- Marża kontrybucyjna: przychód netto PLN, koszty API przeliczone jawnym snapshotem FX, osobne koszty voice/telefonii i inne koszty zmienne. Brak danych = wynik nieznany, a nie 0 zł.

## Przebieg wywołania
1. Zaufany backend uzyskuje companyId, operationId, ewentualny processId i pseudonim kandydata z weryfikowanego kontraktu serwerowego. Nigdy z samych parametrów przeglądarki.
2. Odczytuje aktywną politykę routingu i zatwierdzony cennik server-side.
3. Generuje odrębny requestKey UUID dla każdej fizycznej próby wywołania i stabilny operationId dla procesu. Retry po niepewnej odpowiedzi nie używa tego samego requestKey; każde nowe wywołanie jest oddzielnie rejestrowane.
4. Oblicza konserwatywną rezerwację na podstawie oszacowania najgorszego przypadku. Rezerwacja SQL blokuje wiersz budżetu firmy i odrzuca próby przekraczające limit, jeśli override jest wyłączony.
5. Wywołuje zatwierdzony adapter serwerowy. Po otrzymaniu usage zamienia je na mikro-USD, zapisuje koszt rzeczywisty i dopiero po zapisaniu zwraca wynik.
6. Brak usage lub niepewna awaria = status unknown, rezerwacja pozostaje policzona do limitu i wymaga rozliczenia. Brak mechanizmu auto-zwalniania niepewnych należności.

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
