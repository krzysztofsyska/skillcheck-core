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
