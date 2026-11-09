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
disabled; only trusted action user settings on the fresh hosted runner are loaded.
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
The controller has no Claude credential. It durably reserves the worst-case
per-run amount in the existing task journal before dispatch; aggregate accounting
includes all task reservations regardless of policy SHA or workflow retention.
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
