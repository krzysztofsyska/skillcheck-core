# SC-OPS-002C — konfiguracja repo przed aktywacją

TASK: SC-OPS-002C
STATUS: REVIEW (część repo); BLOCKED_CONFIGURATION (usługi)
BRANCH: chore/sc-ops-002c-bootstrap-config
BASE_COMMIT: 90af2e2eb3bfb19409deec4466c1be72af1d4d6c
COMMIT: patrz HEAD PR zawierającego ten raport
ISSUE: https://github.com/krzysztofsyska/skillcheck-core/issues/40

## Zmiany

- policy.json: rzeczywiste numery 6 workflow i istniejącego agent-control z API. Brakujące App/actor/gate IDs nadal null, flagi false.
- agent-review.yml: model tylko z main i z odrębnego środowiska agent-review. Sekret OpenAI nie wymaga dostępu do środowiska kontrolera.
- Runbook: oddzielny sekret review, jawne checks dla obu gałęzi zgodne z 002A/policy, aktualne dowody odczytu.
- Test kontraktu workflow: zaufana gałąź, osobne środowisko, jedyny odwołany sekret OPENAI_API_KEY i permissions contents:read.

DB / MIGRATIONS: brak

## Kontrole lokalne — Node 24.19.0

- npm ci: PASS
- npm run test:agent-pipeline: PASS, 44/44
- npm run agent:dry-run -- --fixture complete-cycle: PASS, external_calls=0, merge_calls=0, flagi false, zatrzymanie przy obu gates
- npm run typecheck: PASS
- npm run build: PASS
- git diff --check: PASS

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
HEAD: odczytaj rzeczywisty HEAD PR chore/sc-ops-002c-bootstrap-config i przypnij do raportu.
Przeczytaj Issue #40, AGENTS.md, projekt 002A, runbook 002C, cały diff i ten handoff. Sprawdź faktyczne numery workflow z GitHub i agent-control ID, flagi false, brak wymyślonych App/gate IDs, zgodność checks dla main/integration, środowisko agent-review tylko na main oraz brak poświadczeń kontrolera/Cursora w modelu. Zweryfikuj, że test statyczny nie jest przedstawiany jako dowód konfiguracji usług. Potwierdź ograniczony zakres 5 plików. Wykonaj npm run test:agent-pipeline i sprawdź CI bieżącego SHA. Nie wywołuj agentów, nie dodawaj sekretów, nie twórz środowisk ani rulesetów, nie scalaj i nie wdrażaj. Zapisz PASS / PASS WITH FIXES / FAIL z plikiem i konkretną uwagą na PR. Przy PASS następny etap to akceptacja tej poprawki; aktywacja nadal zablokowana przez braki usług z Issue #40. Podaj raport TASK/STATUS/HEAD/TESTS/UWAGI/NEXT ACTION i pełny kolejny prompt. Nie deklaruj pełnego 002C jako DONE.
