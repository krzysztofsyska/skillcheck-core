# SkillCheck — selective release governance (PR #128 → PR #120)

**DRAFT / NOT INSTALLED OR ACTIVATED.** The three release-gate implementation
paths and the independent review corrections are prepared here. No owner
approval, merge, production deployment, external service, App installation,
credential grant or billing change is performed by this change. The external
identity/runtime and live acceptance tests remain actual prerequisites.

## Scope and existing protection

Repository `krzysztofsyska/skillcheck-core`, ID `1043384454`; designated owner
`krzysztofsyska`, ID `222297538`. PR #128 remains the same seven policy/test
files from `governance/sales-selective-main-gate-20261016`, against original
main `76760b7ffb7e95231fc7af313cc67bc8d36fefe1`. The one-time installation
exception expires when main advances. No product code or other PR is changed.

Owner-created ruleset `25301984`, `main-production-protection`, was read as
ACTIVE, literal `refs/heads/main`, no exclusions/bypass actors, deletion and
force-push protection, one approval, stale dismissal, independent latest-push
approval and conversation resolution. Existing required contexts `verify` and
`Agent contract / scope gate` are strict and pinned to GitHub Actions App
`15368`. Preserve this baseline and the separate integration protection.
A connector-session observation does not prove another token's access.

## Candidate-bound results and dedicated producer

The workflow explicitly publishes three candidate-HEAD check runs. Automatic
`pull_request_target` job checks are base-side and have different names; they
are NOT merge evidence. Each dedicated check binds repository, PR120, candidate
HEAD, current BASE, workflow run, attempt, stage and publisher App ID in its
`external_id`. New checks start `in_progress`. Unknown evidence, failed stages
and stale target/run bindings never authorize a success result.

| Required context after approved installation | Expected producer |
| --- | --- |
| `verify` | GitHub Actions App 15368 |
| `Agent contract / scope gate` | GitHub Actions App 15368 |
| `Sales selective scope verified` | Dedicated external release App |
| `Sales owner acceptance` | Same dedicated external release App |
| `Sales production approval` | Same dedicated external release App |

**The last three must NOT be pinned to App15368.** A same-repository candidate
workflow can request its own Actions token with check-write permission and
impersonate that repository-wide producer. Instead, the external broker owns
the dedicated App credential; it never returns an installation token to Actions.
The trusted-main workflow receives only read permissions (including
`checks:read`) and OIDC issuance permission. It sends bounded, nonce-bound
publication requests to the broker. The broker reconstructs the exact check
payload and allows only its three context names on the bound candidate; there
is no generic mutation proxy. The client independently re-reads each resulting
check through GitHub and verifies its App, HEAD, external binding and outcome.

The public `SALES_RELEASE_PUBLISHER_APP_ID` variable must identify the actual
owner-approved broker App; there is no guessed/default ID. The binding, broker
configuration, signed protection proof and required-check rules must agree.
App15368 is explicitly refused as the dedicated publisher. Ordinary CI remains
pinned to Actions. Never change that source merely to satisfy a stale test.

GitHub documents workflow-run `path` values with `@main`; a live read of Checks
run39038751854 in this repository returned a bare path. Both exact forms are
handled, and both require a separate fixed-workflow metadata/`workflow_id`
match. Other suffixes/refs, wrong IDs, inactive workflows and incorrect run
HEAD/event/attempt are rejected. OIDC identity separately requires the exact
main workflow ref and trusted base SHA.

All checkouts/imports use trusted base code. The fixed candidate ref is fetched
only as Git data, using command-scoped read authentication with no persistence.
The Git inspector requires exactly the five reviewed marketing/test blobs and
checks every historical added/modified object. Candidate scripts/actions are
never executed with publisher or broker credentials.

Main pushes start a new attempt; concurrency cancels superseded attempts.
Strict up-to-date checks remain mandatory. Each stage rechecks the live
candidate/base/run, and success is published only after fresh evidence. Lost
POST responses are not retried automatically. Lost success PATCH responses
fail the stage and attempt failure publication. Cleanup attempts ALL three
owned check IDs independently, records only fixed failed-stage names, and
fails after completing those attempts. It cannot overwrite a newer run's checks.
Actual candidate attachment, cancellation and stale-base behavior still require
live acceptance; deterministic tests are not proof of GitHub event delivery.

## Authenticated protection and publication broker

GitHub withholds `bypass_actors` from callers without ruleset write access.
Missing data, screenshots and unsigned/timestamp snapshots cannot be substituted
for current protection. The evidence boundary stays OUTSIDE release Actions.
The existing runner implements the actual client, HTTP handler, OIDC verification,
scoped App-token adapter, native approval verifier and signed-proof protocol.
It does not return a canned PASS when an external runtime is absent.

The fixed POST `/evidence` handler accepts either an evidence request or a
strictly shaped check-publication request. A random nonce and the complete
request/binding are hashed into the requested OIDC audience. The broker verifies
RS256 using GitHub's fixed JWKS endpoint, issuer, repository/owner IDs, exact
trusted-main workflow ref/SHA, event, run ID, attempt and validity period BEFORE
minting any privileged token. Candidate/ref/other-workflow proofs are rejected.
Approval-success publication additionally requires the matching protected
`environment` OIDC claim, actual owner approval history and successful prior
dedicated-App check IDs from the same bound run. The broker rechecks protection
and environment policies independently before a success write.

For protection observations, the broker reads the current PR, main, workflow
and fixed ruleset25301984, then signs a request-specific Ed25519 response. The
client verifies signature, nonce/request hash, publisher identity, BASE and
60-second lifetime, followed by every protection requirement. A new observation
is requested before each stage success. A changed or replayed proof fails.

App tokens are explicitly selected for repository1043384454. Returned grants,
App owner/ID and actual accessible repository list must match. Base grants:
`Administration:write`, `Contents:read`, `Pull requests:read`, `Actions:read`.
Only publication operations additionally request `Checks:write`; evidence-only
operations do not. The broker's repository operations are GETs or the exact
check-run POST/PATCH operations. It cannot merge, push code, change a ruleset,
approve deployments or create owner decisions. Token issuance/revocation are
separate, fixed App operations. Tokens are revoked in a finally block AFTER
the entire asynchronous operation completes; loss of revocation response is
bounded by GitHub expiry, not permission to issue another token blindly.

**Provisioning is NOT performed.** Creating/installing this privileged dedicated
App, storing its private key and choosing/starting its hosting require explicit
owner permission and approval of any additional cost. No owner PAT or privileged
existing controller credential is substituted. A release Actions job never
receives `Administration:write`, `Checks:write` or the broker's private keys.

External runtime configuration (never workflow secrets):

- `SALES_EVIDENCE_APP_ID` and `SALES_EVIDENCE_INSTALLATION_ID`: actual approved IDs;
- `SALES_EVIDENCE_APP_PRIVATE_KEY`: dedicated App RSA key;
- `SALES_EVIDENCE_SIGNING_PRIVATE_KEY`: separate Ed25519 PKCS8 signing key.

Command: `node tools/agent-pipeline/lib/sales-trusted-runner.mjs --serve-evidence`.
It refuses to run inside Actions, listens only on127.0.0.1 (default port8788),
limits request size and suppresses raw provider errors. An operator-managed
HTTPS reverse proxy or separately reviewed host adapter is required; do not
publish the bare HTTP listener or provision a host automatically. The deployed
broker code must be pinned to its reviewed version, never a candidate checkout.

Trusted public repository variables after separate configuration approval:
`SALES_EVIDENCE_URL` (HTTPS, exact `/evidence` path),
`SALES_EVIDENCE_PUBLIC_KEY` (Ed25519 SPKI PEM), and
`SALES_RELEASE_PUBLISHER_APP_ID` (the dedicated App's actual numeric ID).
No endpoint, key, App or runtime has been verified live in this patch.
Endpoint/key/identity changes are reviewed trust changes, not automatic fallback.

## Two real native owner decisions

The `owner` job uses environment `owner-acceptance` after scope success.
The `production` job uses `production-approval` only after owner success.
Both environments must have exactly the designated owner as required User
reviewer and a custom deployment-branch policy allowing only branch `main`.
Wildcard/tag policies, absent reviewers and indistinguishable environment IDs
are rejected. Existing agent-accept/promote files and controller flags are unchanged.

Before successful publication, both the trusted workflow and external publisher
validate `GET /actions/runs/{run_id}/approvals`. Evidence must contain the actual
owner's approved decision for the exact environment ID/name. Missing/rejected,
foreign actor, duplicated/ambiguous and combined-environment records are rejected.
Production requires two separate decisions and successful prior checks from
this exact run and dedicated App. PR prose, emoji and copied artifacts do not
satisfy the requirements. The code never invokes approval-write endpoints.

GitHub review-history responses do not bind a run attempt. Therefore only
attempt1 is accepted. Recovery is a NEW `workflow_dispatch` run with explicit
`expected_head`/`expected_base` and fresh decisions, not a rerun using old approval
history. Native independent code APPROVED review is separate from those owner
decisions; Codex COMMENTED or a positive issue comment does not replace it.

## Recorded verification

Original baseline51/51 PASS. Initial implementation126/126 local PASS and
full GitHub Checks39038751854 + Agent Gates39038751871/39038862111 SUCCESS for
7cc2d326. Independent Codex review5558129801 then found two P1s and one P2:
run-path compatibility4302946099; candidate-impersonable Actions producer4302946103;
cleanup stopping on first failure4302946109. These are addressed by the current
changes, subject to a fresh independent review, not automatically closed.

Node22.16.0 updated suite: **147 PASS / 0 FAIL / 0 SKIP**. Against the prior
7cc2d326 runner/workflow, the same suite gives **79 PASS / 68 FAIL**. Syntax
checks pass. All existing cases remain; realistic qualified/bare workflow paths,
workflow metadata, dedicated-App rule/check identity, real brokered publication,
wrong OIDC workflow/environment, rejected native approvals and all-stage cleanup
failures are covered. Cryptography is real; HTTP/provider identities are synthetic.
Full CI and independent review must be evaluated for the final pushed SHA.
No local full npm build/typecheck or live broker/customer E2E is claimed.

## Gated installation order — not executed

Finish current-SHA code review/CI, resolve actual findings and obtain formal
independent approval plus owner acceptance/explicit governance rollout permission.
Keep the installer Draft while findings or operational prerequisites remain.
With separate administrator permission, provision/verify the dedicated broker
and protected environments. Verify actual App scope, OIDC claims, signed proof
and check producer identity. Do not add bypasses, reduce reviews or weaken checks.

After approved governance installation on main, configure public variables and
activate `SALES_RELEASE_GATES_ENABLED` only for the approved test. Observe the
three dedicated check producers; configure their exact names and dedicated App
IDs as required in the main ruleset before any product merge. Missing contexts
fail closed; adding them cannot fabricate success. Rebuild/revalidate PR120
from the approved new main using only the five immutable reviewed blobs. Test
real stale/rejected/missing-proof and cancellation cases before declaring LIVE PASS.
Only separately approved production rollout may merge PR120.

PR120 is a five-file marketing/mailto inquiry release, NOT full self-service
FREE/PRESELEKCJA activation, payment/entitlements or CV processing. PR129 and its
real adapters remain a separate launch track. No product deployment, database,
voice/AI/payment operation or agent-loop activation is part of this patch.

Primary references:
- https://docs.github.com/en/rest/repos/rules#get-a-repository-ruleset
- https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run
- https://docs.github.com/en/rest/actions/workflow-runs#get-the-review-history-for-a-workflow-run
- https://docs.github.com/en/rest/checks/runs#create-a-check-run
- https://docs.github.com/en/actions/reference/security/oidc
