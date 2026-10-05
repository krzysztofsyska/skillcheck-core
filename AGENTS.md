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
- **Owner** — only two required decisions:
  1. OWNER ACCEPTANCE — implementation accepted for integration.
  2. PRODUCTION APPROVAL — explicit permission to promote/deploy to production.

## Branch model

- `main` = production source branch.
- `integration` = accepted-but-not-yet-production changes.
- task branches start from `integration`.
- normal task PRs target `integration`.
- only a production promotion PR may target `main`.
- promotion PR must be `integration -> main`.

Do not merge task branches directly to `main`.

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
6. Orchestrator asks owner only for OWNER ACCEPTANCE.
7. After owner acceptance, merge to `integration`.

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

## Existing SkillCheck guardrails

- never re-run already applied migrations
- never commit secrets
- never expose service_role to client code
- preserve tenant isolation and RLS
- CV/provider payload must remain minimal and approved
- no automated final hire/reject decision
- human-readable evidence and review remain required for AI screening
