# Controller runtime independent of product releases

TASK: SC-OPS-CONTROLLER-RUNTIME
LEVEL: L3
SCOPE: OPERATIONS
OWNER: Codex / Builder
REVIEWER: separate session, exact final SHA
DEPENDS ON: accepted #375/#377; installation still requires verified configuration

## Implemented boundary

The existing `tools/agent-pipeline` controller supports one additional trusted
source: `agent-control-runtime` with `control_plane.mode = integration-only`.
The field is optional; absence retains the existing protected `main` behavior.
No setting, flag, provider, budget or production gate is enabled by this patch.

The controller keeps the control-policy SHA separate from the product `main`
SHA. CI, reviewer and builder artifacts retain their workflow, actor, first
attempt and exact policy revision binding. Workflow source authorization runs
before the reviewer environment or candidate test commands. Each controller
effect and the final merge recheck the current control revision.

Operational mode rejects promotion records, Gate B, production PR creation,
production merge and approval dispatch in the planner, executor and GitHub
adapter. Candidate code remains data for the independent reviewer. A task cannot
use `agent-control-runtime` as its working branch. Existing production
`classify-pr`, attestation, environments and rulesets are unchanged.

## Installation is not activation

A reviewed runtime candidate must be installed by the existing authorized
administrator/controller identity at an exact, independently reviewed SHA.
`integration` is the development base, **not** an allowed secret-bearing runtime
ref. This patch does not automatically create or move the operational branch.
The accepted runtime revision must contain this explicit configuration:

```json
{
  "control_plane": {
    "branch": "agent-control-runtime",
    "mode": "integration-only"
  },
  "required_checks": {
    "agent-control-runtime": [
      "sc-agent/ci",
      "sc-agent/review",
      "sc-agent/integration-ready"
    ]
  }
}
```

This is a fragment to merge into the existing reviewed policy; do not replace
its other checks, repository identity, workflows or budgets. Changing the
runtime descriptor is a new immutable installation candidate, with new CI and
independent review. Copying an old PASS to the new SHA is not permitted.
Runtime branch updates require their own controlled installation; normal tasks
still merge only to `integration`, and cannot update their own executor.

The existing preflight requires:

- Exact runtime branch protection: PR-only updates, delete/force-push prevention,
  strict status checks above pinned to the configured controller App, no bypass
  on quality rules, and a separate update restriction admitting only that App
  through a pull request. Integration and `agent-state` retain their corresponding
  exclusive writer and quality/integrity protections. Initial branch creation
  must itself satisfy the effective GitHub rules; this document grants no bypass.
- `agent-control` and `agent-review`: exact existing environment IDs and exactly
  one allowed **branch**, `agent-control-runtime`; no wildcard, tag, `integration`
  or additional ref. Production and owner approval environments remain exactly
  `main`-only with their current owner/self-review/admin-bypass protections.
- A directly disclosed, current `bypass_actors` list. The existing App has only
  Administration:read; GitHub may hide this field. Missing information remains
  `RULESET_BYPASS_UNVERIFIABLE`. No cached list, empty default or timestamp-based
  attestation is substituted. This patch does not grant Administration:write.

Until all three are verified, installation/activation is **BLOCKED**. No owner
secret values should be copied into comments or logs. The administrator must
apply a concrete reviewed configuration, not disable a required check to pass.

## Scheduling and provider readiness

GitHub cron executes only the default branch's workflow. Adding this YAML to
`agent-control-runtime` does **not** establish automatic scheduling. Use the
existing external Claude routine only after its authenticated dispatch of the
existing `agent-reconcile.yml` on the exact runtime ref is actually demonstrated
and its run recorded. There must be one scheduler, never concurrent competing
controllers. Until such evidence exists, **automatic operation is BLOCKED**;
manual dispatch is a diagnostic, not proof of autonomous continuation.

The new Claude builder workflow is not registered on the current default
`main`, and its configured workflow ID remains null. Operational ref support
alone does not fix that. Do not fabricate an ID or activate it. An existing
Cursor adapter is usable only after read-only authentication and the existing
authorized budget are confirmed. Existing independent Claude routines may
continue their own assigned tasks, without claiming this controller ran them.

## Verification and rollback

The offline HTTP test uses distinct runtime and main SHAs and the real adapters:
build, review with a finding, repair, fresh CI/review, integration merge,
post-merge CI and next-task pickup. It asserts no main mutation or production
workflow dispatch. Negative tests cover wrong source/ref/SHA/actor/workflow,
control-ref movement, hidden bypasses, environment mismatch and inherited
production intents. These are offline evidence, not LIVE E2E.

After a separately authorized installation, begin with both existing flags
false and record the source authorization and read-only run. Activation needs
actual protection/provider/scheduler evidence, then a bounded approved task.
A failure leaves effects denied; disable the existing flags to stop new work.
Restore a prior reviewed runtime revision through the controlled update path,
never force-push or weaken protection. Product main and database are unaffected.
