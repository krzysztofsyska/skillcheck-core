# SC-009 — handoff, 2026-10-09

- TASK: SC-009 / Issue #10
- STATUS: IMPLEMENTED, independent REVIEW PASS; wspólny test SC-006/008/009 PASS, CI w PR
- LEVEL: L3
- SCOPE: FULLSTACK
- OWNER / BUILDER: Codex, bezpośrednie zlecenie właściciela
- REVIEWER: osobny Codex reviewer
- BRANCH: `feat/sc-009-screening-report`
- BASE: `integration` @ `0003b8d`
- COMMIT implementacji: `88594530a11fef3b5e998f00902a343dd15b0b41`
- DB/MIGRATIONS: none; bez zmian RLS, grantów, RPC, sekretów i globalnego kontraktu typów bazy
- PRODUCTION: nie wdrożono, bez merge do integration/main

## Dostarczone

- Architektura: [sc-009-screening-report-architecture.md](sc-009-screening-report-architecture.md).
- Ekran raportu w rekrutacji: wymagania, ranking, osobna shortlista człowieka, oceny po review i cytaty.
- CSV (UTF-8 BOM, separator `;`, ochrona przed formułami, cytowanie tekstu) i druk/zapis PDF w przeglądarce.
- Odczyt wyłącznie z sesją użytkownika i istniejącym RLS; wszystkie dane przypisane do firmy/rekrutacji.
- Bezpośrednie typowane wywołania odczytów SC-008 PR #65; brak RPC daje jawny stan niedostępności, eksport HTTP 503.
- Źródła odczytywane ponownie, aby wykrywać zmiany przed eksportem. Bez trwałego zapisu raportu.
- Paginacja z kontrolą kompletności, limit 500 zgłoszeń, limit 10 MiB wyniku.
- Powiązanie z ekranem rekrutacji; nowe zadania CI testujące raport i trasy HTTP.

## Wyniki testów

Node 24.19.0; zależności z istniejącego lockfile projektu, bez nowych pakietów.

| Sprawdzenie | Wynik |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm run test:screening-report` | 13/13 PASS |
| `npm run test:screening-report-http` z lokalnym Chromium | 6/6 PASS, w tym 5 podtestów |
| `npm run test:screening` | 37 PASS, 1 SKIP (brak Deno), 0 FAIL |
| `npm run test:db` | 13/13 PASS, PGlite, istniejące RLS/izolacja firm |
| `npm run test:auth` | 11/11 PASS |
| `npm run test:http` | PASS, regresja chronionych tras |
| `git diff --check` | PASS |

HTTP uruchamia prawdziwy build Next i SDK Supabase z lokalnym serwerem syntetycznym. Potwierdza trasę raportu, CSV, sesję, brak dostępu, błędne parametry i niedostępny SC-008. Browser: desktop 1280 px, mobile 390 px, brak poziomego przepełnienia strony, zmiana 10→5, rzeczywiste pobranie pliku, widok print bez kontrolek, zapis testowego A4 PDF. Test browser korzysta z zewnętrznego runtime (`PLAYWRIGHT_MODULE`, `BROWSER_EXECUTABLE`, opcjonalnie `BROWSER_ARGS`), nie dodaje zależności aplikacji. CI zawsze uruchamia część HTTP.

Lokalny build najpierw odrzucił symlink `node_modules` poza worktree (Turbopack); zastąpiono go kopią tych samych zależności. Pierwszy start przeglądarki nie znalazł domyślnej binarki Playwright; ponowienie z istniejącym Chromium zakończyło się PASS. To błędy środowiska testowego, bez zmian konfiguracji produkcyjnej.

## Security checks i review

- Brak pełnego CV, kontaktów, notatek review/shortlisty, autorów, payloadu modelu i sekretów w raporcie.
- Czytelnik firmy (viewer) może czytać/eksportować; nie dodano mutacji.
- Brak automatycznej decyzji hire/reject, bez zmian statusów kandydatów.
- `insufficient_data` nigdy nie staje się score 0.
- Nieaktualne wpisy shortlisty nadal widoczne i oznaczone.
- SC-009 nie liczy score, coverage ani miejsca; pobiera je z SC-008.
- Poprawka z niezależnego review: `approved_with_changes` musi mieć co najmniej jeden override. Brak korekt blokuje raport zamiast eksportować oryginał jako kompletnie sprawdzony. Test regresyjny PASS.
- Finalny werdykt niezależnego review: **PASS** dla architektury i implementacji.

## KNOWN ISSUES / BLOCKERS / NEXT ACTION

1. Backend SC-008 jest zaimplementowany w zależnym PR #65. Został włączony do gałęzi testowej SC-009; scalenie PR #65 musi poprzedzić #63.
2. Wspólny test rzeczywistych RPC w PGlite: 9/9 PASS. Obejmuje parser formularza SC-006, zapis przeglądu, korekty, ranking, shortlistę, raport, CSV, aktualność i RLS. Uwierzytelnienie/transport testowe; to nie jest produkcyjny E2E dostawcy.
3. Kontrola spójności jest optymistyczna. Raport nie jest transakcyjnym snapshotem ani archiwum; dane mogą zmienić się po końcowym odczycie, a nowe pobranie ma nowy czas wygenerowania.
4. GitHub Checks, OWNER ACCEPTANCE i zależność SC-008 przed scaleniem. Osobna PRODUCTION APPROVAL oraz test zależności przed produkcyjnym uruchomieniem. Agent pipeline pozostaje niezmieniony.
5. Publikacja początkowo została zatrzymana przez automatyczną kontrolę uprawnień. Właściciel 2026-10-09 wyraźnie zatwierdził wysłanie gałęzi do publicznego `krzysztofsyska/skillcheck-core` i utworzenie PR do `integration`. Zgoda dotyczy publikacji gałęzi/PR; nie obejmuje merge ani wdrożenia produkcyjnego. Publikacja przez połączony GitHub, ponieważ lokalny git nie ma poświadczeń HTTPS. Kod to identyczny snapshot zweryfikowanej lokalnie implementacji; SHA commita publikacji w PR.

## Changed files

- `lib/screening-report.ts`, `lib/screening-report-source.ts`, `lib/screening-report-export.ts`
- `app/dashboard/[companyId]/recruitments/[recruitmentId]/report/**`
- link na stronie rekrutacji
- `tests/screening-report.test.mjs`, `tests/screening-report-http.test.mjs`, syntetyczny fixture w `tests/helpers/`
- `package.json`, `.github/workflows/checks.yml`
- dokumentacja SC-009 i jego wiersz w `docs/BACKLOG.md`


## Integracja — 2026-10-09

SC-006 zaakceptowane i scalone PR #61. SC-008 PR #65 dostarcza rzeczywiste RPC i typy; usunięto tymczasowy lokalny kontrakt Supabase z loadera raportu. Rozwiązano konflikt nawigacji, zachowując „Preselekcja AI” i link raportu. Nowe `test:screening-joint` w CI wykonuje SQL z pełnego łańcucha migracji, nie kopię algorytmu rankingu. Adapter testowy wykonuje selekcje i RPC pod RLS z limitem dwóch wierszy, sprawdzając również paginację. Pierwotne wyniki HTTP/browser pozostają aktualne na wspólnym buildzie. Akceptacja scalenia PR #65/#63 i osobna decyzja produkcyjna nadal wymagane.
