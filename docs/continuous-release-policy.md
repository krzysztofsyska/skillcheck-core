# Continuous release policy (SC-AUTO-RELEASE, issue #369)

Owner-approved 2026-11-08. This is a standing consent for the scope below. It is **not** proof that any gate passed and **not** permission to bypass one. Writing this policy does not mean automatic publishing works: that is true only after the trusted publisher is implemented, reviewed and verified (see "Status").

## Pipeline
coding -> tests -> independent review -> merge to `integration` -> automatic production release (only when every condition below holds).

## Automatic (when all evidence is present)
- Fixes, UI and features inside the agreed scope.
- Backward-compatible database additions (optional columns/tables).
- Only after: current CI green, independent review PASS on the exact head SHA, and verification of the **whole** release (all changes from current production to the candidate, not just the last PR).

## Needs separate owner consent
- Deleting data or irreversible transformations.
- Price, charge or payment-rule changes.
- New real outbound messages, or wider recipients/frequency/purpose. Already-approved payment/sending behaviour needs no new consent.
- New costs, wider access, production secrets.

## Absolute HOLD
HOLD P24 stays in force until documented tests and a separate owner release. Green CI and this policy do **not** lift it.

## Rules for the publisher
- Fail closed: missing or stale data means refuse. Never an assumed PASS. Mixed-scope releases are held.
- Uses trusted code and gates, never candidate code as its own authorization. A builder's own JSON, label or comment does not authorize anything. No privileged execution of PR code, no untrusted artifacts.
- Evidence is bound to repo, base SHA, head SHA and artifact. Any SHA change invalidates the decision.
- Releases are serialized; retries must not double-apply effects.
- Before publishing: CI/review evidence, base compatibility, a working recovery/backup plan for migrations, tests of the prepared version. After: smoke test without real payments or contacts. A failure stops later releases. Application rollback only if the database is compatible; code rollback does not restore data.
- Does not forge `production-approval-attestation`, does not approve environments as the owner, does not change permissions, secrets or branch protection.

## Roles
Builder and reviewer stay separate; the builder never merges or reviews its own change. After Draft -> Ready, merge waits for all configured automatic reviews (including Codex) to complete on the current SHA with no open findings.

## Status
- IMPLEMENTED: this policy document.
- NOT IMPLEMENTED: trusted fail-closed release preflight in `tools/agent-pipeline` (next step of #369), activation stage, live verification.
- Until the publisher is deployed and verified: prepare releases and fix blockers; no manual production workarounds.

## Qualification module (step 2–4 of #369)
`tools/agent-pipeline/lib/auto-release.mjs` — `evaluateAutoRelease()` is pure and fail-closed. It builds on `preparePromotion` (whole-range manifest, per-task `verified_ci_review` evidence) and `protectionFromRulesets` (effective rulesets/environments). It returns `DENY` with reason codes unless: P24 hold released by trusted config (only literal `false`), manifest covers every commit, every task has verified CI+review, CI/review/Codex are completed on the exact current integration SHA with no open findings, SHA/base unchanged, protection confirmed, scope is not payments / outbound sends / pipeline-secrets, no file falls under the owner's payment-path freeze of 2026-11-15 (`PAYMENT_PATH_FREEZE`: purchase flow `kup`/`checkout`/`purchase`, prices/`cennik`, package catalog/offers, orders, `stripe`; always on until a reviewed change lifts it after the owner does), every migration statement matches an explicitly recognised narrow additive shape (nullable `ADD COLUMN` of a simple type, plain `CREATE INDEX`; anything else, including new tables, RLS/policies/grants, functions, `DO` blocks, `NOT NULL` adds, is refused as not proven — the check is an allowlist, not a denylist), an independent trusted scope verdict (`scopeVerdict`: source `trusted_independent_scope_reader`, verdict `LOW_RISK_COMPATIBLE`) is bound to repo+base+head+manifest hash (builder JSON/labels never count; paths alone never prove semantic safety), malformed input yields DENY (never an exception), recovery plan and DB-compatible rollback exist, smoke tests and rollback are defined, and no other release is in flight or already done for this SHA. `ALLOW` only means qualified, with a binding hash of repo+base+head+manifest. Tests: `tests/agent-pipeline/auto-release.test.mjs` (fixtures, no remote effects). Nothing calls it yet and no controller flag is changed.

## Activation plan (not executed)
Separate stage, needs owner-provided items that agents must not create:
1. Trusted workflow on the protected `main` revision (not PR code) that reads live rulesets/environments, CI/review check runs and Codex review state via the existing controller App identity, then calls `evaluateAutoRelease`.
2. Serialization: GitHub Actions `concurrency` group plus a release ledger keyed by integration SHA (feeds `lock` / `released`).
3. Executor: the existing `agent-promote` identity merges the `integration -> main` PR only on `ALLOW`; Vercel production deploy happens from `main` as today; smoke without real payments/contacts; failure freezes later releases.
4. Concrete BLOCKERS before activation: (a) P24 hold must be released by the owner in trusted config; (b) the `production-approval` environment currently requires the owner as reviewer, so an unattended release needs an owner-made change to that environment or a new unattended environment — agents may not change it; (c) no DB backup/PITR evidence reader exists yet; (d) the Codex review state reader is not implemented; (e) the independent trusted scope-verdict reader does not exist, so `scopeVerdict` cannot be produced for real yet.
Until (a)–(d) are resolved the status is IMPLEMENTED (qualification + tests), not LIVE.

## Stage 4c (#369): CI evidence reader
`readCiEvidence(sha)` in `auto-release-readers.mjs` is read-only (GET). It accepts only one `sc-agent/ci` check run for the exact SHA created by the pinned `controller_app_id`; partial, duplicate, foreign-app or other-SHA results are refused. Review, Codex, scope-verdict, backup, lock and ledger readers are still missing, so the collector still returns DENY. Status: IMPLEMENTED (offline tests), not LIVE.

## Stage 4d (#369): release lock reader
`readLock()` in `auto-release-readers.mjs` is read-only (GET). It takes one unfiltered snapshot of all runs of the pinned `workflow_ids.promote` workflow (every page, at most 10 × 100, then re-reads page 1 to confirm nothing shifted) and returns `{ held, inflight }`; every run whose status is not `completed` — including unknown statuses — holds the lock; a run seen active in either read (e.g. a completed run that was re-run) counts as active. Per-status queries are not used, because a run changing status between two such queries could appear in none of them. An unpinned workflow id, a truncated, duplicated or shifting listing, or a run of another workflow throws, so the collector records `READ_LOCK_FAILED` and the decision is DENY. It complements, and does not replace, the Actions `concurrency` group of item 2 above. Review, Codex, scope-verdict, backup and released-ledger readers are still missing, so the collector still returns DENY. Status: IMPLEMENTED (offline tests), not LIVE.

## Stage 4j (#369): independent scope-verdict reader
`readScopeVerdict({ base, head, manifest })` in `auto-release-readers.mjs` is read-only (GET). It accepts only one completed/success check run on the exact candidate SHA whose name and issuing App id are pinned in trusted policy (`scope_verdict.check_name`, `scope_verdict.app_id`); the issuer must be a different App than `controller_app_id`, so the pipeline can never certify its own release. The check's `output.text` must be exactly one JSON object `{schema: "sc-scope-verdict/v1", repository, base_sha, head_sha, manifest_hash, verdict}` (no other keys, at most 4 KiB) bound to the repository, `main` SHA, integration SHA and sha256 of the manifest; `verdict` is `LOW_RISK_COMPATIBLE` or `NOT_LOW_RISK`. Anything unpinned, foreign, stale, duplicated, truncated, pending, failing or malformed throws, so the collector records `READ_SCOPE_VERDICT_FAILED` and the decision is DENY. The issuer itself (blocker (e)) still does not exist and is not created here: no new App, permission or secret. Status: IMPLEMENTED (offline tests), not LIVE.

## Stage 4l (#369): a failed release freezes later releases
`readLock()` also returns `freeze`, computed from the same single snapshot of the pinned promote workflow (a missing/invalid or duplicated `run_number` throws → `READ_LOCK_FAILED` → DENY). The freeze starts at the completed run with the highest `run_number` that either concluded anything but exactly `success` (missing/unknown → reported as `'unknown'`), or is a **re-run** (`run_attempt` not exactly `1`, reported as `'rerun'`): the runs listing shows only the latest attempt, so a re-run could otherwise hide a failed attempt behind a DENY no-op. A re-run counts as clean only if it proves clearing itself. `freeze` is `null` only when there is no freeze start, or a **later** completed run proves one of two things from GitHub-origin run data (never PR text):

1. **Release** — its latest-attempt job named `release` concluded `success` and its steps `merge`, `deploy` and `smoke` each concluded `success` (a skipped or missing step is not success);
2. **Explicit, verified unblock** — its job named `unblock` concluded `success` **and** `GET /actions/runs/{id}/approvals` shows an `approved` review of the pinned `production-approval` environment by the pinned owner id (`policy.owner.id`). If the owner id or environment is not pinned, unblock is unavailable and the freeze stays.

A proof run counts only if it ran the pinned workflow file (`policy.workflows.promote`, exact `path`), was a `workflow_dispatch` on `head_branch` `main`, and its `head_sha` is the current `main` or reachable from it (one compare against `main`). A copy of the workflow on another branch or tag cannot fake a `release` or `unblock` job.

A run's own `success` never clears the freeze: a DENY ends as a successful no-op too, so `[failure, success-from-DENY]` stays `RELEASE_FROZEN_AFTER_FAILURE` (Codex finding on `472e189`). The same holds for a failed run re-run into a DENY success. A proof found only before the latest freeze start does not count. The reader walks the runs once, newest first. The first proven release or unblock clears every older failure, and the first failure or unproven re-run met before any proof is the freeze start. With no failure and no re-run in the snapshot, no extra reads are made. Runs that cannot be a proof (wrong `event`, branch or `path`) cost no read. Jobs are read for at most 100 other runs per evaluation. If more than 100 trusted, non-proving runs (for example DENY no-ops) completed since the last clearing run and an older failure is still in the listing, the freeze comes back (fail closed, never a throw) and the owner unblocks again. The newest owner `unblock` is always the first run inspected, so it stays reachable. Because `run_number` is fixed at dispatch, a re-run of an older run can execute after a newer proof. So when a proof is found, every older re-run whose latest attempt did not start strictly before the proof started (by `run_started_at`; an unreadable time counts as after) freezes, unless that re-run proves clearing itself.

Executor contract on `cancelled`: every conclusion other than `success` starts a freeze, `cancelled` included. The executor must therefore not use a `concurrency` setting that cancels queued or running promote runs. A cancelled run freezes the pipeline like any failure, which is deliberate: it is not known what a cancelled release step left behind.

Any unreadable, truncated, foreign or ambiguous jobs/approvals/`main` response throws → `READ_LOCK_FAILED` → DENY. Where the data cannot tell a release from a no-op, the freeze stays (fail closed). `evaluateAutoRelease` returns `RELEASE_FROZEN_AFTER_FAILURE` unless `lock.freeze === null` exactly (a missing field, `undefined` or any object freezes; the old `lastConclusion` field is not honoured).

Known limitation (no state store by design): the freeze is derived from run history, so **deleting** the failed run (`DELETE /actions/runs/{id}`, needs `actions: write`) or losing it to log retention clears it. Who can delete runs is governed by repository access, not by this reader. A ledger that survives this is out of scope for stage 4l.

Contract for the future executor (not built here): it runs as the pinned promote workflow from `main`. A DENY ends the run as `success` without running the `release` job's `merge`/`deploy`/`smoke` steps, and only a failed release step may fail the run. After a freeze, the only ways out are a run whose `release` job proves all three steps, or a deliberate `unblock` job approved by the owner in `production-approval`. A frozen qualifier denies every release, so in practice the owner's verified unblock is the way out. The approvals endpoint is per run, not per job, so in the executor `unblock` must be the only job in its run gated by `production-approval`, and it runs only on its own dispatch input (never together with `release`). While agent sessions act through the owner's GitHub identity (`AGENTS.md` rule 5, variant B), that approval is separated from agents only procedurally, as for every `production-approval` approval. Before go-live: the pinned `agent-promote.yml` today has only the `evidence` job (no `release` or `unblock`). Any failed, cancelled or rejected run in its history will therefore freeze the first live evaluation, and nothing can clear it until those jobs exist in that file, or the pin moves to the executor workflow. No new state store, secret, permission or workflow is added (jobs, approvals, the `main` ref and one compare are read with the same read-only access). Status: IMPLEMENTED (offline tests), not LIVE.
