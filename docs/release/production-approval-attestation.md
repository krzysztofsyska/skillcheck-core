# Production approval attestation (ruleset variant b)

The check passes only when the owner approved the GitHub environment `production-approval` for the exact head SHA of a PR into `main`.

- **Workflow:** `.github/workflows/production-approval-attestation.yml`
- **Script:** `tools/production-approval/verify-attestation.mjs`
- **Result:** the commit status `production-approval-attestation` on the PR head SHA.

## How it works
1. `pull_request_target` on PRs into `main` runs the workflow and script from `main`. PR code is never checked out or run.
2. Job `pending` sets the status to `pending` on the head SHA.
3. Job `approval` (environment `production-approval`) waits for the owner's approval.
4. Job `attestation` always runs and checks:
   - the approval came from `krzysztofsyska` (id 222297538) for this run and environment;
   - the event and workflow path match;
   - the PR is open with base `main`;
   - the current PR head equals the SHA the run started for.

   It then writes `success` or `failure`. API errors fail closed.
5. A new push triggers a new run and cancels the old one. The status of the new SHA stays `pending` until a new approval arrives.

## Rollout order (avoids blocking main)
1. Promote this workflow to `main` under the current ruleset. A `pull_request_target` workflow only runs once it is on `main`.
2. On a test PR into `main`, run the manual scenarios below.
3. Only then change the environment and the ruleset (owner, manually) as described below.

## Target environment `production-approval`
- Required reviewers: User `krzysztofsyska` (id 222297538), the only reviewer.
- `prevent_self_review: false`. Otherwise the owner cannot approve a run they triggered themselves.
- `can_admins_bypass: false`.
- Deployment branches: selected, `main` only. `pull_request_target` runs in the `main` context.

## Target ruleset `main-production-protection` (id 25301984)
```json
{
  "name": "main-production-protection",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "required_reviewers": [],
        "allowed_merge_methods": ["merge", "squash", "rebase"] } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "verify", "integration_id": 15368 },
          { "context": "Agent contract / scope gate", "integration_id": 15368 },
          { "context": "production-approval-attestation", "integration_id": 15368 }
        ] } }
  ]
}
```
Differences from the current ruleset:
- `required_approving_review_count`: 1 → 0
- `require_last_push_approval`: true → false
- `require_extra_approval_for_unattributed_changes` removed (it does not apply without required reviews)
- added the required `production-approval-attestation` check

## Manual test scenarios (test PR into `main`)
| Scenario | Steps | Expected |
|---|---|---|
| No approval | open the PR, do not approve | status `pending`, merge blocked |
| Rejection | Reject in the environment | status `failure` "a reviewer rejected…", merge blocked |
| Approval for the current SHA | Approve | status `success` on the head SHA, merge allowed if the other checks pass |
| Approval for an old SHA | approve, then push a new commit | the old run is cancelled; the new SHA has `pending` and needs a new approval |
| Approval by someone else | approval by another reviewer (if added) | `failure` "no approval … by krzysztofsyska" |

Check via the PR's Checks tab or `GET /repos/krzysztofsyska/skillcheck-core/commits/<sha>/status`.
Automated tests: `tests/production-approval-attestation.test.mjs` (decision logic and workflow safety).

## Limitations
- **The owner's token:** an environment can be approved through the API with the owner's token. Variant (b) protects only while agent sessions do not have that token (AGENTS.md, rule 5).
- **Forging a commit status:** any workflow in this repository that requests `statuses: write` can set a status with the same context and the same `integration_id` 15368. Such a change has to pass review as a change to `.github/workflows/**`. Repository rulesets do not let you pin a status to a specific workflow file.
- **Admin bypass:** an admin (the owner) can disable the ruleset or the required check. That is visible in the ruleset's `updated_at` and in Rule insights.
- **Vercel:** Vercel deploys Production automatically from `main`. The merge is the only control point.
