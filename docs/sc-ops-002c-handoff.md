# SC-OPS-002C — przygotowanie scalenia nieaktywnego kodu

TASK: SC-OPS-002C
STATUS: IMPLEMENTED / CI_AND_INDEPENDENT_REVIEW_REQUIRED
BRANCH: chore/sc-ops-002c-bootstrap-config
COMMIT: 199dc3b29e06fc52c1c5338f697c2d898cce67b1
CODE_TREE: a06ddb13474a19b4e51910e08dd5c8eb6722a6d4
BASE_COMMIT: 1e2ec57ecfa2e0c9334ddfa5133145a2bc141240
INPUT_HEAD: 0635fe51f4e4fc1a8bb4dd98adec635f1bc9ec21
ISSUE: https://github.com/krzysztofsyska/skillcheck-core/issues/40
PR: https://github.com/krzysztofsyska/skillcheck-core/pull/41

COMMIT wskazuje dokładny kod poprawki dwóch P2. Bezpośredni następca aktualizuje wyłącznie ten dokument. Końcowy HEAD, wynik CI i niezależny werdykt muszą zostać wskazane w PR po wykonaniu. Żaden wcześniejszy PASS nie zatwierdza tej nowej rewizji.

## Zakończona implementacja

Zachowano wcześniejsze poprawki izolacji agent-review, kontroli tożsamości z polityki na SHA workflow, ograniczenia do main/workflow_dispatch/pierwszej próby oraz wymogu bieżącego preflightu przed zewnętrznymi efektami. Pozostaje PR124 verified_ci_review i sc-agent/integration-ready, bez rutynowej zgody owner-acceptance na scalenia do integration. Osobna decyzja produkcyjna nie jest zastępowana zgodą na integration.

Dodatkowy przegląd uruchomiony przez zdjęcie Draft z HEAD 0635fe51 wykrył dwa P2, mimo wcześniejszego przeglądu tego samego kodu bez uwag. Nowy wynik zastąpił wcześniejszą ocenę gotowości; uwag nie pominięto.

- P2 4302627260: agent-review wymaga jawnej tablicy protection_rules bez reviewerów, timerów i nieznanych typów. Dopuszczalne są pusta tablica lub wyłącznie metadane branch_policy, które GitHub zwraca także dla środowiska bez ręcznych bramek. ID i dokładnie jedna gałąź main pozostają weryfikowane osobno. Środowiska owner-acceptance i production-approval nadal wymagają właściciela. Fixture HTTP odzwierciedla ten rozdział zamiast błędnie dodawać reviewera środowisku modelu.
- P2 4302627263: odmowa efektu zapisuje raz skrót jego kanonicznej tożsamości, związany z zadaniem, rewizją, kontraktem i SHA. Nie zapisuje payloadu. Kolejne identyczne odmowy nie dopisują wpisów ani nie wywołują zapisu dziennika; wcześniejsze wpisy pozostają. Oryginalna rezerwacja jest zachowana, więc dodatni preflight pozwala wznowić właściwe wywołanie, bez udawania wykonania ani mnożenia zaległych wywołań.

## CHANGED FILES względem BASE_COMMIT

.github/agent-pipeline/config.example.json
.github/agent-pipeline/policy.json
.github/workflows/agent-review.yml
.github/workflows/agent-verify.yml
docs/sc-ops-002c-bootstrap-runbook.md
docs/sc-ops-002c-handoff.md
tests/agent-pipeline/bootstrap-review-isolation.test.mjs
tests/agent-pipeline/http-world.mjs
tests/agent-pipeline/live-adapters.test.mjs
tests/agent-pipeline/preflight-effects.test.mjs
tests/agent-pipeline/readiness-p2.test.mjs
tests/agent-pipeline/reconcile.test.mjs
tests/agent-pipeline/review-dispatch.test.mjs
tests/agent-pipeline/workflows.test.mjs
tools/agent-pipeline/authorize-review-dispatch.mjs
tools/agent-pipeline/lib/controller.mjs
tools/agent-pipeline/lib/github.mjs
tools/agent-pipeline/lib/protection.mjs
tools/agent-pipeline/lib/reconcile.mjs
tools/agent-pipeline/lib/review-dispatch.mjs

DB / MIGRATIONS: brak zmian i brak wykonania. Nie zmieniono produktu, FREE/PRESELEKCJA, płatności, sekretów ani ustawień dostawców. Implementacja bezpośrednio przez GitHub, nie nowe zlecenie Cursora. Bez force push i bez drugiego autora na gałęzi.

## TESTS / SECURITY CHECKS

Dodano osiem testów offline: dodatni branch_policy/pusta tablica; odmowa reviewerów/timerów/niepełnych danych; zachowanie osobnych zgód właściciela; domyślne adaptery z atrapą wyłącznie granicy HTTP; 1000 odmów co pięć minut z serializacją i odtworzeniem rekordu; poprawne pojedyncze wznowienie; oddzielne efekty i zachowanie historycznych wpisów; powtarzane odmowy workflow dispatch. Nie są to płatne testy usług.

Wymagane wykonanie na nowym końcowym HEAD: pełne Checks, npm run test:agent-pipeline, typecheck, build, odpowiednie testy aplikacji/HTTP, Agent Gates i niezależny Codex. Na moment zapisu dokumentu nowe wyniki są PENDING. Poprzedni Checks 39028867169 dotyczył INPUT_HEAD, nie tego COMMIT. Nie deklaruje się pełnego testu lokalnego ani rzeczywistej pętli dostawców.

## KNOWN ISSUES / BLOCKERS / NEXT ACTION

PR został wyprowadzony z Draft w celu przygotowania integration. Dwie nowe uwagi wymagają zielonego CI i niezależnego re-review przed zamknięciem. Gotowość do scalenia nieaktywnego kodu jest oddzielona od uruchomienia kontrolera; brak App IDs i budżetu nie uzasadnia żądania aktywacji usług przed tym scaleniem.

Odczyt API z 2026-10-17 potwierdził ACTIVE dla quality-gates 25299230 na integration, bez bypass, z wymaganymi verify i Agent contract / scope gate z GitHub Actions App15368. Ten odczyt zastępuje starsze wzmianki Disabled w historycznym opisie bootstrapu; w tym kroku reguły nie zmieniano. Bezpośrednio przed scaleniem ponownie sprawdzić aktualne reguły, SHA, kontrole i otwarte uwagi.

W polityce obie flagi pozostają false, App/actor IDs null. Docelowe bramki dedykowanej App, ważność kluczy, budżet, instalacja na main i test usług LIVE pozostają osobnym etapem aktywacji. Issue40 nie jest ukończonym uruchomieniem. PR50 nakłada się na część tej zmiany i nie jest automatycznie scalany jako druga kopia.

NEXT ACTION: niezależny review dokładnego nowego HEAD i pełne CI; poprawić ewentualne regresje na tej samej gałęzi. Po PASS odnotować gotowość do normalnego scalenia PR41 -> integration. Bez omijania zabezpieczeń, uruchamiania płatnych workflow, zmian main, produkcji, sekretów i migracji w ramach tego przygotowania.
