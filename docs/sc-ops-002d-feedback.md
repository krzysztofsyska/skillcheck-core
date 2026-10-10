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
This evidence is rechecked immediately before the review request. The Cursor API
git snapshot alone is session-wide, so it is not sufficient attribution. Only then does
the adapter request `@codex review` once. A current-head APPROVED review or Codex's
thumbs-up on that exact re-review request yields READY_FOR_OWNER, never owner
acceptance. CI and the two existing approval gates still govern acceptance and
production. Base/head movement invalidates the thumbs-up binding. Two-hour repair
and 45-minute requested-review timeouts stop the adapter.

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
   on its update restriction; separate deletion/non-fast-forward rules without
   bypass. Bootstrap this branch once. Do not delete state to reset the limit.
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
   leave AGENT_PIPELINE_ENABLED and AGENT_PIPELINE_MERGE_ENABLED false. API preflight
   checks branch/gate protection before any agent call. The App must be permitted
   to trigger the installed Codex reviewer; a successfully posted comment is not
   proof that a bot-authored mention was accepted.

## Live synthetic acceptance

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
