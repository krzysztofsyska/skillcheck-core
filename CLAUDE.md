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

## Current priorities (owner decisions 2026-11-01)

The MVP is frozen. Plan and status for the owner: Claude Doc "SkillCheck — audyt i plan do pierwszej sprzedaży" (https://claude.ai/artifact/5QWE6B2vJQkG3n73fr52D9).

MVP = a new company, without technical help, can: visit the site → sign up (one FREE per NIP) → FREE preselection of 5 CVs → buy PRESELEKCJA (299 zł / 60 CVs) → get the ranked report. Nothing else ships before the first paid PRESELEKCJA.

Owner decisions (all YES, 2026-11-01):
1. No voicebot in the MVP.
2. Starting price: PRESELEKCJA 299 zł for 60 CVs, FREE 5 CVs.
3. First sales are paid by invoice/bank transfer and activated manually by the operator (`/operator/billing`). Przelewy24 and Fakturownia automation are frozen until there are paying customers.
4. Bulk CV upload (PR #228) is part of the MVP.
5. Everything outside the MVP is labelled `później` and closed; old branches are archived as `archive/<branch>` tags.
6. `main` and `integration` are protected: merges only through PRs with green required checks. Claude is the only builder.

Order of work:
1. Housekeeping (this PR, branch protection, `później` labels).
2. Walk the MVP path end to end on Preview (`skillcheck-preview`) as a new company; list every blocker.
3. Fix blockers; review and merge #228.
4. Production unblockers (owner switches, see below), then the same walk on Production.

Known production blockers (owner action, give him a direct link and exact clicks):
- No package policy and no balances on production, so every new AI analysis is refused (`sc19_quota_exhausted`). Set FREE = 5 and PRESELEKCJA = 60 in `/operator/billing`.
- Contact form `/rozmowa`: Vercel Production `SALES_LEADS_ENABLED=true` (+ redeploy) and `private.sales_lead_settings.leads_enabled = true`. Auto-reply mail stays off.

Frozen (do not work on): voice, competency tests, Assessment Center, Quality of Hire, talent pool, white-label, SC-PRICING-001–011, SC-021 AI gateway, further erasure stages, Przelewy24/Fakturownia automation, agent-pipeline tooling.

Open security item from the audit (owner only, rule 3): Vercel Production still has `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`, `POSTGRES_PRISMA_URL`, `POSTGRES_PASSWORD` (checked 2026-11-01). They must be removed and the database password rotated.

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
