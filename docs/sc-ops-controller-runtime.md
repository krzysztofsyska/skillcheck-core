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
That installer/updater is not implemented: the integration-only executor cannot
emit `sc-agent/integration-ready` for a runtime-branch merge. The configuration
fragment above is not an autonomous installation/update procedure. Do not
activate it until an independently reviewed installation path satisfies these
protections; do not remove checks or add a bypass to resolve this dependency.

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

## One-time App visibility diagnosis before runtime installation

The existing registered `agent-diagnostics.yml` (workflow ID `396343951`) now
has a separate `ruleset_visibility` mode. This is a diagnostic candidate, not
an installed controller. Its fixed source descriptor is private to the
diagnostic authorizer; `policy.json` remains unchanged. Consequently reconcile
still rejects `agent-control-runtime` with the unchanged main policy.

A job without App secrets first verifies the repository, exact operational
ref, current SHA, workflow path/ID, event, run identity and first attempt. All
three existing pipeline/merge/feedback flags must be exactly `false`. The same
guard runs immediately before each temporary token issuance and after each
probe. A changed source discards the observation. It does not prevent cleanup.

The two sequential profiles use the existing App `5216184`, installation
`168649570`, owner `222297538` and only repository `1043384454`:

| Profile | Requested permissions |
| --- | --- |
| `app-read` | contents, administration, actions: read |
| `controller-existing-scope` | administration: read; actions, checks, contents, issues, pull_requests: write |

The second profile is a write-capable token used only for a fixed read-only
GraphQL query. These are the controller's existing requested permissions, not
a request to expand the installation. A denied or broader grant stops the
diagnostic. No provider key is passed and no model, Cursor endpoint, controller
effect, repository mutation or secret creation is performed. Each known token
is revoked in `finally` before the next profile. A lost issuance response or
failed revocation is reported as unconfirmed, never as successful cleanup;
runner termination cannot guarantee revocation. Issuance is not retried.

Each result records its verified scope/expiry, source SHA, run ID, cleanup and
the unchanged two-control observation. It always states `liveE2E: NOT_RUN`,
`protection_authorized: false` and `controller_activation_authorized: false`.
Successful transport/source/cleanup checks can coexist with `capability: null`
or `false`. A green diagnostic job does not mean protections were verified;
read the per-profile capability and its reason separately.
The ordinary Actions-token measurement in #386 returned `node:null` for the
writer control; this is not a prediction of either App-profile result.

### Concrete installation package for an authorized administrator

Do not execute these administrative operations from an agent's owner-identity
connection. The available GitHub connector cannot modify environments/rulesets
or dispatch workflows. Prepare the final candidate SHA/tree and link its
completed CI, full independent review and Codex review in the PR handoff first.

1. Read the current flags, runtime-ref existence and all effective branch rules.
   Require pipeline, merge-enabled and feedback exactly `false`; leave the
   legacy `AGENT_PIPELINE_MERGE` false as well. If the ref already exists,
   stop: this initial-installation procedure cannot update or overwrite it.
2. With `agent-control` still restricted to `main`, create exactly
   `refs/heads/agent-control-runtime` at the reviewed immutable candidate SHA.
   No code transformation or policy edit occurs during installation. Satisfy
   any applicable creation restrictions; this procedure grants no bypass.
3. Apply this additional ruleset without changing any existing rules:

   ```json
   {
     "name": "agent-diagnostic-runtime-freeze",
     "target": "branch",
     "enforcement": "active",
     "bypass_actors": [],
     "conditions": {"ref_name": {
       "include": ["refs/heads/agent-control-runtime"], "exclude": []
     }},
     "rules": [
       {"type": "update"}, {"type": "deletion"},
       {"type": "non_fast_forward"}
     ]
   }
   ```

4. Re-read the full ruleset (including the directly disclosed empty bypass
   list), effective rules and branch SHA. Require the freeze active and the SHA
   unchanged. Only then replace the existing **single** `main` branch policy
   of environment `agent-control` (`23618160050`) with:

   ```json
   {"name": "agent-control-runtime", "type": "branch"}
   ```

   Use the verified existing deployment-branch-policy ID; do not invent it,
   append another policy, allow tags/wildcards, recreate the environment or
   alter its secrets. Keep `agent-review`, `owner-acceptance` and
   `production-approval` unchanged and main-only. Re-read the exact one-branch
   environment configuration and frozen SHA after this operation.
5. Dispatch the existing workflow ID `396343951` once with:

   ```json
   {"ref": "agent-control-runtime", "inputs": {"mode": "ruleset_visibility"}}
   ```

   The workflow already exists on the default branch; GitHub supports selecting
   another branch for a registered workflow. Record the returned run ID, exact
   SHA, result JSON and each token-cleanup outcome. An unsuccessful dispatch is
   a blocker, not authority to change main or bypass the environment.

This frozen branch is usable for this measurement only. No updater is
implemented, no scheduler is activated, and no new task is started. Do not move
the branch or relax its freeze to install corrections. A later installation or
update requires a separately reviewed path with the secret-bearing environment
inaccessible while the source is changed. After the measurement the authorized
administrator may restore the exact prior main-only environment policy; keep
all controller flags false and retain the frozen branch and audit evidence.

Reference: https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow
