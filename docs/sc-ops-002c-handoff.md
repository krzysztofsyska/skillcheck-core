# SC-OPS-002C — konfiguracja repo przed aktywacją

TASK: SC-OPS-002C
STATUS: REVIEW (część repo); BLOCKED_CONFIGURATION (usługi)
BRANCH: chore/sc-ops-002c-bootstrap-config
BASE_COMMIT: 90af2e2eb3bfb19409deec4466c1be72af1d4d6c
COMMIT: 2c51ad0728d00cd1efc2d0ee3274152666737de2
PIN: commit po tym SHA zmienia wyłącznie identyfikator w tym raporcie. Kontrole poniżej dotyczą COMMIT.
ISSUE: https://github.com/krzysztofsyska/skillcheck-core/issues/40

## Zmiany

- policy.json: rzeczywiste numery 6 workflow i istniejącego agent-control z API. `agent_review.id` jest null, tak jak brakujące App/actor/gate IDs. Flagi false.
- agent-review.yml: job `model` dostaje środowisko `agent-review` dopiero po `authorize`, i tylko przy `github.run_attempt == 1`. Authorize czyta `policy.json` z SHA workflow, nie z wejścia dispatch, i wpuszcza dalej tylko przy `AGENT_PIPELINE_ENABLED=true` oraz gdy `github.actor_id` jest równy dodatniemu `controller_actor_id`. Ponowienie zachowuje aktora pierwszej próby, więc nie wchodzi do sekretu. Sekret OpenAI nie wymaga dostępu do środowiska kontrolera.
- Preflight: odczyt i potwierdzenie środowiska `agent-review` obejmuje numeryczne ID oraz politykę gałęzi dokładnie `main`. Brak recenzenta właściciela na tym środowisku jest zgodny z runbookiem. Bez ID preflight i konfiguracja live pozostają zamknięte.
- config.example.json: `OPENAI_API_KEY` jest opisany jako sekret środowiska `agent-review`. Klucze kontrolera i Cursora zostają przy `agent-control`.
- Runbook: oddzielny sekret review, warunek wejścia joba modelu, jawne checks dla obu gałęzi zgodne z 002A/policy, aktualne dowody odczytu.
- Test kontraktu: bramka dispatch, przykładowa mapa sekretów, zaufana gałąź, osobne środowisko, jedyny odwołany sekret OPENAI_API_KEY i permissions contents:read.

DB / MIGRATIONS: brak

## Kontrole lokalne — Node 24.19.0

Poprzedni odbiór na 42826d80c91609ef8ce06da93bdef51c2b3345ba: npm ci, test:agent-pipeline 44/44, dry-run, typecheck i build PASS.

Ten diff, binarka Node v24.19.0, po odmowie rerunów i preflight `agent-review`:
- npm run test:agent-pipeline: PASS, 47/47 (nowe asercje są w istniejących testach)
- npm run agent:dry-run -- --fixture complete-cycle: PASS, external_calls=0, merge_calls=0, flagi false, zatrzymanie przy obu gates
- git diff --check: PASS
- typecheck i build: uruchamia je CI tego SHA. Nie są dowodem bramki dispatch ani preflightu.

## Znane

`controller_actor_id` i `agent_review.id` zostają null, więc nawet przy ręcznie ustawionej zmiennej `AGENT_PIPELINE_ENABLED` skrypt i preflight odmawiają. Bramka obowiązuje dopiero w pliku workflow na `main`; ten PR jej nie scala i nie włącza flag. Uwagi o dispatchu kontrolera i przykładzie sekretu są zamknięte w ffa601dd9b3a6d26e8f2f3d922b144193df2bf02.

To testy offline; nie potwierdzają dostępu API agentów, izolacji sekretów na koncie ani rzeczywistych zgód.

## Usługi i blokery

Nie zmieniono ustawień GitHub/Vercel, sekretów ani flag. Brak agent-state, środowisk owner-acceptance/production-approval/agent-review i potwierdzonych danych dedykowanej App. Rulesets API puste; klasyczna ochrona main niedostępna (403). Istniejący agent-control wymaga ograniczenia do main. Budżety i klucze API niezweryfikowane. Wtyczka Vercel została połączona przez właściciela w trakcie tego etapu; sam ten fakt nie konfiguruje GitHub App.

## Projekt produkcyjnego runbooku — do osobnej akceptacji

Zakres przyszłej promocji: tylko jawnie wyliczone zadania i SHA. Vercel automatycznie wdraża main, bez dodatkowego deploy. Ten zakres nie wykonuje migracji ani zmian sekretów. Odbiór: deployment właściwego SHA zakończony, HTTP 200 i oczekiwana treść /, /demo, /login. Rollback: przygotowany revert przez PR z własną zgodą; bez reset/force. Nie utworzono jeszcze aktywnego production-runbook.json.

## Następny pełny prompt

WYKONAWCA: niezależny Codex reviewer, nowa sesja po odczycie PR; raport przez GitHub, bez kopiowania przez właściciela.
ZADANIE: review SC-OPS-002C, część konfiguracji repo
REPO: krzysztofsyska/skillcheck-core
BAZA: 90af2e2eb3bfb19409deec4466c1be72af1d4d6c
HEAD: 2c51ad0728d00cd1efc2d0ee3274152666737de2
Przeczytaj Issue #40, AGENTS.md, projekt 002A, runbook 002C, cały diff i ten handoff. Sprawdź faktyczne numery workflow z GitHub i agent-control ID, flagi false, brak wymyślonych App/gate IDs, zgodność checks dla main/integration oraz brak poświadczeń kontrolera/Cursora w modelu. Dla płatnego joba sprawdź, że środowisko `agent-review` jest osiągalne tylko po `authorize`: flaga `AGENT_PIPELINE_ENABLED`, aktor równy `controller_actor_id` z policy na SHA workflow, a nie z wejścia dispatch. Sprawdź, że przykład sekretów trzyma OpenAI w `agent-review`. Zweryfikuj, że test statyczny nie jest przedstawiany jako dowód konfiguracji usług. Wykonaj npm run test:agent-pipeline i sprawdź CI bieżącego SHA. Nie wywołuj agentów, nie dodawaj sekretów, nie twórz środowisk ani rulesetów, nie scalaj i nie wdrażaj. Zapisz PASS / PASS WITH FIXES / FAIL z plikiem i konkretną uwagą na PR. Przy PASS następny etap to akceptacja tej poprawki; aktywacja nadal zablokowana przez braki usług z Issue #40. Podaj raport TASK/STATUS/HEAD/TESTS/UWAGI/NEXT ACTION i pełny kolejny prompt. Nie deklaruj pełnego 002C jako DONE.


## Stan właścicielskiej konfiguracji agent-review — 2026-10-17

Właściciel potwierdził zrzutem z GitHub `agent-review` pod adresem środowiska o ID `23622706434`: 1 dozwolona gałąź `main`, 0 tagów, brak wymaganych reviewerów i timera. `OPENAI_API_KEY` jest na liście sekretów `agent-review` (wartość/ważność/budżet niezweryfikowane). Nowa rewizja PR zapisuje ten **identyfikator z UI** w `policy.json` i aktualizuje asercję offline. Pozostały preflight odczytu środowiska musi jeszcze porównać rzeczywiste API; nie twierdzi się, że PASS. `controller_actor_id` nadal null, flags false. Ten dopisek nie oznacza automatycznej aktywacji, review ani produkcyjnej gotowości.
