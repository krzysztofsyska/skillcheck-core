# SC-OPS-002B — handoff

TASK: SC-OPS-002B
STATUS: REVIEW
BRANCH: feat/sc-ops-002b-agent-orchestration
BASE_COMMIT: 579da382f976971392bc15239fded5417945c0f0
COMMIT: 66bcf90e30682066145a9f89f0b61f6094024006
PR: https://github.com/krzysztofsyska/skillcheck-core/pull/38
OWNER_APPROVAL: PENDING
PRODUCTION_APPROVAL: PENDING
REVIEW_VERDICT: PENDING
PROMOTION: NO

## Podział

IMPLEMENTED
- Czysta funkcja przejść i osobne adaptery efektów w `tools/agent-pipeline/`.
- Journal `agent-state` z compare-and-swap bez force.
- Adapter Cursor API v1 (`/v1/agents`, follow-up `/runs`, uzgodnienie GET i listy runs).
- Walidator review i CI, digest zgód A i B, preflight merge, outbox powiadomień.
- Workflow reconcile, verify, review, accept, promote oraz klasyfikacja gates bez wyjątku SC-OPS-001 i bez obejścia OPERATIONS.
- Flagi w `policy.json`: obie false. Dry-run nie wykonuje efektów sieciowych.

VERIFIED_OFFLINE
- 12 grup testów z sekcji 12 projektu, składnia workflow, model uprawnień i allowlista plików.
- `npm run agent:dry-run -- --fixture complete-cycle`: jedna poprawka, zatrzymanie na A i B, zero wywołań sieci i zero merge.
- Wyniki komend Node 24 są w sekcji kontroli poniżej i w opisie PR.

NOT_CONFIGURED
- GitHub App, środowiska `agent-control`, `owner-acceptance`, `production-approval`.
- Rulesety writers-only i quality-gates.
- Klucze Cursor i OpenAI, budżety, Production Branch Vercel.
- Numeryczne id workflow i id środowisk. Polityka offline używa stabilnych kluczy symbolicznych.
- Monitor ChatGPT.

NOT_RUN
- Prawdziwe API Cursor, OpenAI i mutacje GitHub.
- Zgody środowisk, ochrona gałęzi, merge, promocja, deploy, smoke test.
- Test połączenia #35 i #37 nie był powtarzany.
- Testy mocków nie są testem działającej integracji.

## Kontrole

Node.js v24.11.0.

- `npm ci` — exit 0, 111 packages.
- `npm run test:agent-pipeline` — 16 testów, 16 pass, 0 fail.
- `npm run agent:dry-run -- --fixture complete-cycle` — ok true, external_calls 0, merge_calls 0, repair_round 1, task READY_FOR_OWNER gate A, promotion READY_FOR_PROD gate B, obie flagi false.
- `npm run typecheck` — exit 0.
- `npm run build` — exit 0.

Nie uruchamiano `test:live` ani testów połączenia #35 i #37.

DB / MIGRATIONS: brak

## Odchylenia

- Rekord stanu ma oprócz kolumn z sekcji 4 projektu pola `technical_state` i `binding`. Kolumny z projektu nie mieszczą zamrożonych plików, fazy dispatch ani digestu zgody.
- Identyfikatory workflow w polityce są symboliczne do czasu bootstrapu 002C.
- `pull_request` na GitHubie wykonuje plik workflow z commita PR. Klasyfikacja w `agent-gates.yml` nie jest korzeniem zaufania. Zaufane CI i review uruchamia kontroler z `policy_sha` na `main`. Rulesety dopina dopiero 002C.

## Aktywacja

Obie flagi zostają false. Włączenie i merge opisuje `docs/sc-ops-002c-bootstrap-runbook.md`. Ten PR nie jest zgodą właściciela.

## Następny krok

Review implementacji przez Codex. Potem osobny SC-OPS-002C. Nie uruchamiać automatyzacji i nie zaczynać SC-SALES-006B/C/D.

## Prompt review dla Codexa

Wykonawca: Codex. Miejsce: nowy przegląd pull requestu w `krzysztofsyska/skillcheck-core`, nie kontynuacja czatu właściciela. Koordynator przekazuje ten prompt przez GitHub.

```text
ZADANIE: review SC-OPS-002B
REPO: krzysztofsyska/skillcheck-core
PR: https://github.com/krzysztofsyska/skillcheck-core/pull/38
HEAD: 66bcf90e30682066145a9f89f0b61f6094024006
BASE: 579da382f976971392bc15239fded5417945c0f0
Uwaga: commit handoffu jest późniejszy i tylko uzupełnia ten raport. Review obejmuje cały head PR #38.
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
- testy 12 grup są offline
- PR nie włącza automatyzacji, nie scala i nie wdraża

Nie uruchamiaj płatnych API, nie zmieniaj ustawień GitHub i nie scalaj.
Zapisz werdykt w PR.
```
