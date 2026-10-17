# SC-008 — ranking i shortlista: handoff implementacji

TASK: SC-008
LEVEL: L3
SCOPE: BACKEND
STATUS: PR_REVIEW
OWNER: Codex
REVIEWER: niezależny Codex
DEPENDS ON: SC-006 zaakceptowane PR #61; SC-007; architektura PR #47 PASS i zaakceptowana
BASE: integration 63709ddb9906751d1b8f417ef3e9e024d35720ae

## Zakres i zachowanie

Implementacja zatwierdzonego kontraktu rankingu v1 i shortlisty człowieka.
Odczyty działają pod RLS; zapisy sprawdzają owner/recruiter, oczekiwane wersje
analizy, review i polityki oraz aktualność pod blokadami. Oceny AI i status
zgłoszenia pozostają niezmienione. Brak dowodów nie staje się oceną zero.
Sugestia systemu nie zapisuje shortlisty. Historia wyboru jest niemutowalna,
usunięcie miękkie, a aktualność źródła i polityki wyliczana przy odczycie.

## Zmienione pliki

- `supabase/migrations/20261009081908_screening_ranking_shortlist.sql`: polityka,
  helper porządku, wąska świeżość, tabela shortlisty, RLS/granty, cztery RPC.
- `lib/supabase/database.types.ts` oraz kontrakt testowy typów: dokładne sygnatury,
  shortlist Insert/Update jako never.
- `tests/screening-ranking-database.test.mjs`: pełny łańcuch migracji, rzeczywiste
  RPC, role, granice pokrycia, korekty, kolejność i snapshoty.
- `tests/screening-ranking-concurrency.test.mjs`: wymuszone wyścigi dwóch połączeń
  PostgreSQL. Własna jednorazowa baza; brak testowania na produkcji.
- `tests/helpers/screening-ranking-fixture.mjs`: syntetyczne dane tworzone przez
  produkcyjne start/claim/complete/review, wspólne także dla integracji SC-009.
- `package.json`, `.github/workflows/checks.yml`, dokumentacja bazy/screeningu/backlog.

## Weryfikacja

Lokalnie: typecheck, build, istniejące testy DB 13/13 i nowy zestaw PGlite 20/20 PASS.
Wspólny checkout SC-006/008/009: 9/9 testów rzeczywistego SQL → loader raportu → CSV
PASS. Formularz SC-006 jest parsowany kodem produkcyjnym; przegląd i ranking
powstają przez rzeczywiste RPC. Transport uwierzytelnienia jest testowy, bez
wywołania zewnętrznego dostawcy AI. Test HTTP/przeglądarki raportu wykonany osobno
na wspólnym buildzie; nie jest to live E2E dostawcy ani produkcji.

Końcowy wynik CI PostgreSQL i niezależnego review należy zapisać w PR dla
konkretnego commita. Nie oznaczać współbieżności PASS na podstawie samego PGlite.

## Migracje i produkcja

Nowa migracja jest atomowa i nie została zastosowana zdalnie. Produkcyjne SC-007
jest już zapisane jako `20261009073048`, mimo starego numeru pliku repozytorium;
przyszły zatwierdzony runbook musi uzgodnić historię i nie powielać wykonania.
Migracja SC-006 `20261009080000` musi poprzedzać SC-008. Nie zmieniono sekretów,
flag AI ani agent controller. Produkcja wymaga osobnej zgody.

## Następny krok

Po CI i review PASS przedstawić gotową implementację do OWNER ACCEPTANCE
i scalenia do integration wraz z zależnym PR #63 oraz wynikiem wspólnego testu.
Ekran edycji shortlisty oraz aktywacja AI nie należą do tego kontraktu backendu.
