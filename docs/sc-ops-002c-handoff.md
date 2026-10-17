# SC-OPS-002C — bootstrap bez aktywacji

TASK: SC-OPS-002C
STATUS: IMPLEMENTED / CI_AND_INDEPENDENT_REVIEW_REQUIRED
BRANCH: chore/sc-ops-002c-bootstrap-config
COMMIT: 614c297450a95f5f805608ad5fc99779e7db20a9
CODE_TREE: 1cc072690b8df270a9145e114dd1dcca5e08ead9
BASE_COMMIT: 1e2ec57ecfa2e0c9334ddfa5133145a2bc141240
INPUT_HEAD: 76f93360b4dc6346c78c51617a6eaddf868a1520
ISSUE: https://github.com/krzysztofsyska/skillcheck-core/issues/40
PR: https://github.com/krzysztofsyska/skillcheck-core/pull/41

Powyższy COMMIT jednoznacznie identyfikuje kod po połączeniu aktualnej integration z istniejącą gałęzią PR #41. Bezpośredni następca aktualizuje wyłącznie ten dokument; nie zmienia plików wykonywalnych ani testów. Wyniki CI i niezależnego review muszą wskazywać dokładny końcowy HEAD w komentarzu PR — nie wolno przypisywać poprzedniego PASS do nowszego kodu.

## Zakres i zachowane zabezpieczenia

Zachowano wszystkie pliki produktu z integration, bez zmian modułów FREE/PRESELEKCJA, migracji, płatności, środowisk i sekretów. Aktualizacja gałęzi zadania nie jest scaleniem do integration ani main. Nie użyto force push.

- Polityka z PR #124 pozostaje `integration_merge_policy=verified_ci_review`; wymagania integration to `sc-agent/ci`, `sc-agent/review`, `sc-agent/integration-ready`, bez przywracania ręcznej bramki owner-acceptance. Produkcyjna bramka B zostaje osobna.
- PR #41 zachowuje job `authorize` bez środowiska/sekretów: main, workflow_dispatch, pierwsza próba, jawna flaga aktywacji oraz tożsamość kontrolera z polityki na SHA workflow. Rerun nie może odziedziczyć dostępu do płatnego review.
- Wyłącznie job model używa środowiska agent-review i OPENAI_API_KEY. Nie ma dostępu do sekretów kontrolera ani Cursora. Publish pozostaje bez sekretów środowiska.
- Preflight odczytuje ID agent-review i politykę dokładnie jednej gałęzi main; brak danych, inny ID, tag albo dodatkowa gałąź nie są PASS. ID 23622706434 pochodzi ze zrzutu GitHub właściciela z 2026-10-17; nie zastępuje aktualnego odczytu API.
- Nazwa joba agent-verify to `Agent verify / artifact`, odrębna od `verify` w zwykłym Checks. To nie jest syntetyczny sukces sc-agent/ci ani zastępstwo niezależnego review.
- Połączono testy preflightu z nowszym testem automatycznego integration, zamiast nadpisać regresje PR #124. Przykład konfiguracji i runbook kierują klucz OpenAI wyłącznie do agent-review.

## Zmienione pliki względem BASE_COMMIT

.github/agent-pipeline/config.example.json
.github/agent-pipeline/policy.json
.github/workflows/agent-review.yml
.github/workflows/agent-verify.yml
docs/sc-ops-002c-bootstrap-runbook.md
docs/sc-ops-002c-handoff.md
tests/agent-pipeline/http-world.mjs
tests/agent-pipeline/live-adapters.test.mjs
tests/agent-pipeline/review-dispatch.test.mjs
tests/agent-pipeline/workflows.test.mjs
tests/agent-pipeline/bootstrap-review-isolation.test.mjs
tools/agent-pipeline/authorize-review-dispatch.mjs
tools/agent-pipeline/lib/github.mjs
tools/agent-pipeline/lib/protection.mjs
tools/agent-pipeline/lib/reconcile.mjs
tools/agent-pipeline/lib/review-dispatch.mjs

DB / MIGRATIONS: brak zmian względem wskazanej integration; niczego nie zastosowano ponownie.

## Weryfikacja — rozdzielone rodzaje dowodów

Lokalnie: Node 22.16, `node --test tests/agent-pipeline/bootstrap-review-isolation.test.mjs`, 10/10 PASS, zero pominięć. Testy używają rzeczywistych czystych funkcji decyzji/przedkontroli i parsowanych plików YAML; nie wywołują API ani agentów. Zgodność odczytanych modułów z GitHub sprawdzona przez blob SHA. Pełne testy aplikacji uruchamia istniejący GitHub Actions po publikacji końcowego HEAD; ten dokument NIE twierdzi, że ich nowy wynik ani niezależny werdykt już istnieją.

Istotne lokalnie sprawdzone bloby: policy 88b6b947ba19d31bf7c2afd35cb43375bc406f3a; nowe testy b88b6e25fee3f18d7e83d35fec3c0b237f6b5812; review-dispatch 11616fbaa1b7b6a92b4a4f3076c53cbdb24bd051; protection b516a5f766df26923188e5f4fa5d5bb2050919ce; agent-review 00e8657f9217f4ef94b4c7ae7a364a7e80bf1ee9; agent-verify 7f29b627750f27db8042c9149d09736879323eb2.

## Blokady aktywacji pozostają

Controller App/actor IDs pozostają null w polityce; flags false. Nie przeprowadzono autoryzowanego testu ważności sekretów, budżetu ani pełnej płatnej pętli Cursor/Codex. Utworzony ruleset quality-gates 25299230 pozostaje disabled, ze zwykłymi checkami GitHub Actions zamiast kompletu dowodów App. To nie jest spełniony docelowy preflight. Poprawki nie są zainstalowane na main. Nakładający się PR #50 pozostaje niezmieniony i nie powinien być scalany jako drugi mechanizm; jego minimalny environment patch jest objęty tym PR.

## Następny etap

Codex ocenia dokładny końcowy HEAD, wszystkie istniejące P1/P2 oraz regresje po aktualizacji integration. Wymagany test całego agent-pipeline i pełne CI tego HEAD. Bez zatwierdzania własnego kodu, uruchamiania płatnego workflow, ujawniania sekretów, migracji, merge i Production. Po pozytywnych wynikach osobno zweryfikować skuteczność ochrony gałęzi i plan instalacji na chronionym main; nie zmieniać flag tylko po to, by test przeszedł.
