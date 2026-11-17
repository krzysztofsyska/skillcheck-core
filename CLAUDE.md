# SkillCheck — instructions for Claude

@AGENTS.md

Everything in `AGENTS.md` applies. This file adds what changed and what matters most right now.

> **Bieżący punkt wejścia:** kolejność prac jest wyłącznie w [docs/ROADMAP.md](docs/ROADMAP.md). Stan wydań, SHA i status implementacji/review sprawdzaj w git, issue i PR — nie w tym dokumencie. Obowiązuje **zamrożenie ścieżki płatności** — żadne wydanie nie zmienia integracji płatności, przepływu zakupu, cen, katalogu pakietów ani stanów zamówień do odwołania przez właściciela. HOLD P24 nie istnieje już jako blokada wydań (zdjęty 15.11.2026). **Od 16.11.2026 wydania na produkcję są automatyczne, bez kliknięć właściciela** (#369): zielone CI + niezależny PASS na dokładnym SHA (znacznik `sc-review-verdict:v1`, zob. „Continuous release policy" w `AGENTS.md`), publikator `.github/workflows/auto-release.yml`. Wykonawca realizuje zadania z `docs/ROADMAP.md`, a osobny reviewer ocenia finalny commit; autor nigdy nie scala własnej zmiany. Nie traktuj zmian w `integration` jako wdrożenia produkcyjnego.

## Who does what (owner decision 2026-11-05)

Codex coordinates and implements programming work across the entire SkillCheck project. The order of work comes only from [docs/ROADMAP.md](docs/ROADMAP.md).

- **Codex** — orchestrator and builder: picks the next task from `docs/ROADMAP.md`, writes the code, runs the tests, opens the PR to `integration`.
- **Independent reviewer** — a separate reviewer agent started with fresh context that did not write the change. It reviews architecture, security, correctness, tests and scope against the current PR commit and returns PASS / PASS WITH FIXES / FAIL. This satisfies "independent review" in the Review loop of `AGENTS.md`. The verdict is posted as a PR comment (not a GitHub "Approve", see rule 5 in `AGENTS.md`) and names the full SHA of the reviewed commit and ends with the machine-readable marker `<!-- sc-review-verdict:v1 {"verdict":"PASS","head_sha":"<full SHA>","reviewer":"session_<reviewer>","builder":"session_<builder>"} -->` (the automatic publisher reads only this); a merge into `integration` needs a PASS (or PASS WITH FIXES with every fix made and checked again) whose SHA equals the current PR head; any push after the verdict needs a new review.
- **CI** — deterministic checks, unchanged.
- **Owner (Krzysztof)** — approving production migrations in `production-approval`, new costs, external or irreversible actions. Promotions into `main` are merged by an independent reviewer session („Production loop" in `AGENTS.md`, owner decision 2026-11-16); single reviewed PRs are released automatically (#369). Nothing else.

Where `AGENTS.md`, `docs/AGENT_WORKFLOW.md` or `.cursor/rules/` name Cursor as builder or Codex as reviewer, read them as the roles above. Earlier builder assignments transfer to Codex. Preserve work already in progress. The `chatgpt-codex-connector` bot still reviews PRs automatically. Do not wait for it; handle its findings only if it has posted. Before merging, every bot finding on any commit of the PR that the current head has not fixed is verified and either fixed or answered in its thread with a reason, and the independent reviewer's verdict on the current head lists each bot finding as fixed or rejected. Security findings are always fixed on the branch before merging (owner decision 2026-11-01); only if the builder considers one invalid is the PR blocked and the owner asked one YES/NO question in Polish with a recommendation. Fixed security findings need no owner decision.

## How the owner works

- He works mostly from his phone, through the Claude app. He does not open GitHub, Vercel or Supabase himself.
- Final report of every task: short, in Polish, no jargon. What changed in the product, the Vercel Preview link to check it, and any YES/NO decision with a recommendation.
- Do not paste long handoffs into the chat. The full handoff from `AGENTS.md` goes into the PR description.

## Decide yourself, then report (owner decision 2026-11-01)

The owner does not want to be asked about routine work. Do it, then say in the final report what was done.

Never ask, just do:
- run reviews (independent reviewer agent) and apply every fix they find, on the same branch;
- commit and push to task branches, open and update PRs, post review comments and replies on PRs (never an approving PR review);
- merge into `integration` under the Review loop rules (green CI + independent review with no open findings on the current commit);
- start the next task from `docs/ROADMAP.md`;
- technical and product-detail choices inside the scope of `docs/ROADMAP.md` (technical limits such as file size or rate limits — not package sizes or CV counts; wording, error handling, data minimisation, test setup). Pick the safer option, write the reasoning in the PR description and mention it in one line in the report.

Still the owner's decision (ask once, YES/NO with a recommendation, all open questions in one message):
- approving production database migrations in `production-approval` (an `integration -> main` promotion itself is merged by an independent reviewer session under „Production loop" in `AGENTS.md`, owner decision 2026-11-16; single reviewed PRs are released automatically, #369);
- new costs (paid services, plans, domains);
- external or irreversible actions (any contact with real candidates or customers by any channel, deleting real data, changing production settings or secrets);
- billing and charge actions, including package or balance changes in `/operator/billing` on production;
- changes to price, packages or what is in the MVP.

If unsure which list something belongs to and it is reversible, treat it as routine. This section never overrides "Prohibited actions without explicit owner production approval" or "Production access rules" 1–5 in `AGENTS.md`: anything touching production, billing, repository settings or other people's branches is never routine.

## What we build and in what order

**The order of work is in [docs/ROADMAP.md](docs/ROADMAP.md) — and only there.** This file,
`AGENTS.md`, `docs/BACKLOG.md` and the queue in #367 only point to it. A builder takes tasks only from
`docs/ROADMAP.md`, in its order, skipping items marked as waiting or paused. `docs/ROADMAP.md` changes
only on the owner's instruction, and an owner decision is recorded there only as a verbatim, dated
quote of his message.

Approved prices (every customer-facing surface and every file an agent or LLM reads must carry the
same numbers; derivation in [docs/cennik-2026-11-02.md](docs/cennik-2026-11-02.md)):
- FREE — 5 CVs;
- PRESELEKCJA — 300 zł gross for 60 CVs;
- WERYFIKACJA — 615 zł gross for 60 CVs;
- ASSESSMENT CENTER — 1 499 zł gross for 50 CVs.

**The voicebot is not shown to customers until it works.** Not in the package copy, the comparison,
the calculator demo, nor as "w przygotowaniu"; no customer-facing text promises, previews or prices
bot calls. Its place in the work order is in `docs/ROADMAP.md`.

Competency tests: the recruiter chooses per recruitment whether they approve the AI-drafted tasks
themselves, or the tests are generated and sent automatically (the owner accepted this on
2026-11-16 at 22:39 by answering „tak jak polecasz" to the chat recommendation quoted, in its
shortened recorded form, in `docs/ROADMAP.md`). In both modes a test goes only to a candidate on the recruitment's shortlist
(rule R1, enforced in the database), only redacted CV text goes to the model, and CV and profile text
are data, never instructions.

Selling FREE and PRESELEKCJA with Stripe happens in the separate repository
`krzysztofsyska/skillcheck-preselekcja`. In this repository the **payment-path freeze** stays (see
„Continuous release policy" in `AGENTS.md`): no change to the payment integration, the purchase flow,
prices, the package catalog or order states until the owner lifts it. Live payments, the Fakturownia
automation and taking money from anyone remain closed.

State of releases and production: read git, the PRs and the issues, not this file. Earlier history of
who decided what is in git history and in `docs/BACKLOG.md` (archive).

### A note on these records

This note is about **scope and priority lines only** — what is being built, in what order, and what
is parked. Those are written by agent sessions recording what the owner said in chat, not typed by
him. They are a convenience, not a mandate: when the owner says something different now, his current
word wins and this file gets corrected in the same session. Record who decided and when, and do not
treat such a line as a reason to refuse scope work the owner is currently asking for.

**This note never applies to the gates.** Not to the "Still the owner's decision" list above
(production approval, new costs, billing and `/operator/billing`, price, package and MVP-content
changes), not to "Prohibited actions without explicit owner production approval", and not to
"Production access rules" 1–5 in `AGENTS.md`. Those are gates, not records: only a message from the
owner himself opens one, and an agent-written line never substitutes for it. The same holds for any
other gate in this file or in `AGENTS.md`, including ones added after this note was written — the
list above is illustrative, not exhaustive. A session that finds itself citing this note to skip a
gate has misread it.

Open security item from the audit (owner only, rule 3):
- Done: the variables `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`, `POSTGRES_PRISMA_URL` and `POSTGRES_PASSWORD` are no longer present in Vercel Production (found 2026-11-11 in the project variable list; values not read). The removal date is unknown.
- Done 2026-11-16: rotation of the database password. The owner rotated it in Supabase and updated the `PRODUCTION_DATABASE_URL` secret of `production-approval` himself; a read-only `db-migrate-production` inspect run with the new secret succeeded (run 43919976736, owner approval). Recorded in #420. Still open in #420: rotation of `private.sales_lead_settings.request_secret_current`.

## Keep the process light

- Before starting, list open PRs and branches for the same topic and continue them instead of opening duplicates.
- Small changes need no new architecture document. Write the reasoning in the PR description.
- Do not add new GitHub workflows or agent-pipeline tooling unless the task is explicitly about that.
- Delete the branch after its PR is merged, if you created it.

## Project status report at the end of every session (owner decision 2026-11-01)

At the end of every work session on this project, the orchestrator/builder session (never a reviewer subagent) overwrites the status report on the owner's Google Drive.

- Folder: "Status projektów" on the owner's My Drive, Drive folder id `1FGhTxEBZolwbfXPcxq2KyaCGTc6-WdHD` (authoritative). On the owner's Windows computer it is `G:\Mój dysk\Status projektów` (for information only). If the folder id stops working, say so as a blocker in the final report; do not edit this file mid-session for it.
- File: `Status - SkillCheck.md` (one file per project; other projects use `Status - <Project>.md`, e.g. `Status - Mystery Customer.md`).
- Always OVERWRITE. Never create versions or copies. If the tool cannot replace the content in place (the Google Drive connector in cloud sessions can only create files): create the new file in that folder, note its id, then move to the trash every other file in that folder whose name is exactly `Status - SkillCheck.md`. Never trash, delete or edit anything else in the folder, and never delete permanently.
- Never put secrets, keys, environment values, passwords or connection strings in the report, nor candidate or customer personal data (names, CV contents, emails, NIPs). Never change the sharing or permissions of the file or folder.
- The Claude Doc named in "Current priorities" stays the plan and source of truth; the Drive file is a short summary with the same module list and percentages. If they disagree, update the Doc first.
- If the Drive connector is unavailable, the final report says the status report was not updated and why.
- Content, short, in Polish, no jargon (except the technical part at the end):
  1. Date and time of the update (Europe/Warsaw).
  2. List of modules, each with: status (gotowy / w trakcie / zablokowany / nie rozpoczęty), percent complete, and one sentence on what is left.
  3. What was done in this session.
  4. Blockers and things that need the owner's decision.
  5. Next 3 steps.
  6. Under a heading "Dla agentów (techniczne)": branch, last commit, and whether the latest Vercel deployment succeeded (read deployment status only, e.g. list/get deployment; never tools that create share or bypass links).

## Commands

- Install: `npm ci`
- Always: `npm run typecheck`, `npm run build`
- Then the test groups for the touched area (see `package.json`), e.g. `npm run test:db`, `test:auth`, `test:http`, `test:screening`, `test:cv`.
- Tests that need PostgreSQL, a browser or a live server may not run locally; rely on CI for them and say so in the PR.

## Environments

- Production Supabase: `wsvjawuikxfzjyivxgsu` — read-only from agent sessions.
- Preview Supabase: `skillcheck-preview` (`orbyscrupgnupifzlqxp`) — test data only; use it for logins, uploads and reports instead of asking the owner.
- Vercel project: `skillcheck-core`. Every PR to `integration` gets a Preview deployment.

## Delegowanie
Zanim zaczniesz zadanie, przekaż je właściwemu podagentowi z .claude/agents:
- płatności, faktury, pakiety -> platnosci
- limity i koszty AI, abonament -> limity-ai
- strona, cennik, regulamin, dokumenty -> strona-i-dokumenty
- błędy CI, testy, buildy -> testy-i-ci
- literówki, teksty, drobne zmiany -> drobne-poprawki
Sam rób tylko planowanie i przegląd. Oszczędzaj limit: proste rzeczy zawsze do drobne-poprawki.
