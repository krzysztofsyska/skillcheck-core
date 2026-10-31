# SkillCheck — instructions for Claude

@AGENTS.md

Everything in `AGENTS.md` applies. This file adds what changed and what matters most right now.

## Who does what (owner decision 2026-10-31)

Cursor and Codex are no longer used. ChatGPT is no longer the orchestrator.

- **Claude** — orchestrator and builder: picks the next task, writes the code, runs the tests, opens the PR to `integration`.
- **Independent reviewer** — a separate Claude agent started with fresh context that did not write the change. It reviews architecture, security, correctness, tests and scope against the current PR commit and returns PASS / PASS WITH FIXES / FAIL. This satisfies "independent review" in the Review loop of `AGENTS.md`.
- **CI** — deterministic checks, unchanged.
- **Owner (Krzysztof)** — production approval, merging the promotion PR into `main`, new costs, external or irreversible actions. Nothing else.

Where `AGENTS.md`, `docs/AGENT_WORKFLOW.md` or `.cursor/rules/` name Cursor as builder or Codex as reviewer, read them as the roles above. Do not wait for, mention or hand off to Cursor, Codex or ChatGPT.

## How the owner works

- He works mostly from his phone, through the Claude app. He does not open GitHub, Vercel or Supabase himself.
- Final report of every task: short, in Polish, no jargon. What changed in the product, the Vercel Preview link to check it, and any YES/NO decision with a recommendation.
- Do not paste long handoffs into the chat. The full handoff from `AGENTS.md` goes into the PR description.

## Current priorities (from the audit of 2026-10-30)

Feature freeze: no new product areas (voice, competency tests, talent pool, white-label, new agent tooling) until this path works end to end: visit the site → contact or sign-up → free preselection → payment 300 zł → invoice.

Order of work:
1. Security hardening: Next.js to 16.4.3, pinned Supabase packages, security headers, request size limit in `screening-worker`. Check the existing branch `fix/security-hardening-20261030` and its PR before starting anything new.
2. Migration drift: document the differences between production `schema_migrations` (read-only) and `supabase/migrations`, and why "DB migrate production" failed on 2026-10-29.
3. Finish and apply the SC-019 migrations (through the approved production workflow only).
4. AI cost limit per company.
5. Turn on the contact form.
6. Connect Przelewy24 and Fakturownia.
7. CV retention period and automatic deletion (owner decision first).

## Keep the process light

- Before starting, list open PRs and branches for the same topic and continue them instead of opening duplicates.
- Small changes need no new architecture document. Write the reasoning in the PR description.
- Do not add new GitHub workflows or agent-pipeline tooling unless the task is explicitly about that.
- Delete the branch after its PR is merged, if you created it.

## Commands

- Install: `npm ci`
- Always: `npm run typecheck`, `npm run build`
- Then the test groups for the touched area (see `package.json`), e.g. `npm run test:db`, `test:auth`, `test:http`, `test:screening`, `test:cv`.
- Tests that need PostgreSQL, a browser or a live server may not run locally; rely on CI for them and say so in the PR.

## Environments

- Production Supabase: `wsvjawuikxfzjyivxgsu` — read-only from agent sessions.
- Preview Supabase: `skillcheck-preview` (`orbyscrupgnupifzlqxp`) — test data only; use it for logins, uploads and reports instead of asking the owner.
- Vercel project: `skillcheck-core`. Every PR to `integration` gets a Preview deployment.
