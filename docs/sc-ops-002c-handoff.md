# SC-OPS-002C — bootstrap bez aktywacji

TASK: SC-OPS-002C
STATUS: IMPLEMENTED / CI_AND_INDEPENDENT_REVIEW_REQUIRED
BRANCH: chore/sc-ops-002c-bootstrap-config
COMMIT: 0b0ecb7f6307efc4fb7b247b67d6bd3d73217ec7
CODE_TREE: b6a4a773bffcf628d5a85257935e0bbf03598f79
BASE_COMMIT: 1e2ec57ecfa2e0c9334ddfa5133145a2bc141240
ISSUE: https://github.com/krzysztofsyska/skillcheck-core/issues/40
PR: https://github.com/krzysztofsyska/skillcheck-core/pull/41

COMMIT wskazuje dokładny kod po naprawie konfliktu integration i następnej poprawce preflightu. Bezpośredni następca zmienia wyłącznie ten dokument. Końcowy HEAD, bieżące CI i niezależny werdykt muszą być potwierdzone w GitHub; żaden wcześniejszy PASS nie zatwierdza nowej rewizji.

## Implementacja i granice

Zachowano wszystkie pliki produktu z BASE_COMMIT. Integration została połączona INTO istniejącej gałęzi zadania przez merge z dwoma rodzicami, bez force i bez scalenia do integration/main. Brak zmian modułów FREE/PRESELEKCJA, migracji, płatności, sekretów i produkcji.

- Zachowano PR124 `integration_merge_policy=verified_ci_review` i `sc-agent/integration-ready`. Nie przywrócono owner-acceptance jako wymaganego checka zwykłych tasków integration. Jednorazowa akceptacja bootstrapu/aktywacji pozostaje osobna, podobnie jak produkcyjna bramka B.
- `authorize` nie ma środowiska ani sekretów. Czyta politykę z SHA workflow i wymaga main, workflow_dispatch, pierwszej próby, jawnej aktywacji i dokładnej tożsamości kontrolera. Model czeka na authorize, wchodzi tylko do agent-review i odwołuje się wyłącznie do OPENAI_API_KEY. Publish nie ma sekretów środowiska.
- Preflight sprawdza rzeczywiste ID agent-review i dokładnie jedną gałąź main. ID 23622706434 wpisano na podstawie GitHub UI właściciela z 2026-10-17; nie oznacza to zaliczonego API preflightu ani testu klucza.
- Naprawa P1 4302409588: `guardEffects` teraz wymaga `preflight.ok === true` dla zewnętrznych efektów niesymulowanego kontrolera. Wynik jest zastępowany w reconcile przez aktualny zaufany odczyt; stary pozytywny snapshot i sama flaga true nie dopuszczają Cursor create/followup ani workflow dispatch. Odmowa zachowuje wcześniejszą rezerwację i nie udaje wykonanego wywołania. Dziennik i raportowanie nie są deklarowane jako pozbawione wszystkich zapisów.
- `agent-verify.yml` publikuje job `Agent verify / artifact`, odrębny od zwykłego Checks `verify`. To nadal nie jest dowód `sc-agent/ci` wystawiony przez dedykowaną App.
- Zachowano regresje automatycznej integration i środowiska. Poprzednie dwa błędy CI dotyczyły usunięcia z runbooka jednorazowej akceptacji bootstrapu, nie zwykłego merge. Runbook ponownie rozróżnia te decyzje; istniejących asercji PR124 nie usunięto ani nie osłabiono.

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
tests/agent-pipeline/preflight-effects.test.mjs
tests/agent-pipeline/reconcile.test.mjs
tools/agent-pipeline/authorize-review-dispatch.mjs
tools/agent-pipeline/lib/controller.mjs
tools/agent-pipeline/lib/github.mjs
tools/agent-pipeline/lib/protection.mjs
tools/agent-pipeline/lib/reconcile.mjs
tools/agent-pipeline/lib/review-dispatch.mjs

DB / MIGRATIONS: bez zmian względem wskazanej integration; niczego nie wykonano ponownie.

## Dowody i wymagane testy

Poprzednia rewizja 6dc0b2a5efdd46a02452cae0fd6734c7b74a14f6: 10/10 nowych testów izolacji przeszło lokalnie na Node22.16; pełne CI zakończyło się błędem (178/180 agent-pipeline, dwie asercje dokumentacji). Ten wynik nie jest PASS dla nowego COMMIT.

Nowa poprawka dodaje 7 testów w preflight-effects.test.mjs: odmowa brakującego/nieprawidłowego preflightu; osobne flagi; izolacja symulacji; dryf środowiska/checków; brak zaufania do starego snapshotu i bezpieczne wznowienie; timeout przed efektami; rzeczywiste adaptery z atrapą HTTP dla 403, 404, innego ID i dodatkowej gałęzi. Pozytywny test reconcile wymaga teraz prawidłowego dowodu ochrony zamiast niebezpiecznego null.

Wymagane nowe wykonanie: npm run test:agent-pipeline, pełne Checks (typecheck, testy aplikacji, build i HTTP), Agent Gates i niezależny review dokładnego końcowego HEAD. Na moment utworzenia tego dokumentu nowe wyniki są PENDING. Testy HTTP używają syntetycznego transportu, nie realnych kluczy ani płatnych wywołań.

## Pozostałe blokady aktywacji

Controller App/actor IDs pozostają null w polityce; flags false. Brak potwierdzonego budżetu, ważności sekretów, pełnego testu żywej pętli i instalacji na chronionym main. Ruleset quality-gates 25299230 pozostaje disabled ze zwykłymi checkami GitHub Actions, nie pełnym kompletem dowodów App. PR50 nakłada się na tę poprawkę i pozostaje niezmieniony; nie uruchamiać drugiego mechanizmu ani drugiego autora na tej gałęzi.

## Następny etap

Niezależny Codex ocenia nowy HEAD, w szczególności P1 o skuteczności preflightu przed płatnym dispatch, istniejące P1/P2 i regresje po aktualizacji integration. Poprawki pozostają na tej samej gałęzi. Bez ujawniania sekretów, płatnych workflow, aktywacji, migracji, merge i Production. Po PASS osobno zweryfikować rzeczywiste zabezpieczenia oraz plan instalacji; nie włączać flag tylko po to, by kontrola przeszła.
