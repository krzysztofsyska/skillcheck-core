# SC-OPS-377 — Claude Code adapter for the existing controller

TASK: SC-OPS-377 · LEVEL: L3 · SCOPE: OPERATIONS

Reuse `agent-reconcile`, its durable `agent-state` journal, repository lease,
frozen issue contracts, bounded repair rounds and independent `agent-review`.
The existing Cursor-shaped ports remain the state machine compatibility contract;
an optional Claude Code adapter implements create/followup/poll through one
workflow. There is no separate label-triggered task scheduler.

## Trust boundary

The controller records intent before dispatch. The workflow accepts only the
controller App actor, first attempt, exact trusted main policy SHA, approved issue,
contract hash, reserved operation and branch/head. A model job has no GitHub write
credential, App key, reviewer key or production secret. It can return file data.
The model can only Read/Glob/Grep an exported data directory without Git metadata,
agent hooks/settings/plugins or MCP configuration. Project/local settings are
disabled by the SDK selection. CLI restricted mode additionally excludes user
settings and confines built-in file reads to the exported working directory.
The explicit tool list excludes writes and shell execution; strict empty MCP
excludes additional server tools. It returns structured JSON
file contents; the collector only parses that data and never executes model code.
The collector receives the small `execution_file` path, reads the pinned action's
JSON message array and selects only a successful final `structured_output`.
It validates sizes and file data before publishing; raw execution logs are never
uploaded. This avoids Linux's per-environment-variable limit for larger patches.
The controller downloads that run's bound artifact, independently revalidates
the journal, contract, branch and scope, and creates a commit with a fixed parent.
It never runs model code. The ordinary controller then creates the Draft PR,
dispatches CI/review and performs the existing bounded correction loop.

Only text regular files within frozen ALLOWED_FILES may be published. Reject
traversal, symlinks/submodules, workflow/agent instruction changes, secrets and
binary/oversized files. Unknown publication response is recovered by a deterministic
commit marker on the expected parent; a changed branch is not overwritten.

## Activation and costs

The shipped policy retains Cursor and Claude `enabled=false`, budget zero.
Claude requires an explicitly approved positive per-run cap and aggregate cap,
existing protected credential, verified workflow ID and the existing LIVE gates.
The controller has no Claude credential. It durably reserves the approved
per-run limit in the existing task journal before dispatch; aggregate accounting
includes all task reservations regardless of policy SHA or workflow retention.
The vendor's `--max-budget-usd` is an estimated stopping threshold and can be
exceeded by an in-flight call. Reservations limit further dispatch, not the final
provider bill. Activation requires an approved allowance with explicit headroom;
zero budget and disabled defaults remain in force until that approval exists.
Unknown responses keep their reservations. Direct model reruns are rejected; an
uncertain dispatch is polled and never blindly repeated. A new authorized task
revision uses the same journal instead of duplicating a running task.

The main-only trusted workflow and missing/unknown runtime authorization remain
real blockers to live execution. This patch grants no production, settings,
secret creation, subscription or additional spending permission.

## Tests

Synthetic transports verify provenance, duplicate/lost dispatch, scope and path
attacks, budget exhaustion, stale contract/head, publication recovery and the
state-machine handoff to the existing CI/reviewer. Offline evidence is not a
live model invocation or an end-to-end result for SC-020/021.

## Pilot contracts prepared from existing work — 2026-11-09

Baseline inspected: integration `79b15e5bf34d7719f1d0ee5f0c6afad9311f4622`.
Issues [21](https://github.com/krzysztofsyska/skillcheck-core/issues/21) and
[81](https://github.com/krzysztofsyska/skillcheck-core/issues/81) approve the epics,
but their bodies are not executable contracts. Both have no assignee in the
read snapshot. Recheck open PRs, active journal claims and issue assignments
immediately before activation; absence of an assignee is not a concurrency lock.
These are bounded first pilot slices of A, not completion claims for the full
epics. The blocks below are ready to be copied into the existing issue after
dependency evidence is attached; preserve the rest of its approved requirements.
`STATUS: BLOCKED` deliberately prevents dispatch. Dependencies refer to real
modules, not fabricated completed journal entries. Auth/RLS evidence below is
additional to those module dependencies.

### SC-020-A: customer-only configuration and isolated preview foundation

Reuse `lib/company-access.ts`, the existing company dashboard and auth/RLS
fixtures. There is no branding implementation in the inspected integration tree.
`companyAccess.canEdit` includes recruiters, so it cannot authorize an
administrator-only publish: the pilot must explicitly require the existing
company owner and test denial for recruiter, viewer, outsider and anonymous user.
No new role is inferred. The SQL stays in `db/prototypes` until the current
SC-010 inventory/purge boundary is reviewed; no deployable migration, production
DNS, email or existing candidate flow is changed by this first slice.

```text
TASK: SC-020-A
LEVEL: L3
SCOPE: FULLSTACK
STATUS: BLOCKED
OWNER: Claude Code
REVIEWER: Codex
DEPENDS_ON: SC-019, SC-010
BRANCH_SLUG: customer-brand-preview
ALLOWED_FILES:
- lib/tenant-branding.ts
- lib/tenant-branding-server.ts
- app/dashboard/[companyId]/branding/page.tsx
- app/dashboard/[companyId]/branding/forms.tsx
- app/dashboard/[companyId]/branding/actions.ts
- app/dashboard/[companyId]/branding/branding.module.css
- db/prototypes/sc020-tenant-branding.sql
- tests/tenant-branding.test.mjs
- tests/tenant-branding-database.test.mjs
- tests/tenant-branding-preview.test.mjs
- package.json
- docs/sc-020-tenant-branding.md
REQUIRED_TESTS:
- npm run typecheck
- npm run test:auth
- npm run test:db
- npm run test:agent-pipeline
- npm run build
ACCEPTANCE_CRITERIA:
- Customer name/logo/favicon/colours are validated and previewed without a SkillCheck brand switch; unknown configuration has a safe neutral fallback.
- Immutable configuration versions, publish and rollback are demonstrated with two synthetic tenants in the isolated database prototype.
- Only company owner can publish or roll back; recruiter edit permission does not imply brand administration.
- New tenant-branding tests are included in the existing test:auth command; test:db remains unchanged and all required tests actually finish.
- Existing public candidate flows, deployable migration chain, domain routing, legal text and sends remain outside this first pilot slice.
SECURITY_CHECKS:
- Reject unsafe asset schemes, script/SVG injection, CSS injection and untrusted remote-fetch targets; no arbitrary asset fetching.
- Deny cross-tenant reads/writes and unauthenticated preview; scope any preview cache by verified company and version.
- Never infer tenant from an unverified Host header or browser company ID.
```

Before changing this packet to READY: independently verify current SC-019
acceptance, owner/recruiter/viewer auth and RLS on the combined integration
schema, and approve how new configuration records enter SC-010 inventory.
Candidate-wide rendering and a real publish endpoint require a separately
frozen follow-on scope after the signed candidate-token-to-company binding is
verified; that binding was not audited here. The prototype cannot be represented
as deployed tenant configuration.

### SC-021-A: reuse the gateway foundation, OpenAI-only routing

Reuse closed, unmerged [PR108](https://github.com/krzysztofsyska/skillcheck-core/pull/108)
at `1546789e757360c738cdf72fdef9eb78bfae6f66`, specifically its five
`lib/ai-gateway/` files and `tests/ai-gateway.test.mjs`. Preserve physical-attempt
idempotency, integer micro-USD accounting and unknown-charge handling. Reconcile
before importing, because current SC-005 has newer evidence-v2 and worker-claim
contracts. No second gateway or mass cherry-pick of the old branch is permitted.

The other stack snapshots are also closed/unmerged with no assignee:
PR111 `9000eb96387e27e2a4f4ea552120b57c249d3b6d`,
PR112 `bedb447f6484d45f9f53fbe437cfd996f2afe520`, and
PR156 `be8b564ce3ce00494bc5cd0d27e5bdbc5c84b558`.
Their candidate-bound ledger, lease bridge and ACL fixes are inputs for later B,
not authorization to import the database stack in A. Preserve the existing
`docs/patches/sc021-explicit-data-api-acl.patch` for that reconciliation.

```text
TASK: SC-021-A
LEVEL: L3
SCOPE: BACKEND
STATUS: BLOCKED
OWNER: Claude Code
REVIEWER: Codex
DEPENDS_ON: SC-005, SC-019, SC-010
BRANCH_SLUG: gateway-openai-foundation
ALLOWED_FILES:
- lib/ai-gateway/core.ts
- lib/ai-gateway/runtime.ts
- lib/ai-gateway/openai.ts
- lib/ai-gateway/postgres.ts
- lib/ai-gateway/reports.ts
- lib/ai-gateway/authorization.ts
- tests/ai-gateway.test.mjs
- tests/ai-gateway-screening.test.mjs
- tests/ai-gateway-authorization.test.mjs
- package.json
- docs/sc-021-ai-gateway.md
REQUIRED_TESTS:
- npm run typecheck
- npm run test:screening
- npm run test:auth
- npm run test:db
- npm run test:agent-pipeline
- npm run build
ACCEPTANCE_CRITERIA:
- Reconcile and extend the frozen PR108 foundation; use a provider-neutral contract with a runtime allowlist containing only OpenAI.
- Alternative adapters exist only as injected synthetic test doubles; no real alternative provider or automatic fallback is enabled.
- Versioned routing rejects unknown task/model/provider and supports deterministic policy rollback.
- A server authorization boundary rejects browser-supplied tenant identity; use synthetic verified claims until the real SC-005 bridge is reviewed.
- Differential synthetic tests preserve existing screening request/output and evidence contracts, including timeout, retry identity and unknown usage.
- New gateway tests are included in the existing test:screening command so the trusted CI command allowlist remains sufficient.
- No live worker wiring, paid calls, billing activation, secrets or new migration are introduced by this first pilot slice.
SECURITY_CHECKS:
- Provider credentials remain server-side and never appear in logs, errors or test artifacts.
- Redact disallowed payload fields, bound requests/responses and enforce timeouts; an uncertain attempt cannot be silently replayed or counted as free.
- Deny cross-tenant authorization and preserve separate operation ID versus physical-attempt ID.
```

Before READY: verify the current SC-005 trusted claim/lease contract and its
tenant binding, SC-019/billing acceptance and current RLS baseline. PR112's old
SC-010 R5 blocker must be reconciled with the current reviewed inventory rather
than marked solved by its historical tests. The A pilot uses an injected ledger
port only; durable billing and candidate-linked data require the separately
reviewed B schema, purge/retention and ACL work. None of these module dependency
checks was executed by the automation tests in this PR.
