# Continuous release policy (SC-AUTO-RELEASE, issue #369)

Owner decision of **2026-11-16**, in his own message in the Claude Code session
https://claude.ai/code/session_01TVLzgcKNUtgiz4KTVzeVwF. It replaces every earlier arrangement
recorded in #369 (2026-11-08 policy, the 2026-11-15 conditions, stages 4a–4k).

**Overriding rule: no step of the release process requires a click, an approval or a manual start
by the owner.** Anything that truly cannot work without one is reported in #369 as one item with
the exact name of the setting — never worked around.

## How a change reaches production

1. A task PR is merged into `integration` as today: green required CI on its exact head SHA and
   an independent reviewer's **PASS on that exact SHA**, from a reviewer session other than the
   builder's. The builder never merges or reviews its own code.
2. The publisher (`.github/workflows/auto-release.yml`, code in `tools/release/auto/`) runs from
   `main` only — on a schedule and when `Checks` finish on `integration`. It has no manual start.
3. It takes the oldest merged PR that is not on `main` yet (from `min_pr` in
   `tools/release/auto/config.json`) and checks it with `tools/release/auto/policy.mjs`.
4. If allowed, it cherry-picks **exactly that PR's patch** onto `main` as `release/auto-pr-<N>`,
   verifies the patch is identical (`git patch-id`), opens a PR to `main`, waits for the required
   checks (`verify`, `Agent contract / scope gate`) on the exact release SHA and merges with the
   pinned SHA, using the existing pipeline GitHub App (environment `agent-control`).
5. It confirms the Vercel Production deployment of the merge commit (GitHub deployment status)
   and smoke-tests production: home page, login page (password form), Supabase auth health,
   registration page. No real login, payment or contact with anyone.
6. On a failed deployment or smoke test it reverts the release through an automatic
   `release/auto-revert-pr-<N>` PR and opens an issue titled `[auto-release-freeze] …`; while any
   such issue is open, **no** further release happens. Closing it (after a fix) resumes releases.

One release per run, serialized by the workflow concurrency group. An in-flight `release/auto-*`
PR is resumed only if the pipeline App opened it, its head is the SHA the publisher pushed, and its
content is recomputed and matches (release: same patch-id as the reviewed PR; rollback: exactly the
revert of a publisher release on `main`). Anything else freezes. An interrupted rollback is finished
by the next run even while releases are frozen.

**Rollback is not instant.** Without a Vercel token it is a revert PR on `main` that passes the
required checks and is redeployed by Vercel: up to about an hour of the broken version in the worst
case. A Vercel token would allow an instant rollback; that would be a new secret (owner decision).

## Authorization of a release

Green required CI on the exact SHA **plus** an independent PASS on the exact SHA. Nothing else:
no owner environment approval, no signed scope verdict from a separate App (both removed on
2026-11-16). The PASS is the machine-readable comment a reviewer posts on the source PR:

```
<!-- sc-review-verdict:v1 {"verdict":"PASS","head_sha":"<40-hex SHA>","reviewer":"session_<reviewer>","builder":"session_<builder>"} -->
```

Only comments by the repository owner/members/collaborators count; `reviewer` must differ from
`builder`; a later verdict on the same SHA that is not `PASS` (e.g. `FAIL`, `PASS WITH FIXES`)
cancels it. Free-text "PASS" without the marker does not count. While every agent session posts
with the owner's GitHub identity, reviewer/builder separation is procedural (session ids), not
technical: the `reviewer`/`builder` session ids are declared by the reviewer, not proven by GitHub
(same limitation as rule 5 in `AGENTS.md`). An unresolved review conversation or a standing
change request also blocks — see `REVIEW_THREADS_UNRESOLVED` below. The older
`CODEX_UNRESOLVED_FINDINGS` code reads a `codex-review-state:v1` marker that nothing in this
repository publishes, so it blocks nothing on its own and is kept only as an extra source.

## Refused automatically (hard, with an explicit reason code)

- `PAYMENT_PATH_FREEZE:<file>` — the owner's payment-path freeze (2026-11-15, unchanged):
  payment integration, purchase flow (`kup`, `checkout`), prices (`cennik`), package catalog and
  offers, order states, `stripe`. Lifted only when Stripe works in test mode and the owner says so.
- `PAYMENT_CONTENT_FREEZE:<file>` — any added/removed line mentioning Przelewy24/P24, Stripe,
  Fakturownia, checkout, prices (`zł`, `PLN`, `cena`, `price`…) or order states, whatever the file
  is called. A repository-wide test checks that every file mentioning payment identifiers is also
  frozen by path.
- `UNRELEASED_MIGRATIONS_PRECEDE` — `integration` holds migrations not yet on production; product
  code (`app/`, `lib/`, `supabase/`, …) may depend on them, so only docs/tests ship until they do.
- `PAYMENTS:<file>`, `OUTBOUND_SENDS:<file>` — billing/P24/invoices; mail/SMS/voice/notifications.
- `SECRETS_OR_PIPELINE:<file>` — `.github/`, env files, `vercel.json`, `supabase/config`, the
  agent pipeline, the publisher itself and `tools/db-migrate/` (the executor that runs with the
  production database credential). Changes to the gates need a human merge.
- `DESTRUCTIVE_SQL:<KIND>:<file>` — any `DROP …`, `DELETE FROM`, `TRUNCATE`, `ALTER TABLE … DROP`,
  `ALTER … TYPE`, `RENAME`, `UPDATE … SET` anywhere in a migration (comments included).
- `NON_ADDITIVE_SQL:<KIND>:<file>` — allowlist gate beside `DESTRUCTIVE_SQL`: a migration may contain
  only the outer `begin` (first statement) / `commit` (last statement) frame (any other transaction
  control anywhere else: `NON_ADDITIVE_SQL:TXN_CONTROL:<file>`; `--` comments end at LF or CR), `create schema`, `create table`, `create index`, `alter table … add column`,
  `alter table … enable row level security` and `comment on`. Anything else (`disable row level
  security`, `grant`/`revoke`, `create`/`alter policy`, functions or any `$$` quoting, views, inserts,
  other `alter table` actions …) is refused in the publisher and again in the migrate job, and waits
  for the owner via `db-migrate-production`. The SQL is read by one single-pass lexer (literals
  with `''` and `E'…'` escapes, `$tag$` bodies, quoted identifiers, `--` and nested `/* */`
  comments together), so a comment marker inside a literal hides nothing; input it cannot read
  cleanly is refused (`NON_ADDITIVE_SQL:UNPARSEABLE_*`). `DESTRUCTIVE_SQL` scans both the raw and
  the lexed text. After an interrupted run the list of applied migrations
  is re-derived from the merge commit, so a later rollback still carries `ROLLBACK_INSUFFICIENT_DATA_CHANGED`.
- Migrations at all, until both hold: a completed Supabase backup at most 24 h old
  (`BACKUP_EVIDENCE_MISSING` / `BACKUP_NOT_COMPLETED` / `BACKUP_STALE`) **and** an unattended
  migration executor (`MIGRATION_EXECUTOR_UNAVAILABLE` — until the owner places the secret below;
  the `production-approval` credential is never used by the publisher).
  **Path B (#491, owner 2026-11-17: „Na pierwsze pytanie to będzie B”, „Część pierwsza to
  uruchom.”):** additive migrations go out by themselves; destructive ones (`DESTRUCTIVE_SQL`,
  gate unchanged) keep waiting for the owner through `db-migrate-production`.
  - Executor = secret `AUTO_MIGRATE_DATABASE_URL` (optional `AUTO_MIGRATE_DATABASE_CA_CERT`) in
    the environment `auto-migrate`, without required reviewers, deployment branch `main` only.
    The name has no "production" in it on purpose: the deployment check matches `/production/i`
    and every environment job records a GitHub deployment. The job `executor` tests only its
    presence; without it everything is exactly as before.
  - Backup proof = the Supabase Management API backup list (`tools/release/auto/backups.mjs`,
    GET only, token `SUPABASE_ACCESS_TOKEN` of `agent-control`); no token or a failed read is
    `BACKUP_EVIDENCE_MISSING`.
  - Flow in one run: `publish` stops at `AWAIT_MIGRATIONS` (release PR open, its CI green, every
    gate rechecked) → `migrate` (`tools/release/auto/migrate.mjs`, trusted `main` code) takes the
    list from the release commit itself (only new files, `DESTRUCTIVE_SQL` again), checks the
    ledger and applies them one by one through `tools/db-migrate/apply.mjs` (statements + sha256,
    never `supabase db push`), stopping at the first error → `finish` merges only if exactly
    that list is reported applied for that exact release SHA.
  - After success the files are on `main`, so `UNRELEASED_MIGRATIONS_PRECEDE` disappears for
    them. On an error the release PR is closed unmerged, the source PR held, and a freeze issue
    opened with the code (`MIGRATION_FAILED:<file>:<SQLSTATE>`, `MIGRATION_PARTIAL_STATE`, …) plus
    `ROLLBACK_INSUFFICIENT_DATA_CHANGED` when at least one migration had committed;
    `MIGRATION_OUTCOME_UNKNOWN` when the migrate job died (also when a later run resumes an open
    release with migrations whose outcome was lost and cannot go on: then with
    `ROLLBACK_INSUFFICIENT_DATA_CHANGED`, as data may have changed; if it can go on, the migrate job
    is asked again and re-reads the ledger); `MIGRATIONS_APPLIED_RELEASE_HELD` when
    the migrations committed but the code release was stopped afterwards.
- `CI_*`, `REVIEW_*`, `CODEX_UNRESOLVED_FINDINGS:*`, `FILE_LIST_TRUNCATED`, `PATCH_MISMATCH`,
  `CHERRY_PICK_CONFLICT_OR_EMPTY`, `RELEASE_NOT_SERIALIZED`, `RELEASE_FROZEN`.
- `REVIEW_THREADS_UNRESOLVED:<n>:<paths>` / `REVIEW_CHANGES_REQUESTED:<author>` — a real review
  conversation left unresolved, or a standing `CHANGES_REQUESTED`, whoever opened it. The change
  request stands until its own author `APPROVED`s or it is `DISMISSED`, on any commit — a new push
  does not answer an objection, and a `COMMENTED` review is not a decision, so it never cancels
  one (GitHub records a reply in a thread as `COMMENTED`, and agent sessions write with the
  owner's identity, so the opposite rule would let an agent clear the owner's objection). An
  unsubmitted (`PENDING`) review on the exact head is `REVIEW_PENDING_SUBMISSION`; an unknown
  state or an unparsable timestamp is `REVIEW_STATE_UNREADABLE`; equal timestamps keep the
  blocking review. Added 2026-11-16 after the Codex review of #456/#458: `CODEX_UNRESOLVED_FINDINGS`
  reads only a `codex-review-state:v1` marker that nothing in the repository publishes, so an
  inline finding alone could not stop a release. Threads come from GraphQL (`isResolved` exists
  nowhere else); an **outdated** thread still counts, because the line moved, not the finding.
  Fail closed: a failed read is `REVIEW_THREADS_UNKNOWN` / `REVIEW_STATES_UNKNOWN`.
- `WORKER_DEPLOY_REQUIRED:<files>` — the change touches the screening worker or a module it shares
  with the app. `deploy-screening-worker.yml` is `workflow_dispatch` only, so a merge to `main`
  updates the Vercel app and leaves the Edge Function on its old version; a changed dispatch
  contract (for example the signature header in `lib/screening-hmac.ts`) would then stop CV
  analyses silently, since the production smoke test runs no real analysis. The held set is the
  worker's import closure computed from the release commit (`workerClosure`, 26 files today, all
  of them `supabase/functions/**` or `lib/**`, none under `app/`) plus `DISPATCH_COUNTERPARTS`,
  the app-side half of the same contract. Only files that exist in the tree enter the closure: a
  specifier written without an extension is resolved to the real file, because adding the bare
  path would drop that file and everything it imports out of the gate. Candidates tried for a
  specifier without an extension: the path itself, `.ts`, `.tsx`, `.mts`, `.d.ts`, `.js`, `.mjs`
  and the `index.*` of a directory of that name; `@/x` is resolved from the repository root, and
  only a blob counts, because a directory also satisfies an existence check. A specifier that
  resolves to nothing, an unreadable tree or the iteration limit all give `WORKER_SCOPE_UNKNOWN`
  — the closure is all or nothing, never silently truncated. A
  reverse import scan was tried and rejected: it could not be made precise and held two dozen
  unrelated UI files.
  **Cost, and it is a real one:** the closure holds 25 `lib/` modules that change often
  (`lib/screening.ts`, `lib/screening-ai.ts`, `lib/cv-bulk.ts`, `lib/ai-gateway/*`), so this code
  will trip frequently, and today nothing in the automatic path can clear it — deploying the
  worker is `workflow_dispatch` plus `production-approval`, both human steps. That contradicts the
  owner's standing rule that no release step may need his click. The owner was told the cost in
  chat on 2026-11-16 and did not object, which is **not** the same as approving it; no decision of
  his is recorded in the repository. The way out is to make the worker deploy part of the release
  instead of widening the gate — until then, a release touching these files waits for a human.
  **#461, stage 1 — the deploy step exists, the gate stays.** The publisher now has a worker
  deploy step (`deployWorkerStep` in `tools/release/auto/publisher.mjs`, runner in
  `tools/release/auto/worker-deploy.mjs`). After the release merge lands on `main` and Vercel
  has confirmed the app, and before smoke, it deploys `screening-worker` to production from a
  detached worktree of the exact merge SHA (never the publisher's checkout, never a PR branch;
  the SHA must be on `origin/main`), with the same command and pinned CLI as
  `deploy-screening-worker.yml`. Whether a commit needs it is decided by `workerGate` itself on
  that commit's diff and closure, so the step and the gate cannot disagree; an unknown scope
  counts as needing it. Success means exit code 0 **and** the CLI's confirmation line for that
  project and function. `afterDeploy` never returns DONE without it when it was needed:
  `WORKER_DEPLOY_FAILED` (failed, unconfirmed or for another SHA) and
  `WORKER_DEPLOY_UNAVAILABLE` (no `SUPABASE_ACCESS_TOKEN` in the job, or no deploy step) both
  mean rollback + freeze, never a silent skip. On rollback the worker is deployed again from the
  reverted `main` when the release had attempted a worker deploy (even a failed one may have
  half landed); when it never ran, the worker is left alone. A redeploy that fails is
  `ROLLBACK_WORKER_DEPLOY_FAILED` and the rollback counts as failed.
  The owner's rules here (chat, 2026-11-16): no release step may need his click, and
  `WORKER_DEPLOY_REQUIRED` stays until the automatic worker deploy actually works. So the gate
  still refuses every such release. **One-time step, BLOCKED on the owner (a secret):** a
  Supabase access token as the environment secret `SUPABASE_ACCESS_TOKEN` of `agent-control`
  (today it exists only in `production-approval`). Stage 2, a separate commit and review: after
  the token is placed and one real automatic deploy has been verified, the gate turns from a
  block into this step.
- After deploy: `SMOKE_FAILED` / `DEPLOYMENT_NOT_CONFIRMED` / `WORKER_DEPLOY_FAILED` /
  `WORKER_DEPLOY_UNAVAILABLE` → rollback + freeze. If the release
  had touched data through a migration, the log and the freeze issue also carry
  **`ROLLBACK_INSUFFICIENT_DATA_CHANGED`**: reverting code does not restore data.

A PR held by these gates is only logged (run log and step summary) and retried on the next run; a
new commit (new SHA) and a new review retry it too. A `HELD` comment on the PR is written only
where the hold must survive restarts: a refusal found again right before the merge, a release whose own CI went red
(`RELEASE_CI_FAILED`), or a failed start. Why a hold was written decides whether the same commit may be reconsidered. A `scope` hold
(payments, destructive SQL, provenance, the release's own CI) cannot change without a new commit
and holds for good. Two kinds can change on their own and are reconsidered by the next run:
`transient` — every reason code ends in `_UNKNOWN`, so an evidence read failed and said nothing
about the change; bounded by `TRANSIENT_ATTEMPTS` (3), because each attempt costs a cherry-pick, a
release PR and a CI run, after which it becomes a `scope` hold. `review` — the review state said
no (`REVIEW_*`): resolving the conversation or withdrawing the change request is exactly how that
is answered, and the commit must then become releasable again, because a closed PR cannot get a
new SHA and a permanent hold would mean a correct change, already on `integration`, never reaching
production. Unbounded, and cheap: while the review state still says no, `evaluate` refuses before
any cherry-pick, so the run opens nothing.
`REVIEW_PENDING_SUBMISSION` is defence in depth only: GitHub shows a `PENDING` review to its
author alone, so the publisher's App token will not normally see one.

## Nightly restore drill

`.github/workflows/backup-restore-drill.yml` (`tools/release/backup-drill/drill.mjs`), every
night, no manual start: read-only dump of production from one snapshot → restore into a
disposable Postgres 17.6 container in the runner → every table and exact row counts compared →
pending `integration` migrations applied on top → report in the run summary (counts and SQLSTATE
codes only). The dump never leaves the runner. Data of tables holding secrets/tokens/passwords and
live auth sessions is excluded by design. Needs the secret `BACKUP_DRILL_DATABASE_URL`
(environment `backup-drill`); without it the run reports `BLOCKED_MISSING_SECRET`. Creating that
secret is the owner's decision: it is a new production credential, and the drill copies production
personal data (CVs) into a GitHub-hosted runner for the duration of the run. The connection must be
a session (not transaction) pooler URL with `sslmode=require` for a role that can read every table
(read-only is enforced by the drill itself).

## Unchanged

Rulesets `main-production-protection` and `protect-main-integration` stay as they are (pull
request required, no deletions, no force pushes, conversation resolution). Production secrets,
permissions and costs are not changed by the publisher. A full `integration → main` promotion
outside the publisher still follows the Production loop in `AGENTS.md`.

## Superseded

`production-approval-attestation.yml` and `tools/production-approval/` are deleted (the job only
waited for the owner's environment approval; without it the workflow had no purpose and it is no
longer a required check). The `P24_HOLD` reason code and the signed scope-verdict requirement
(stage 4j, `readScopeVerdict`) are removed from `tools/agent-pipeline`. The agent-pipeline
qualifier (`evaluateAutoRelease`, whole `integration → main` range) stays as an offline tool and
shares the refusal list with the publisher (`OWNER_CONSENT_PATHS` in `tools/release/auto/policy.mjs`).
