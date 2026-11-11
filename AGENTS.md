# SkillCheck — Agent Operating Contract

This file applies to ChatGPT, Cursor, Codex and any other coding/review agent working in this repository.

## Source of truth

GitHub Issue = task contract.
GitHub Pull Request = implementation/review contract.
Do not require the owner to copy handoffs between agents.

## Roles

Owner decision 2026-11-05: Codex coordinates and implements programming work across the entire SkillCheck project. See `CLAUDE.md`.

- **Codex / ORCHESTRATOR + BUILDER** — owns backlog, dependencies, task scope, owner checkpoints and the production approval flow; implements the task on a dedicated branch and opens/updates the PR.
- **Independent REVIEWER** — a separate agent session with fresh context that did not write the change; reviews architecture, security, correctness, tests and scope. Verdict: PASS / PASS WITH FIXES / FAIL.
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

## Owner communication

The owner is not technical and has limited time at the computer. Agents do all technical work themselves.

- Write to the owner in Polish, in plain language, without jargon.
- Ask the owner only YES/NO decisions, each with a recommendation and one sentence of reasoning. Collect open decisions into one message instead of asking one at a time.
- Never ask the owner to click through GitHub, Vercel or Supabase, run tests, check a browser console, copy handoffs or look up settings. Agents read these themselves through their tools.
- If a check needs something the agent does not have (an account, a credential, a test database), report it as a blocker together with a proposal that removes the need for the owner next time.
- Prefer automated checks (CI, browser tests) over manual verification by the owner.
- The owner's own actions are limited to: production approval, merging the promotion PR into `main`, new costs, and external or irreversible actions. For each, give the owner a direct link and say exactly what to click.

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

1. Builder implements and updates PR.
2. Reviewer reads the PR and returns PASS / PASS WITH FIXES / FAIL.
3. If fixes are required, the builder applies them on the same branch.
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

## Production access rules for agent sessions

These rules apply to every agent session (Claude, Cursor, Codex, ChatGPT) and to its MCP connections and tokens.

1. Production migrations run only through the `db-migrate-production` workflow in the `production-approval` environment, after an owner approval bound to the exact release SHA and the exact list of migrations. Migrations are applied one by one in manifest order, never with `supabase db push`. The ledger records `statements` and the file hash for every migration (`statements = NULL` is not allowed). Production database credentials exist only as secrets of that environment. The workflow exists on `main` and `integration` (`.github/workflows/db-migrate-production.yml`) and was used on 2026-11-11 (run 43011755458, SHA `01429af586c487843259d424d9b4ed24e6c6a70c`, 24 migrations, owner approval in `production-approval`).
2. The production Supabase project (`wsvjawuikxfzjyivxgsu`) is reachable from agent sessions only through Supabase MCP with `read_only=true` and `project_ref=wsvjawuikxfzjyivxgsu`. Write-capable Supabase MCP is allowed only for development projects or branches.
   The test project for Preview is `skillcheck-preview` (`orbyscrupgnupifzlqxp`): Vercel Preview builds of `integration` use it through branch-scoped `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. It holds no real data; agents test logins, uploads and reports there instead of asking the owner.
3. Agents do not change Vercel Production environment variables, secrets, aliases, domains, deployment protection or shareable/bypass links. Only the owner does, or a pipeline after an approval. Tools that create share links as a side effect (for example fetching a protected deployment URL through Vercel MCP) are not used against production.
4. Any production change made outside the pipeline is an incident, not a missing record. It is reported in an issue with SHA, time, actor and scope.
5. GitHub identity of agent sessions (owner decision 2026-10-29, variant B). The target is the `skillcheck-agent-ks[bot]` GitHub App token for every agent write. Until a session can use it, an agent session may act through the owner's GitHub identity **only** for:
   - commits and pushes to task branches (never to `main` or `integration` directly);
   - opening and updating pull requests, review replies and comments;
   - merging a pull request into `integration` under the Review loop rules (CI green and an independent review with no unresolved findings on the current commit).

   With the owner's identity an agent session **never**:
   - approves the `production-approval` environment or any pull request review;
   - merges or pushes anything to `main`, including production promotion PRs (the owner merges them after approving);
   - changes rulesets, branch protection, environments, repository settings, secrets or deploy keys;
   - deletes branches it did not create.

   Any such action by an agent session is an incident under rule 4.
6. Agent sessions never read secret columns. This covers every query an agent session runs itself, by hand or through a tool (MCP, console, ad-hoc or helper scripts), against any database, production included. It does not cover server-side code inside migrations or functions that reads a secret to compute or verify a signature (for example `select * into` in a `security definer` function); that is application logic, not an agent read. Committed tests that read a secret value are a known exception scheduled for removal (`tests/sc19-auto-trial-database.test.mjs`); do not copy that pattern.
   - Secret columns are identified by what they hold, not by name. The names below are examples, not a complete list: `request_secret`, `request_secret_current`, `request_secret_previous` and `worker_secret`, in `private.sales_lead_settings`, `private.sc19_trial_auto_settings`, `private.cv_bulk_settings` and `private.sales_mail_settings`, and `secret` in `ai_ledger.pseudonym_key`. Before querying a settings or key table, list its columns (`information_schema.columns`) and treat every column that holds a key, secret or token as off-limits.
   - Such tables are read by named columns, never with `select *`, because one plain read exposes every secret in the row.
   - To check that a secret is configured, use a presence test (`is not null`, `octet_length(...) >= 32`), never its value.

The required status `production-approval-attestation` (`.github/workflows/production-approval-attestation.yml`) passes only after the owner approves the `production-approval` environment for the exact PR head SHA. While agent sessions act through the owner's identity (rule 5, variant B), the separation between an agent and the owner's approval is procedural, not technical: GitHub would accept an approval or a `main` merge made with that identity. Only the owner approves and merges into `main`. Moving agent writes to the `skillcheck-agent-ks[bot]` App token restores the technical separation.

## Continuous release policy (owner decision 2026-11-08, issue #369)

Within the scope approved in [docs/continuous-release-policy.md](docs/continuous-release-policy.md), the per-release owner click in the Production loop is replaced by a trusted, fail-closed automatic preflight, **once that publisher is implemented and verified**. Until then the Production loop above applies unchanged. HOLD P24 stays absolute for LIVE Przelewy24 (real money), with one narrow exception the owner opened himself — see "Przelewy24 Sandbox on the production domain" below. Data deletion, price/payment rules, new real sends, new costs, wider access and production secrets still need separate owner consent. All technical protections remain.

## Przelewy24 Sandbox on the production domain (owner decision 2026-11-11, by voice)

The owner decided, by voice in the Claude Code session of 2026-11-11
(https://claude.ai/code/session_01TVLzgZUzLdPaNdmpjaxo1f), that a Przelewy24 verifier must be able to
walk the purchase path on `skillcheck.pl` as far as the Przelewy24 payment page and pay by bank
transfer or BLIK with **test** money. His words, after being told the button was disabled: "mówione
było, że operator z przelewy 24 musi mieć dostęp do kliknięcia. A ty znowu zrobiłeś przycisk, że
wkrótce. Nie może w ten sposób być." He will walk the path himself first, repeatedly, and the
verifier afterwards, both on his own company (KTIG Consulting) and his own account. He also ruled
that nothing may limit the number of attempts.

**What this opens:** Przelewy24 **Sandbox** on the production domain, with the sandbox keys that
already exist for Preview, and a dedicated least-privilege production login role for the checkout
adapter. Implementation: PR #421.

**What stays closed, and still needs a separate decision from the owner himself:** live Przelewy24
keys and any real payment; any other payment provider; the Fakturownia automation; taking money from
anyone other than himself. A sandbox payment grants REAL analyses on production, which is accepted
because there are no customers and the offer is visible only to a company the owner has verified.

**Still his clicks, never an agent's:** the Vercel Production variables, the password of the new
database role, and publishing the offer in `/operator/billing`. Production access rules 1-5 are
unchanged by this.

This record exists because the HOLD above would otherwise make a future session revert the work in
good faith. Only the owner opens a gate; this records that he did, and with what scope. An
agent-written line never widens it.

## Agent controller

SC-OPS-002B adds an operations controller under `tools/agent-pipeline/`. It is not a product feature. Both `AGENT_PIPELINE_ENABLED` and `AGENT_PIPELINE_MERGE_ENABLED` default to false. An integration merge is authorized by verified CI plus independent review (not PR prose); production approval remains a separate owner-only GitHub Environment approval. Do not enable the controller, merge, or deploy from a task implementation.

## Existing SkillCheck guardrails

- never re-run already applied migrations
- never commit secrets
- never expose service_role to client code
- preserve tenant isolation and RLS
- CV/provider payload must remain minimal and approved
  - Exception (owner decision 2026-11-01), only for the SC-BULK-001 bulk CV upload flow: the automatically redacted CV text counts as approved without a per-CV human review. If redaction fails or is turned off, the CV is not sent to the AI provider. The payload stays minimal; human-readable evidence, human review of results and "no automated final hire/reject decision" still apply.
- no automated final hire/reject decision
- human-readable evidence and review remain required for AI screening
