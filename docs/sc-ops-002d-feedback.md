# SC-OPS-002D — Codex feedback bridge

TASK: SC-OPS-002D; LEVEL: L3; SCOPE: OPERATIONS
OWNER: krzysztofsyska; REVIEWER: independent Codex review
ISSUE: #56; DEPENDS ON: #40 / #41; E2E: #48 / #49
BASE: integration `9307d8cab5c1269fb04a1fe98a8add4d39a745cb`
BRANCH: chore/sc-ops-002d-feedback-loop
STATUS: implementation prepared, activation and live E2E BLOCKED_CONFIGURATION
DB / MIGRATIONS: none

## Design and boundary

The existing controller accepts its own structured review artifacts and owns its
own PRs. PR #49 was created by the Cursor GitHub integration, outside that journal.
It cannot be silently adopted as a controller task. This adapter handles explicitly
registered external PRs, reusing the existing GitHub/Cursor clients and protection
preflight. Its records live on `agent-feedback-state`, outside `agent-state`.
The two controllers cannot be enabled together; a PR already in the old journal
is also rejected. No main/integration writes, merge, gate approval, migration or
deployment operations exist in this adapter.

The initial release deliberately accepts exact `docs/*.md` paths (including
subdirectories), excluding AGENTS.md. This covers the synthetic test. Extending
to code/workflow changes requires a separately reviewed scope policy; a prompt
alone is not filesystem isolation. The remote Cursor account must have no
production credentials, and protected branches must prevent its merge/push.

The shared live controller also requests a repository-specific installation
token with exact necessary grants, including `Administration:read` but never
`Administration:write`. Unexpected returned permissions/repositories or missing
App credentials abort the workflow before agent effects; an owner PAT is never
a fallback for live mutations. GitHub's directly disclosed `bypass_actors`
must not be treated as proof of least-privilege without that token restriction.
The feedback adapter uses a separate installation token: contents write, issues
write, pull requests read, administration read, and actions read. Actions read
exists only so protection checks can read environments and deployment branch
policies; the token is not granted Actions write. Returned grants must match
that set, and the token must be selected for this repository alone.

The adapter polls submitted review/inline-comment APIs every five minutes; a
trusted Codex issue comment also wakes it. Polling recovers missed/coalesced
events. It does not execute PR-supplied code or interpret comment bodies as shell.
An arbitrary top-level comment is not a review verdict. Numeric Codex user ID,
login and bot type must all match. Inline findings must belong to a submitted,
non-dismissed review on the current head; replies and outdated lines are ignored.
The prompt passes only constructed links to finding IDs, never provider text.

## Durable transitions

`WAITING_REVIEW -> CURSOR_PENDING -> FIXING -> REVIEW_PENDING -> WAITING_REVIEW`

Every outbound call follows a successful contents-API compare-and-swap reservation.
Duplicate observations on the same head share one repair, even if review and
comment events both arrive. At most three reservations across all heads of the
registered PR are allowed. A changed binding cannot reset the saved counter.
Two simultaneous invocations cannot both reserve the same revision. Failure to
persist a reservation means no dispatch; lost responses or crashes after reservation
leave a pending state and are never retried automatically.

The agent must be idle and bound by its v1 API identity to the exact PR, or the
exact branch with workOnCurrentBranch=true; autoCreatePR must be false. A completed
run must remain the agent's latest run and the PR head must change. Cursor's pushed
repository/branch (and PR URL when present) must match the binding. GitHub must
return the complete linear commit suffix from the reserved head to the new head
(maximum 100 commits), each with a valid verified signature and the configured
`cursorCommitter` bot ID/login/type. The final commit must contain the unique
`SkillCheck-Repair` trailer reserved for this operation and sent in its prompt.
Unrelated, unsigned, mixed-author or incomplete evidence stops at BLOCKED_PROVENANCE.
Every commit in that suffix must also carry GitHub's complete file list, and every
path it records, including a rename source, must be inside the binding allowlist.
The commit endpoint pages that list, 30 files by default and 100 at most. The
adapter requests `per_page=100` and continues until a short page. A full last
page, a missing page, or 300 or more paths is not a complete list.
A later revert does not erase an earlier out-of-scope commit. The repository's
Checks workflow runs on push only for `main` and `integration`; pull requests still
run it. This does not recall a push that already happened and does not control a
deployment configured outside the repository. There is no push deployment workflow
in this repo.
This evidence is rechecked immediately before the review request. Actionable
findings are recomputed from the fresh snapshot immediately before `createRun`.
An empty or changed set does not start Cursor; the reservation stays
`CURSOR_PENDING` instead of sending the earlier finding list. The Cursor API
git snapshot alone is session-wide, so it is not sufficient attribution. Only then does
the adapter request `@codex review` once. A current-head APPROVED review or Codex's
thumbs-up on that exact re-review request yields READY_FOR_OWNER, never owner
acceptance. CI and the two existing approval gates still govern acceptance and
production. Base/head movement invalidates the thumbs-up binding. A review
request that is still `WAITING_REVIEW` is replaced once when the head or base
moves and the current head has no unhandled finding; the stale request cannot
time out into `BLOCKED_TIMEOUT`. Two-hour repair and 45-minute requested-review
timeouts stop the adapter. Only the trusted reviewer's latest `APPROVED` or
`CHANGES_REQUESTED` on the current head is a decision. A later `COMMENTED`
review does not replace that decision. An earlier `CHANGES_REQUESTED` does not
stay actionable after a newer `APPROVED`. Inline comments on every non-dismissed
review of that head remain findings.

No raw API errors, agent results, credentials or reviewer prose are logged or
stored. Failure output is intentionally generic; inspect the durable phase and
service metadata through the privileged operator session. Existing transport
retries apply to reads only. Pending mutations require operator reconciliation,
not deletion of state or another dispatch.

Each binding is processed independently. A closed/retargeted PR, failed API read
or other exception emits only `{pr, status: BLOCKED_BINDING}` and does not prevent
later bindings from running. Existing pending reservations are preserved. After
processing all bindings the CLI returns a failing exit code if any result is
blocked; no raw error is reflected. Shared configuration/protection failures
still stop the whole invocation before dispatch.

## Activation prerequisites — not performed by this PR

1. Finish #40 and independently review #41: verified dedicated App IDs, gate
   environments, branch rules, isolated review credentials and provider budget.
   This adapter uses the installed Codex GitHub reviewer; it needs no OpenAI key.
2. Protect `agent-feedback-state`: exclusive App writer with always bypass only
   on its update AND creation restrictions; separate deletion/non-fast-forward
   rules without bypass. Bootstrap this branch once. Do not delete state to reset
   the limit. The previously configured writer rule still needs `Restrict creations`.
3. Restrict agent-control to main; keep Cursor and App credentials there. Configure
   the Cursor agent without production secrets and verify access to the existing PR
   through GET /v1/agents/{id}. A footer URL alone is not proof of API compatibility.
4. Register exact PR number, agentId, branch, initialHead, originIntegration,
   cursorCommitter (verified bot numeric ID and login),
   allowedFiles, level=L3 and scope=OPERATIONS in feedback.json after verification.
   originIntegration is an attested historical integration SHA; both ancestry
   comparisons must pass. Verify that this Cursor setup produces GitHub-verified
   commits under that bot committer; neither a footer, git email nor unsigned commit
   proves this. Unsupported signing/identity remains blocked, with no invented IDs
   or fallback to human commits. Config stays empty and disabled in this implementation.
5. Have the reviewed workflow installed on the trusted default branch through an
   owner-approved promotion. GitHub issue_comment/schedule require default-branch
   installation. A draft PR into integration does not activate them. Since main
   is the production source, this chat must not merge there to bypass this blocker.
6. Enable config.enabled and AGENT_FEEDBACK_ENABLED only for the bounded test;
   leave AGENT_PIPELINE_ENABLED and AGENT_PIPELINE_MERGE_ENABLED false. The
   workflow and the runtime both require the merge switch to be explicit
   `false` before any Cursor dispatch. API preflight
   checks branch/gate protection before any agent call. The App must be permitted
   to trigger the installed Codex reviewer; a successfully posted comment is not
   proof that a bot-authored mention was accepted.

## Live synthetic acceptance

### Read-scope protection evidence and state provenance

GitHub omits `bypass_actors` for Administration:read callers. Missing
information is **unknown**, not an empty list. The previous optional
`policy.json.ruleset_attestations` fallback is **not trusted** for live
authorization: a SHA-256 fingerprint and GitHub `updated_at` cannot detect
a bypass-actor edit that occurs within the same timestamp resolution.
GitHub's ruleset history exposes a monotonic `version_id`, but its REST
history/version endpoints require Administration:write. The controller
must **not** receive that elevated permission just to circumvent a gate.

`withRulesetEvidence` now accepts only a directly disclosed
`bypass_actors` array in the authenticated GitHub ruleset response.
Without it, the shared controller and feedback bridge stop before effects
with `RULESET_BYPASS_UNVERIFIABLE`; even an apparently matching,
owner-reviewed timestamp attestation must not override the block.
Disabled reconciliation is the exception that stays read-only: a metadata
`GITHUB_TOKEN` cannot see `bypass_actors`, so both the work-loading read and
`defaultPorts().readProtection()` treat the hidden list as unknown protection
and perform no effects. Enabling the controller does not gain that exception.
This is an intentional fail-closed security fix, not a live activation.
Future automatic authorization under read-only credentials requires a
separately designed and reviewed reliable current-version proof; do not
invent a `version_id` from a timestamp or raise the controller's scope.

Trusted policy also needs `feedback_state_bootstrap: {sha, owner_id}` and the
verified `controller_actor_id`. Attest the actual audited initial state-branch
commit; never assume an arbitrary existing branch is trusted. Its tree must have
no `feedback` entry. Every later commit must form a complete linear suffix with
GitHub-verified signatures and the configured controller bot committer. A forged
pre-bootstrap state, unsigned/unrelated commit or incomplete comparison blocks
execution. This bounded implementation supports up to 100 state commits after
bootstrap. A transition is refused, before any external effect, unless the
ledger has room for every write that transition will make: one for a state-only
change and two for a review reservation plus its completion. Starting Cursor
reserves four: the dispatch pair plus the later failure or review-request pair.
The unwritten remainder is stored on that binding as `ledgerHold`. Every poll
adds every binding's hold to the branch commit count, so a later poll or
another binding cannot spend those slots. A failure or timeout persists the
terminal phase and releases the unused remainder. A review handoff spends the
held pair. Repair rounds stay capped at three; a later round reserves its own
lifecycle. The 100-commit ceiling stays in force and the ledger is not reset. Neither policy
attestations nor bootstrap identity have been populated by this patch. Confirm
the App's actual signed-commit behavior before activation.

Native approvals count only when submitted after a recorded review request for
the exact current head/base, and absent from its pre-request review baseline.
`submitted_at` and the recorded request time are compared at GitHub's whole-second
resolution. The review baseline is the review list read after the request comment
exists, so an approval already visible at that read cannot authorize READY. A
baseline-excluded approval in that same second can still count.
READY is re-evaluated on every poll; removed evidence or new findings persistently
revoke it. A changed base or head invalidates the old request. When that
invalidated READY record has no new repair to run, the adapter reserves and posts
one replacement `@codex review` for the new head/base, then waits on that request.
Approvals already present are stored in the new baseline and cannot authorize READY.
A lost post remains `REVIEW_PENDING` and is not retried. No stale approval is
silently reused.

Reference: [GitHub ruleset API visibility](https://docs.github.com/en/rest/repos/rules).

### Connection diagnostics (not live acceptance)

`Agent connection diagnostics` (`agent-diagnostics.yml`) is manual-only and
requires all three repository switches to equal `false`. It runs trusted `main`
code in `agent-control`; it cannot run from the task branch. Installation on main
still requires the normal reviewed integration-to-main promotion and explicit
owner production approval. Do not weaken the environment restriction to test it.

After authorized installation, use Actions > Agent connection diagnostics > Run
workflow on main with an existing Cursor agent ID. The previously observed PR49
ID is `bc-00f193ea-2c96-4b93-a3aa-12a074bd0b78`; its accessibility is not assumed.
The script verifies App 5216184, installation 168649570 and repository identity,
checks the state branch and its rules plus the agent-control restriction, and
reads the selected Cursor agent. It only prints fixed check names and PASS/FAIL.
It requests a repository-scoped read-only installation token for repository id
1043384454 with contents, administration, and actions read, and revokes it on
completion (if interrupted, GitHub expiry remains the fallback). The response
must report `repository_selection: selected` for that exact repository. A broader
repository grant or a missing or elevated permission fails the check. Actions
read is required to read environments and deployment branch policies; the token
is not granted Actions write. It makes no repository writes and starts no agents.
Redirects are refused; requests time out.

A green result confirms connectivity and these protections only, not Cursor
target/signature compatibility, owner/production approval gates or live E2E.
The workflow must actually execute its diagnostics step: a skipped job is not a
PASS. Failed checks identify the area to repair without exposing service errors.

API references: [Cursor agent endpoints](https://prod.cursor.com/docs/cloud-agent/api/endpoints)
and [GitHub installation tokens](https://docs.github.com/en/enterprise-cloud%40latest/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

At inspection, PR #49 head was `92bb783a7555be78d59d50ef25c3f734bd5df8c9`.
Codex finding: discussion 4209497457, review 5445420558, actor 199175422.
Cursor footer references bc-00f193ea-2c96-4b93-a3aa-12a074bd0b78; its API identity
and autoCreatePR setting have NOT been verified. Do not register it until verified.
If incompatible, create a purpose-configured synthetic agent/PR from integration
instead of relaxing the binding check. Only docs/agent-feedback-loop-test.md may
change; ACTUAL_TOKEN=UNSAFE is a harmless first-pass mismatch.

Live PASS requires all of: genuine Codex finding on the initial SHA; one reserved
Cursor run; automatic new commit on the same PR changing ACTUAL_TOKEN to SAFE;
new Codex review/request evidence on that SHA; no outstanding current-head finding;
required checks; no fourth repair, duplicate dispatch, merge or deployment.
Offline test doubles are not that evidence. At preparation, no live dispatch has
been made and live PASS is NOT claimed. Rulesets API still returns [] and the
original agent-state branch is absent. No Cursor/App credentials are available in
the current shell; no secrets were read from disk or printed.

## Verification and handoff

Tests exercise the offline positive cycle and rejection of forks, stale/spoofed
reviews, retargeting, out-of-scope files, duplicate heads, concurrent reservations,
lost responses and budget reset. See the PR for final command results and exact SHA.
Code additions: feedback workflow/config, feedback state machine/CLI and tests.
Existing product/controller/approval code remains unchanged.

NEXT ACTION / complete continuation prompt:

Executor: independent Codex reviewer, new review on the SC-OPS-002D PR in
krzysztofsyska/skillcheck-core. Read #56, #40, #41, #48/#49, AGENTS.md and this
document. Pin current PR head and review the entire diff, especially trusted code
selection, CAS reservation, three-round cap, state protection, Cursor identity,
comment provenance, no secret reflection and no merge/deploy capability. Run
npm run test:agent-pipeline and inspect CI. Report PASS/PASS WITH FIXES/FAIL with
concrete file/line findings on the PR. Do not enable flags or merge. After review,
the authorized administrator must complete the listed prerequisites and run the
bounded live synthetic test, collecting actual Cursor commit and Codex re-review
evidence. Report LIVE PASS only with that evidence, otherwise BLOCKED with exact
missing prerequisites. Owner acceptance and production approval remain separate.

Sources checked: [Cursor API](https://cursor.com/docs/cloud-agent/api/endpoints),
[Codex GitHub review](https://learn.chatgpt.com/docs/third-party/github),
[GitHub event behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).
