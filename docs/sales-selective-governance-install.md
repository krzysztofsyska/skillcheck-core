# SkillCheck — selective release governance (PR #128 → PR #120)

**DRAFT / NOT ACTIVATED.** This change implements the three previously missing
release-gate paths. It neither grants an approval nor merges, deploys or
provisions anything. The external evidence runtime and its dedicated identity
have NOT been installed. Do not resolve live-readiness requirements merely
because the deterministic tests pass.

## Existing boundary

Repository: `krzysztofsyska/skillcheck-core` (ID `1043384454`). Owner ID:
`222297538`. This remains the same seven-file governance PR, from
`governance/sales-selective-main-gate-20261016` against original main
`76760b7ffb7e95231fc7af313cc67bc8d36fefe1`. The one-time installer exception
expires when main advances. No product code or other PR is changed.

The owner-created ruleset `25301984`, `main-production-protection`, was read as
ACTIVE on literal `refs/heads/main`, with no exclusions/bypass actors, deletion
and non-fast-forward protection, one approval, stale dismissal, latest-push
approval and conversation resolution. Its two existing required checks are
`verify` and `Agent contract / scope gate`, strict and pinned to GitHub Actions
App `15368`. Preserve that baseline. A connector's administrative observation
is not authorization evidence for a different workflow token.

## 1. Candidate-bound checks — discussion_r4302382315

The workflow explicitly creates three check runs on PR #120's candidate
`head.sha`; the automatic `pull_request_target` job checks are deliberately
named differently and are NOT merge evidence. Each required check's
`external_id` binds repository, PR, HEAD, BASE, workflow run, attempt and stage.
All three begin `in_progress`. Only the corresponding verified stage can
complete its own check. No API call here can merge a PR, publish a deployment
approval or alter a ruleset.

Required contexts after approved installation and producer verification:

| Context | Producer | Requirement |
| --- | --- | --- |
| `verify` | GitHub Actions, App 15368 | Existing ordinary CI |
| `Agent contract / scope gate` | GitHub Actions, App 15368 | Existing scope contract |
| `Sales selective scope verified` | Explicit candidate check, App 15368 | Reviewed Git objects + live protection |
| `Sales owner acceptance` | Explicit candidate check, App 15368 | Native owner-acceptance decision for this run |
| `Sales production approval` | Explicit candidate check, App 15368 | Separate native production-approval decision for this run |

The checker requires all five contexts in the protected-main policy before
publishing success. Checkout/import is always from the trusted base SHA. The
fixed release ref is fetched only as Git data with command-scoped read
credentials. Candidate code is never executed with publishing credentials.
Release jobs have `checks:write`, read grants, and (where needed)
`id-token:write`; they have NO contents/PR/deployment/ruleset write permission.

Each stage re-reads the live PR, main and exact workflow run. Failure, changed
HEAD/base, wrong source/run/attempt and unknown evidence fail closed. A
best-effort failure update uses only the original check IDs and cannot overwrite
another run's checks. Lost POST responses are not retried automatically. A lost
success PATCH response fails the stage and attempts a failure result; it is not
blindly retried as success. Pending or failed checks block merge.

A main push triggers a fresh run, and workflow concurrency cancels superseded
attempts. Strict required checks remain mandatory; a base update is not an
excuse to reuse a stale success. Manual recovery is a **fresh** workflow_dispatch
with exact `expected_head` and `expected_base`, not rerunning an old approval.
The previous current-base audit is repeated before each success publication.
Actual event/check attachment and stale-base enforcement must still be observed
in the live acceptance test before release.

## 2. Authoritative protection evidence — discussion_r4302382323

GitHub documents that `bypass_actors` is only disclosed to a requester with
write access to the ruleset. The release workflow must NOT receive that grant.
There is no safe conversion of a missing field, a screenshot or a timestamp
snapshot into an empty bypass list.

The existing runner now also exports a **separate external evidence handler**:
`handleProtectionEvidence`. It is real HTTP/cryptographic/GitHub adapter code,
not a callback that returns a canned PASS. It has one operation: inspect this
repository's fixed main ruleset for the exact live candidate/run binding.

Protocol:

1. The release job generates a random nonce and obtains a GitHub OIDC token
   whose audience is the hash of the complete evidence request.
2. The broker verifies RS256 using GitHub's fixed JWKS endpoint, then checks
   issuer, request audience, repository/owner IDs, trusted main workflow ref/SHA,
   event, run ID, attempt and token validity. A different workflow/branch or
   candidate request cannot reuse that authorization.
3. Only then does the broker mint a short-lived, repository-selected installation
   token for its dedicated App. It verifies App owner/ID, returned grants and
   the token's actual one-repository scope. It reads the current PR/main/run and
   ruleset `25301984`; missing, malformed or nonempty bypass data is rejected.
4. The broker signs a nonce/binding-specific observation with Ed25519. Its
   lifetime is 60 seconds. The workflow checks the signature, request hash,
   observation time, repository/ruleset identity and all protection requirements.
   It requests a new observation before every successful stage publication.
5. The broker revokes its installation token in a finally block. Transport loss
   during revocation remains bounded by GitHub's token expiry; it does not
   silently grant the token to the workflow or trigger another mutation.

**Unavoidable administrative prerequisite, not performed:** the dedicated
broker App needs `Administration:write` because of GitHub's disclosure rule,
plus `Contents:read`, `Pull requests:read` and `Actions:read`, selected ONLY for
repository `1043384454`. This privilege stays outside Actions. The broker code
performs only repository GETs; token issuance/revocation are its only external
writes. Creating/installing this identity, storing its key, selecting a hosting
location and approving any cost require an explicit owner decision. This patch
does not reuse an owner PAT or elevate the existing release/controller App.

External runtime configuration (never GitHub workflow secrets):

- `SALES_EVIDENCE_APP_ID` — actual owner-approved dedicated App ID;
- `SALES_EVIDENCE_INSTALLATION_ID` — actual installation ID;
- `SALES_EVIDENCE_APP_PRIVATE_KEY` — that App's RSA key;
- `SALES_EVIDENCE_SIGNING_PRIVATE_KEY` — a separate Ed25519 PKCS8 PEM key.

The standalone command is
`node tools/agent-pipeline/lib/sales-trusted-runner.mjs --serve-evidence`.
It refuses to start inside GitHub Actions, binds to loopback `127.0.0.1`
(default port 8788), serves only POST `/evidence`, limits request size and
suppresses raw provider errors. An operator-managed HTTPS reverse proxy or a
separately reviewed host adapter is required. Do not publish this bare HTTP
listener, commit keys, invent App IDs/URLs, or provision a server automatically.
The deployment must pin reviewed broker code; it must not execute a candidate
checkout. Public-key rotation and endpoint changes are trust changes and need
review, not automatic fallback to a new key.

After approved provisioning, set the public configuration in trusted repository
variables: `SALES_EVIDENCE_URL` (HTTPS, exact `/evidence` path) and
`SALES_EVIDENCE_PUBLIC_KEY` (Ed25519 SPKI PEM). The release job sends only its
short-lived OIDC proof to that endpoint, never GITHUB_TOKEN or the broker key.
No verified endpoint/key/runtime currently exists in the evidence collected for
this patch. Consequently **live evidence and live PASS remain unconfirmed**.

## 3. Two actual approval gates — discussion_r4292657545

The workflow uses the existing environment names, without changing existing
agent-accept/promote workflow files or enabling the agent controller:

- `owner` job: `environment: owner-acceptance`, after successful scope;
- `production` job: `environment: production-approval`, only after owner success.

Both environments must have exactly the designated owner as required User
reviewer (ID `222297538` and login `krzysztofsyska`), and a custom deployment
branch policy allowing only branch `main`, not a tag/wildcard or arbitrary
protected branch. The release code verifies those API responses; it does not
assume that an environment label itself supplies protection.

Before publishing an approval check, the code reads
`GET /actions/runs/{run_id}/approvals` and requires the actual owner's approved
review for the exact environment ID/name. Missing/rejected/foreign-user,
duplicate/ambiguous or combined-environment decisions are refused. Production
requires two separate records and current-run successful scope/owner checks.
No PR prose, emoji or copied artifact can substitute for this evidence.

GitHub's documented review-history response does not identify the run attempt.
Therefore this implementation accepts **attempt 1 only**. A failed or cancelled
attempt is recovered with a new explicit workflow_dispatch (new run ID and new
decisions), never by pretending approval history from attempt 1 proves attempt
2. Failed stages cause a cleanup job to mark that run's checks as failure.
The workflow never calls the pending-deployments approval endpoint and cannot
approve on the owner's behalf. Native independent code review remains separate:
Codex COMMENTED/positive comments do not satisfy GitHub's formal APPROVED rule.

## Verification recorded for this patch

Node 22.16.0: reconstructed baseline bytes matched the fetched Git blobs;
baseline 51/51 PASS. Expanded suite against the unchanged runner: **51 PASS,
75 FAIL** (including missing new runtime APIs). Corrected implementation:
**126 PASS / 0 FAIL / 0 SKIP**. JavaScript syntax checks pass. Tests cover
candidate check publishing, stale target/run/attempt, lost responses, real
approval-history shapes, environment restrictions, cryptographic signature and
nonce binding, rejected/missing bypass evidence, and composed release-stage →
OIDC client → broker → scoped installation reads → signed proof verification.
Cryptography is real; GitHub HTTP responses, keys and identities are synthetic.

These are deterministic OFFLINE tests, not vendor integration or customer E2E.
Full-repository CI and independent review must be read for the final pushed SHA.
The local workspace is a reconstructed subset; no claim is made that local
npm build/typecheck/full tests were run here. Neither cloud builder started:
Cursor reported a spending/billing block; Codex implementation required a repo
environment. Direct implementation was used; independent Codex review is a
separate step, not self-approval.

## Safe installation order — not executed

1. Finish independent review/CI of this exact seven-file PR. Keep it Draft while
   code findings or operational requirements are unverified. Obtain formal
   independent APPROVED review, owner acceptance and explicit governance/main
   rollout permission. The installer does not grant itself approval.
2. With separate administrator permission, configure the dedicated external
   broker/runtime and the two protected environments. Verify its actual identity,
   scope, OIDC claims and signing key. Do not add a bypass or reduce approvals.
3. After authorized installation on main, configure the trusted public evidence
   variables and enable `SALES_RELEASE_GATES_ENABLED` only as part of the approved
   test. Observe all three candidate check producers; add their exact contexts,
   pinned to App 15368, to the main ruleset before any product merge. Missing
   contexts fail closed; adding them does not manufacture successful results.
4. Rebuild/revalidate PR #120 on the approved new main using only the five
   immutable reviewed marketing blobs. Re-run CI, independent review, native
   owner decisions and candidate-bound checks. Verify real failure paths,
   head/base changes and rejection before declaring the release mechanism ready.
5. Only an explicit approved product rollout may merge PR #120. Check the actual
   Vercel version and inquiry page afterward. PR #120 is still a five-file mailto
   inquiry release, NOT complete self-service FREE/PRESELEKCJA activation,
   checkout, entitlements or CV processing. PR #129 remains a separate launch
   track. No database/payment/voice/AI operation is part of this change.

References (primary):
- https://docs.github.com/en/rest/repos/rules#get-a-repository-ruleset
- https://docs.github.com/en/rest/actions/workflow-runs#get-the-review-history-for-a-workflow-run
- https://docs.github.com/en/rest/deployments/environments#get-an-environment
- https://docs.github.com/en/rest/checks/runs#create-a-check-run
- https://docs.github.com/en/actions/reference/security/oidc
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target
