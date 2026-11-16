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
(same limitation as rule 5 in `AGENTS.md`). Unresolved Codex findings on the exact SHA also block.

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
  agent pipeline and the publisher itself. Changes to the gates need a human merge.
- `DESTRUCTIVE_SQL:<KIND>:<file>` — any `DROP …`, `DELETE FROM`, `TRUNCATE`, `ALTER TABLE … DROP`,
  `ALTER … TYPE`, `RENAME`, `UPDATE … SET` anywhere in a migration (comments included).
- Migrations at all, until both hold: a completed Supabase backup at most 24 h old
  (`BACKUP_EVIDENCE_MISSING` / `BACKUP_NOT_COMPLETED` / `BACKUP_STALE`) **and** an unattended
  migration executor (`MIGRATION_EXECUTOR_UNAVAILABLE` — today always: the only production
  database credential lives in `production-approval`, which needs a human).
- `CI_*`, `REVIEW_*`, `CODEX_UNRESOLVED_FINDINGS:*`, `FILE_LIST_TRUNCATED`, `PATCH_MISMATCH`,
  `CHERRY_PICK_CONFLICT_OR_EMPTY`, `RELEASE_NOT_SERIALIZED`, `RELEASE_FROZEN`.
- `REVIEW_THREADS_UNRESOLVED:<n>:<paths>` / `REVIEW_CHANGES_REQUESTED:<author>` — a real review
  conversation left unresolved, or a standing `CHANGES_REQUESTED` on the exact head SHA, whoever
  opened it. Added 2026-11-16 after the Codex review of #456/#458: `CODEX_UNRESOLVED_FINDINGS`
  reads only a `codex-review-state:v1` marker that nothing in the repository publishes, so an
  inline finding alone could not stop a release. Threads come from GraphQL (`isResolved` exists
  nowhere else); an **outdated** thread still counts, because the line moved, not the finding.
  Fail closed: a failed read is `REVIEW_THREADS_UNKNOWN` / `REVIEW_STATES_UNKNOWN`.
- `WORKER_DEPLOY_REQUIRED:<files>` — the change touches the screening worker or a module it shares
  with the app. `deploy-screening-worker.yml` is `workflow_dispatch` only, so a merge to `main`
  updates the Vercel app and leaves the Edge Function on its old version; a changed dispatch
  contract (for example the signature header in `lib/screening-hmac.ts`) would then stop CV
  analyses silently, since the production smoke test runs no real analysis. The held set is the
  worker's import closure computed from the release commit (`workerClosure`, 23 files today) plus
  `DISPATCH_COUNTERPARTS`, the app-side half of the same contract; an unreadable closure is
  `WORKER_SCOPE_UNKNOWN`. A reverse import scan was tried and rejected: it could not be made
  precise and held two dozen unrelated UI files. Accepted cost (owner, 2026-11-16): releases
  touching the worker contract lose automation until the worker is deployed with them.
- After deploy: `SMOKE_FAILED` / `DEPLOYMENT_NOT_CONFIRMED` → rollback + freeze. If the release
  had touched data through a migration, the log and the freeze issue also carry
  **`ROLLBACK_INSUFFICIENT_DATA_CHANGED`**: reverting code does not restore data.

A held PR gets one comment with the reason; a new commit (new SHA) and a new review retry it.

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
