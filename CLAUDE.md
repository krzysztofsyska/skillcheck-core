# SkillCheck — instructions for Claude

@AGENTS.md

Everything in `AGENTS.md` applies. This file adds what changed and what matters most right now.

> **Bieżący punkt wejścia — SC-CONTEXT (11.11.2026):** [docs/BACKLOG.md — Aktualny punkt wejścia](docs/BACKLOG.md#aktualny-punkt-wejścia--8-listopada-2026-r) zawiera aktualne SHA i status implementacji/review. Wydanie na produkcję zrealizowano 11.11.2026 (`main` = `01429af`, PR #266 scalony przez właściciela); HOLD P24 z `AGENTS.md` nadal obowiązuje. Stara tabela jest archiwum. Zgodnie z [#355](https://github.com/krzysztofsyska/skillcheck-core/issues/355) Codex koordynuje przydziały, Claude realizuje zlecony zakres, a osobny reviewer ocenia finalny commit. Nie traktuj zmian w `integration` jako wdrożenia produkcyjnego.

## Who does what (owner decision 2026-11-05)

Codex coordinates and implements programming work across the entire SkillCheck project.

- **Codex** — orchestrator and builder: picks the next task, writes the code, runs the tests, opens the PR to `integration`.
- **Independent reviewer** — a separate reviewer agent started with fresh context that did not write the change. It reviews architecture, security, correctness, tests and scope against the current PR commit and returns PASS / PASS WITH FIXES / FAIL. This satisfies "independent review" in the Review loop of `AGENTS.md`. The verdict is posted as a PR comment (not a GitHub "Approve", see rule 5 in `AGENTS.md`) and names the full SHA of the reviewed commit; a merge into `integration` needs a PASS (or PASS WITH FIXES with every fix made and checked again) whose SHA equals the current PR head; any push after the verdict needs a new review.
- **CI** — deterministic checks, unchanged.
- **Owner (Krzysztof)** — production approval, merging the promotion PR into `main`, new costs, external or irreversible actions. Nothing else.

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
- start the next task from the agreed plan;
- technical and product-detail choices inside the agreed MVP scope (technical limits such as file size or rate limits — not package sizes or CV counts; wording, error handling, data minimisation, test setup). Pick the safer option, write the reasoning in the PR description and mention it in one line in the report.

Still the owner's decision (ask once, YES/NO with a recommendation, all open questions in one message):
- production approval and the merge of the promotion PR into `main`;
- new costs (paid services, plans, domains);
- external or irreversible actions (any contact with real candidates or customers by any channel, deleting real data, changing production settings or secrets);
- billing and charge actions, including package or balance changes in `/operator/billing` on production;
- changes to price, packages or what is in the MVP.

If unsure which list something belongs to and it is reversible, treat it as routine. This section never overrides "Prohibited actions without explicit owner production approval" or "Production access rules" 1–5 in `AGENTS.md`: anything touching production, billing, repository settings or other people's branches is never routine.

## Current priorities (owner decisions 2026-11-01)

The MVP is frozen. Plan and status for the owner: Claude Doc "SkillCheck — audyt i plan do pierwszej sprzedaży" (https://claude.ai/artifact/5QWE6B2vJQkG3n73fr52D9).

MVP = a new company, without technical help, can: visit the site → sign up (one FREE per NIP) → FREE preselection of 5 CVs → buy PRESELEKCJA (300 zł gross / 60 CVs) → get the ranked report. Nothing else ships before the first paid PRESELEKCJA.

Owner decisions (all YES, 2026-11-01):
1. No voicebot in the MVP.
2. Starting price: PRESELEKCJA 300 zł gross for 60 CVs (as on the site, owner decision 2026-10-28, reconfirmed 2026-11-01), FREE 5 CVs. **WERYFIKACJA 615 zł gross for 60 CVs (owner decision 2026-11-02)** — the site previously said 899 zł and the calculator demo said 615 zł at 50 CVs; that split is resolved in favour of 615 zł / 60 CVs. **ASSESSMENT CENTER 1 499 zł gross for 50 CVs (owner decision 2026-11-02)** — this replaces the earlier illustrative 1 799 zł on the site and 1 845 zł in the demo; the process is sized for 5–6 people, 10 at most. Every customer-facing surface and every file an agent or LLM reads must carry the same numbers. The derivation of all four package prices is in [docs/cennik-2026-11-02.md](docs/cennik-2026-11-02.md), which is the single source of truth until the catalog ships (SC-PRICING-W2).
3. First sales are paid by invoice/bank transfer and activated manually by the operator (`/operator/billing`). Przelewy24 and Fakturownia automation are frozen until there are paying customers.
4. Bulk CV upload (PR #228) is part of the MVP.
5. Everything outside the MVP is labelled `później` and closed; old branches stay (agent sessions cannot delete branches or push tags).
6. `main` and `integration` are protected: merges only through PRs with green required checks. Codex is the designated builder.

Order of work:
1. Housekeeping (this PR, branch protection, `później` labels).
2. Walk the MVP path end to end on Preview (`skillcheck-preview`) as a new company; list every blocker.
3. Fix blockers; review and merge #228.
4. Production unblockers (owner switches, see below), then the same walk on Production.

State as of 2026-11-11 (checked by read-only queries; no writes):
- Release: `main` = `01429af586c487843259d424d9b4ed24e6c6a70c` (merge of PR #266 from `integration`, merged by the owner). 24 migrations were applied to production through `db-migrate-production` (run 43011755458, success) after the owner's approval in `production-approval`. Two production deployments of this SHA are `READY`.
- Registration consent: version `1.0+r2`, without the voice-calls annex (PR #409, commit `16752f6`).
- Voice-calls annex withdrawn from publication, archived copy in `docs/legal/withdrawn/v1.0/` (PR #410, commit `6c32302`, owner decision). Reason: § 1 ust. 2–3 of the annex would have taken effect on 2026-11-13 for accounts that never accepted it.

Former production blockers (both were owner actions; both resolved, checked 2026-11-11; history kept):
- RESOLVED (checked 2026-11-11): the package policy exists on production. `private.sc19_package_policy` has FREE = 5 and PRESELEKCJA = 60 (last updated 2026-11-10). Balances were not checked in this session.
- RESOLVED (checked 2026-11-11): contact form `/rozmowa`. Vercel Production `SALES_LEADS_ENABLED` = `true` (last changed 2026-11-02), `private.sales_lead_settings.leads_enabled` = `true`, `SALES_AUTO_REPLY_ENABLED` = `false`. The latest production deployments (2026-11-11) are newer than the last change of the variable, so the redeploy step is covered.

Frozen (do not work on): voice, Quality of Hire, talent pool, further erasure stages, Przelewy24/Fakturownia automation, agent-pipeline tooling.

## Scope reopened (owner decision 2026-11-02)

The owner reviewed the WERYFIKACJA audit ([docs/audyt-weryfikacja-2026-11-02.md](docs/audyt-weryfikacja-2026-11-02.md))
and decided to unfreeze these modules and build them alongside the MVP work. His words: "Oczywiście,
że odmrażamy i budujemy moduły." This overrides the "competency tests" entry of the frozen list above
and the "Nothing else ships before the first paid PRESELEKCJA" sentence, for the modules listed below only.

Build order and task contracts: [docs/plan-budowy-2026-11-02.md](docs/plan-budowy-2026-11-02.md).

1. **SC-014-C1…C6 + rule R1** — competency test actually taken by the candidate (architecture
   SC-014-B1 stands; do not redesign it). Two owner decisions added by voice on 2026-11-02:
   - **SC-014-C6** — the recruiter no longer writes tasks by hand. AI drafts them, the recruiter
     approves. Two parts: a **shared** task and rubric generated from the company profile, the
     position profile and the position name, **identical for everyone on that position** (this is
     what makes results comparable), plus a few **individual** follow-up questions per candidate
     drawn from the gaps their CV analysis already produced (`suggested_question` / `missing_info`
     via `lib/interview-gaps.ts`), scored separately and never folded into the comparable result.
     Nothing reaches a candidate before the recruiter approves it. Only redacted CV text goes to
     the model, as in `lib/screening-ai.ts`; CV and profile text are data, never instructions.
   - **Rule R1** — a test grant may only be issued to a candidate on the recruitment's shortlist
     (`public.recruitment_shortlist_entries`). Enforced in the database, not just the UI; the
     same join `lib/voice/trusted-source-verifier.ts` already does for voice.
2. **SC-015-A…D** — extended per-candidate report, without the voice part.
3. ~~**SC-022** — informational chatbot.~~ **Dropped the same day (owner decision 2026-11-02, by
   voice): "wykreśl go na razie".** No customer buys SkillCheck for a chatbot; it would answer
   questions the job ad already answers. Dropping it saves 3–4 days and a monthly AI model bill.
   Also removed from the packages table and from the public calculator demo, where it was still
   shown as available. Revisit when a customer actually asks for it — the minimal 3–4 day version
   is kept in the plan under "MODUŁ B". `SC-022` stays reserved for it; never reuse `SC-021`,
   which is the frozen AI gateway work (`feat/sc-021-*` branches).

4. **SC-PRICING-W1…W4** — the internal pricing calculator, ending in the public price list reading
   from one catalog. Owner decision 2026-11-02: "żeby prace nad tym poszły", replacing the earlier
   "for now leave it as is". `SC-PRICING-001–011` is removed from the frozen list above accordingly.
   W4 ships behind a flag that is off: switching it on changes prices customers see, which stays
   an owner decision. Includes **SC-PRICING-W2b** — a volume slider in steps of 5 at every package,
   with manual entry restricted to multiples of 5 (owner decision 2026-11-02).

### Assessment Center unfrozen — owner in chat, 2026-11-06, 11:00 Europe/Warsaw

Asked directly whether building Assessment Center was his decision, since it was still on the
frozen list above while SC-AC-001 (#272) had been merged into `integration` that morning. His
answer: *"Tak, budowa weryfikacji i assessment center jest moją decyzją i trzeba to po prostu
robić."* Assessment Center is therefore removed from the frozen list and is in scope alongside
the modules listed above in this section (SC-014, SC-015, SC-PRICING). WERYFIKACJA was already in
scope via SC-014 and SC-015; this confirms it. Nothing else moves: the voicebot, interview analysis,
Quality of Hire, talent pool, white-label and the Przelewy24/Fakturownia automation stay frozen.

For the record, the sequence was: #272 merged into `integration` that morning and its migration
`20261106120000_sc_ac_inventory_r13.sql` was applied on the Preview database (test data only)
before the module was unfrozen.

This changes what is built, not the gates. Price, package contents and anything touching
production still need a separate owner decision under the list above, and
`docs/plan-budowy-2026-11-02.md` still has Assessment Center outside the scope of that particular
plan document — the order of work there (module A, then C, calculator in between) stands unless
the owner says otherwise.

### Voicebot on the public offer — settled 2026-11-02 (evening, owner in chat)

**The voicebot is not shown anywhere on the public surfaces.** Not in the package copy, not in
the comparison, not in the calculator demo, not as "w przygotowaniu". It comes back only once it
actually works, and then as an addition to an existing package — free or for a small fee, the
owner has not decided which ("jeszcze zobaczymy"). Until then no customer-facing text promises,
previews or prices bot calls.

**Prices stay visible.** WERYFIKACJA 615 zł gross / 60 CV and ASSESSMENT CENTER 1 499 zł gross /
50 CV are shown on the public offer as the approved prices of the next stages, together with the
fact that neither package can be bought yet. This was asked of the owner twice in chat on
2026-11-02 and confirmed both times, the second time after #258 had already merged the opposite.
A later agent-written line recording something different does not reopen this; only the owner does.

**Order of work, settled by the owner 2026-11-02 (by voice):** module A (competency test), then
module C (extended report), with the pricing calculator fitted in between. **Voicebot comes after
those**, not before — the owner chose "najpierw robimy testy". Packages ship to customers **without
bot calls**, at unchanged prices (PRESELEKCJA 300 zł, WERYFIKACJA 615 zł, ASSESSMENT CENTER
1 499 zł), and the site does not mention calls at all until they work (see the section above). Wiring the voicebot
into package limits (FREE 1, paid 10) is a separate later step and needs no rework of anything
built before it.

The 36–55 day voicebot figure in the audit is overstated. Most of the code exists; what is missing
is wiring (webhook runtime, dispatch transport, schema deployment) plus Retell/VoIPstudio setup —
about two weeks to a first real test call. Interview-content analysis is separate and comes after.

Still frozen for these modules: interview analysis.

Naming and pricing of the package built from A + C is **settled** (owner decision 2026-11-02, by
voice): it ships as **WERYFIKACJA at 615 zł gross for 60 CVs, without bot calls**, with no mention of
calls on the site until they work. No new intermediate package is created. This
closes decision **D2** in [docs/plan-budowy-2026-11-02.md](docs/plan-budowy-2026-11-02.md); the
earlier framing of that decision assumed the withdrawn 899 zł price and mandatory calls. The
package description must not mention calls while they do not run — that is the condition the owner
attached to selling it. Any further change to price or package contents is still an owner decision
under the list above.

The MVP path to the first paid PRESELEKCJA keeps priority when the two compete for time.

### SC-020 and SC-021 reopened (owner decision 2026-11-09)

The owner ordered development of **SC-020 white-label** (issue #21) and **SC-021 AI gateway & cost
control** (issue #81), A–D each, in his own message typed into the Claude Code session of 2026-11-09
(https://claude.ai/code/session_01TVLzgbHVMAPJSAtb449hht), confirming the issue #21/#81 reopen comments. This removes white-label and SC-021
from the frozen list above. Approved variants: white-label shows **only the customer's own brand**
(no switch back to SkillCheck, legally required operator/controller notices stay); the AI gateway
is multi-provider in design but **only OpenAI is active** — other providers get adapters and
synthetic tests, no accounts, keys, paid calls or automatic fallback. Production, new costs, real
DNS/domain changes, real sends and activating another provider remain owner gates. Work plan and
status: [docs/sc-021-a-ai-gateway.md](docs/sc-021-a-ai-gateway.md) and the issues.

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
- Still open: rotation of the database password. It cannot be confirmed from outside, and the owner has not confirmed that it was done.

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
