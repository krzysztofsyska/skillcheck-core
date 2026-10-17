# SkillCheck — Agent Operating Contract

This file applies to ChatGPT, Cursor, Codex and any other coding/review agent working in this repository.

## Source of truth

GitHub Issue = task contract.
GitHub Pull Request = implementation/review contract.
Do not require the owner to copy handoffs between agents.

## Roles

- **ChatGPT / ORCHESTRATOR** — owns backlog, dependencies, task scope, dispatch, owner checkpoints, merge and production approval flow.
- **Cursor / BUILDER** — implements the approved task on a dedicated branch and opens/updates the PR.
- **Codex / REVIEWER** — reviews architecture, security, correctness, tests and scope. Verdict: PASS / PASS WITH FIXES / FAIL.
- **CI / TESTER** — executes deterministic checks.
- **Owner** — decides on PRODUCTION APPROVAL, new costs and irreversible/external actions. No routine acceptance is required for integration merges.

## Branch model

- `main` = production source branch.
- `integration` = accepted-but-not-yet-production changes.
- task branches start from `integration`.
- normal task PRs target `integration`.
- only a production promotion PR may target `main`.
- promotion PR must be `integration -> main` by default.
- **Proposal only, NOT active**: selective `release/sales-mvp-intake-YYYYMMDD -> main` may be considered after a separately reviewed governance rollout. The offline checker `tools/agent-pipeline/lib/sales-release.mjs` only analyzes scope and ALWAYS denies Production authorization.
- Current `main` classifier still denies all PR heads except `integration`. A future trusted production gate must be installed from the protected main revision, verify every commit and exact release scope, enforce owner acceptance and production approval as separate GitHub-origin attestations (not editable PR text), and fail closed if protection settings cannot be verified. Never use PR-supplied code as its own authorization gate. No billing, migrations, workers, secrets, database or payments belong to the limited sales-intake candidate.

Do not merge task branches directly to `main` or use this exception before its production safeguards are verified.

## Required task metadata

Every task must define:
- TASK
- LEVEL: L1 / L2 / L3
- SCOPE: FRONTEND / BACKEND / FULLSTACK / OPERATIONS
- OWNER
- REVIEWER
- DEPENDS ON
- acceptance criteria
- required tests
- security/privacy checks

## Scope rules

### FRONTEND
Typical paths:
- `app/**` excluding backend-only API handlers
- UI components
- CSS/assets/public content
- client interaction

Required: typecheck, build, relevant UI/HTTP tests.

### BACKEND
Typical paths:
- `lib/**`
- `app/api/**`
- `supabase/**`
- server actions
- auth/server integration
- worker code

Required: typecheck, build, module tests, security/authorization checks.

### FULLSTACK
Touches both frontend and backend. Must document the interface/contract between both sides.

### Automatic L3 escalation
Any of these force L3:
- DB migrations
- RLS or grants
- RPC/security-definer functions
- auth/security/trust boundaries
- AI provider contracts
- billing
- secrets handling
- tenant isolation
- production deployment logic

## Agent handoff

Agents communicate through Issue/PR comments and commits. Required handoff:
- TASK
- STATUS
- BRANCH
- COMMIT
- CHANGED FILES
- DB/MIGRATIONS
- TESTS
- SECURITY CHECKS
- KNOWN ISSUES
- BLOCKERS
- NEXT ACTION

Do not ask the owner to paste this handoff into another agent.

## Review loop

1. Cursor implements and updates PR.
2. Reviewer reads the PR and returns PASS / PASS WITH FIXES / FAIL.
3. If fixes are required, Cursor applies them on the same branch.
4. CI reruns.
5. Repeat until PASS.
6. If CI and an independent reviewer both pass against the current commit and all security/branch gates pass, merge to `integration` automatically; otherwise repair or block and report the specific cause.
7. Continue with the next dependency-ready task without waiting for an owner click.

## Production loop

Production is a separate decision.

1. Orchestrator prepares a promotion PR from `integration` to `main`.
2. CI/review must be green.
3. Owner is asked: PRODUCTION APPROVAL — YES/NO.
4. Without explicit YES, do not merge promotion PR and do not deploy DB/functions/secrets.
5. After YES, orchestrator may promote and execute the approved production runbook.
6. Smoke tests and production documentation are required before DONE.

## Prohibited actions without explicit owner production approval

- merge/push production promotion to `main`
- `supabase db push` against production
- production Edge Function deploy
- production secret changes
- production Vercel deploy outside the approved promotion
- external candidate contact
- billing/charge actions

## Agent controller

SC-OPS-002B adds an operations controller under `tools/agent-pipeline/`. It is not a product feature. Both `AGENT_PIPELINE_ENABLED` and `AGENT_PIPELINE_MERGE_ENABLED` default to false. An integration merge is authorized by verified CI plus independent review (not PR prose); production approval remains a separate owner-only GitHub Environment approval. Do not enable the controller, merge, or deploy from a task implementation.

## Existing SkillCheck guardrails

- never re-run already applied migrations
- never commit secrets
- never expose service_role to client code
- preserve tenant isolation and RLS
- CV/provider payload must remain minimal and approved
- no automated final hire/reject decision
- human-readable evidence and review remain required for AI screening
