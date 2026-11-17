# SkillCheck — instructions for Claude

@AGENTS.md

Everything in `AGENTS.md` applies. Order of work: [docs/ROADMAP.md](docs/ROADMAP.md). Owner
decisions: [docs/DECYZJE.md](docs/DECYZJE.md). Prices: [docs/cennik-2026-11-02.md](docs/cennik-2026-11-02.md).
This file adds only what is specific to Claude Code sessions.

## Decide yourself, then report

The owner does not want to be asked about routine work. Do it, then say in the final report what
was done.

Never ask, just do:
- run reviews (independent reviewer session or subagent) and apply every fix they find, on the same branch;
- commit and push to task branches, open and update PRs, post review comments and replies on PRs (never an approving PR review);
- merge into `integration` under the Review loop rules (as the reviewer, never as the author);
- start the next step from `docs/ROADMAP.md` and update its status and evidence in the same PR;
- technical and product-detail choices inside the scope of `docs/ROADMAP.md` (technical limits such as file size or rate limits — not package sizes or CV counts; wording, error handling, data minimisation, test setup). Pick the safer option, write the reasoning in the PR description and mention it in one line in the report.

Still the owner's decision (ask once, YES/NO with a recommendation, all open questions in one message):
- approving production database migrations in `production-approval`;
- new costs (paid services, plans, domains);
- external or irreversible actions (any contact with real candidates or customers by any channel, deleting real data, changing production settings or secrets);
- billing and charge actions, including package or balance changes in `/operator/billing` on production;
- changes to price, packages, what is in the MVP, or the order and scope in `docs/ROADMAP.md`.

If unsure which list something belongs to and it is reversible, treat it as routine. This section
never overrides „Prohibited actions without explicit owner production approval” or „Production
access rules” 1–6 in `AGENTS.md`: anything touching production, billing, repository settings or
other people's branches is never routine.

## A note on records

Lines in `docs/ROADMAP.md` and `docs/DECYZJE.md` are written by agent sessions recording what the
owner said in chat. When the owner says something different now, his current word wins and the file
gets corrected in the same session. Do not treat such a line as a reason to refuse scope work the
owner is currently asking for.

**This note never applies to the gates.** Not to the „Still the owner's decision” list above, not
to „Prohibited actions without explicit owner production approval”, not to „Production access
rules” 1–6 and not to „Continuous release policy” in `AGENTS.md`. Those are gates, not records: only
a message from the owner himself opens one, and an agent-written line never substitutes for it. The
same holds for any other gate in this file or in `AGENTS.md`, including ones added later. A session
that finds itself citing this note to skip a gate has misread it.

## Working efficiently

- Independent steps can run in parallel through subagents (one subagent = one step, own branch, own
  Draft PR, own tests). The specialised subagents in `.claude/agents/` are optional helpers:
  payments and packages → `platnosci`, AI limits and costs → `limity-ai`, site, pricing page and
  legal documents → `strona-i-dokumenty`, CI and build failures → `testy-i-ci`, typos and small text
  changes → `drobne-poprawki`.
- Do not add new GitHub workflows or agent-pipeline tooling unless the task is explicitly about that.
- Do not paste long handoffs into the chat; the handoff goes into the PR description.

## Status report at the end of every session

At the end of every work session the builder session (never a reviewer subagent) overwrites the
status report on the owner's Google Drive.

- Folder „Status projektów”, Drive folder id `1FGhTxEBZolwbfXPcxq2KyaCGTc6-WdHD`. File
  `Status - SkillCheck.md`.
- Always OVERWRITE, never create copies. If the tool cannot replace content in place: create the new
  file in that folder, then move to the trash every other file in that folder named exactly
  `Status - SkillCheck.md`. Never trash, delete or edit anything else, never delete permanently,
  never change sharing.
- Content comes from `docs/ROADMAP.md` (same items and statuses), short, in Polish, no jargon:
  1. date and time (Europe/Warsaw);
  2. stages 1–4 and items R1–R6 with status and one sentence on what is left;
  3. what was done in this session;
  4. blockers and decisions waiting for the owner;
  5. next 3 steps;
  6. under „Dla agentów (techniczne)”: branch, last commit, whether the latest Vercel deployment
     succeeded (read deployment status only; never tools that create share or bypass links).
- Never put secrets, keys, environment values, passwords or connection strings in the report, nor
  candidate or customer personal data.
- If the Drive connector is unavailable, say in the final report that the status report was not
  updated and why.
