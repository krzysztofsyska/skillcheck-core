# SC-OPS-002B — handoff

TASK: SC-OPS-002B
STATUS: REVIEW
BRANCH: feat/sc-ops-002b-agent-orchestration
BASE_COMMIT: 579da382f976971392bc15239fded5417945c0f0
COMMIT: e1c7446452e85cec1ff02fbdb20683ebf440d6a9
HEAD PR: commit dokumentujący ten wynik CI; pełny SHA headu jest w opisie PR
PR: https://github.com/krzysztofsyska/skillcheck-core/pull/38
OWNER_APPROVAL: PENDING
PRODUCTION_APPROVAL: PENDING
REVIEW_VERDICT: PENDING
PROMOTION: NO

## Poprawki po CI

Run 37481618039 kończył się `fatal: bad object 579da382f976971392bc15239fded5417945c0f0` w teście allowlisty (15/16). Checkout CI ma głębokość 1 i nie zawiera tamtej bazy.

- Walidator allowlisty jest testem czystym i działa dla każdego zadania.
- Kontrola zakresu SC-OPS-002B uruchamia się tylko dla tego zadania albo gałęzi `feat/sc-ops-002b-agent-orchestration`.
- Brak obiektu gita jest błędem. Test nie zamienia błędu fetch na PASS i nie podstawia innego commita.
- `cli reconcile` czyta stan, liczy preflight i woła kontroler oraz adaptery.
- Brak konfiguracji przy włączonej fladze zwraca `NOT_CONFIGURED` i nie wykonuje efektów.
- Wyłączone flagi mogą policzyć przejście, ale tłumią efekty zewnętrzne, w tym powiadomienia.
- Poprawna konfiguracja idzie przez ten sam kod: odczyt Issue i `agent-state`, preflight, `tick`, adaptery Cursor i GitHub.

## Podział

IMPLEMENTED
- Kontroler, journal, adaptery i workflow z pierwszej implementacji.
- Wejście `reconcile` podłączone do odczytu stanu, preflightu, kontrolera i adapterów.
- Osobny test walidatora oraz kontrola zakresu tylko dla tego PR.

VERIFIED_OFFLINE
- Wyniki lokalne Node.js v24.11.0 są w sekcji kontroli. To nie jest wynik CI.

NOT_CONFIGURED
- GitHub App, środowiska `agent-control`, `owner-acceptance`, `production-approval`.
- Rulesety writers-only i quality-gates.
- Klucze Cursor i OpenAI, budżety, Production Branch Vercel.
- Numeryczne id workflow i id środowisk. Polityka używa kluczy symbolicznych.
- Monitor ChatGPT.
- Flagi w `policy.json` pozostają false. Workflow live startuje tylko, gdy zmienna `AGENT_PIPELINE_ENABLED` jest dokładnie `true`. Ta zmienna nie jest ustawiona.

NOT_RUN
- Prawdziwe API Cursor, OpenAI i mutacje GitHub.
- Zgody środowisk, ochrona gałęzi, merge, promocja, deploy, smoke test.
- Test połączenia #35 i #37 nie był powtarzany.

## Kontrole lokalne

Node.js v24.11.0. Wykonane w tym środowisku, nie w GitHub Actions.

- `npm ci` — exit 0, 111 packages. `package-lock.json` bez zmian.
- `npm run test:agent-pipeline` — 26 testów, 26 pass, 0 fail.
- `npm run agent:dry-run -- --fixture complete-cycle` — ok true, external_calls 0, merge_calls 0, repair_round 1, task READY_FOR_OWNER gate A, promotion READY_FOR_PROD gate B, obie flagi false.
- `npm run typecheck` — exit 0.
- `npm run build` — exit 0.

CI, osobno od wyników lokalnych
- Run 37481618039 na `0eceaf93277729ed9deaeff0aa2f63fa2bf43079`: FAIL. Job `verify`, `test:agent-pipeline` 15/16, `fatal: bad object 579da382f976971392bc15239fded5417945c0f0`.
- Run 37494786980 na `e1c7446452e85cec1ff02fbdb20683ebf440d6a9`: SUCCESS. Workflow Checks, job `verify`, w tym `npm run test:agent-pipeline`.
- Run 37494786947 na tym samym SHA: SUCCESS. Workflow Agent Gates.
- Ten plik dopisuje wynik tamtego CI. Workflow `verify` na commicie tej notatki jest w opisie PR i nie jest tym samym runem co 37494786980.

Nie uruchamiano `test:live` ani testów połączenia #35 i #37.

DB / MIGRATIONS: brak

## Odchylenia

- Rekord stanu ma oprócz kolumn z sekcji 4 projektu pola `technical_state` i `binding`.
- Identyfikatory workflow w polityce są symboliczne do czasu bootstrapu 002C.
- `pull_request` wykonuje plik workflow z commita PR. `agent-gates.yml` nie jest korzeniem zaufania. Zaufane CI i review uruchamia kontroler z `policy_sha` na `main`. Rulesety dopina 002C.
- Artefakty CI, review i znacznik zgody są zapisywane przez workflow, a reconcile odczytuje je przy następnej pętli. Brak artefaktu nie jest PASS.

## Aktywacja

Obie flagi zostają false. Włączenie i merge opisuje `docs/sc-ops-002c-bootstrap-runbook.md`. Ten PR nie jest zgodą właściciela.

## Następny krok

Pełne review implementacji przez Codex. Nie zaczynać bootstrapu SC-OPS-002C.

## Prompt review dla Codexa

Wykonawca: Codex. Miejsce: nowy przegląd pull requestu w `krzysztofsyska/skillcheck-core`. Koordynator przekazuje ten prompt przez GitHub. SHA w opisie PR jest headem po publikacji i jest SHA, które należy reviewować.

```text
ZADANIE: review SC-OPS-002B
REPO: krzysztofsyska/skillcheck-core
PR: https://github.com/krzysztofsyska/skillcheck-core/pull/38
HEAD: SHA headu PR #38 podane w opisie PR
BASE: 579da382f976971392bc15239fded5417945c0f0
SPECYFIKACJA: docs/sc-ops-002a-agent-orchestration.md
POZIOM: L3
SCOPE: OPERATIONS

Sprawdź zgodność ze specyfikacją 002A, a nie ze starym opisem automatyzacji.
Werdykt: PASS / PASS WITH FIXES / FAIL.

Potwierdź:
- flagi AGENT_PIPELINE_ENABLED i AGENT_PIPELINE_MERGE_ENABLED pozostają false
- brak sekretów, brak service_role, brak migracji
- zgoda A nie spełnia zgody B
- komentarz, label i pole PR nie są zgodą
- Cursor nie dostaje envVars z agentId
- CI i model nie dostają poświadczeń kontrolera
- wynik review jest walidowany schematem; „no major issues” nie jest PASS
- journal nie używa force i konflikt nie nadpisuje historii
- nieznany follow-up zostaje BLOCKED
- wyjątek SC-OPS-001 i obejście OPERATIONS zostały usunięte
- test allowlisty nie blokuje przyszłych zadań spoza SC-OPS-002B, a błąd gita nie jest PASS
- reconcile przy poprawnej konfiguracji woła kontroler, a brak konfiguracji i wyłączone flagi nie wykonują efektów
- testy są offline
- PR nie włącza automatyzacji, nie scala i nie wdraża

Nie uruchamiaj płatnych API, nie zmieniaj ustawień GitHub i nie scalaj.
Zapisz werdykt w PR.
```
