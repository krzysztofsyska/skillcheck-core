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
`tools/agent-pipeline/lib/auto-release.mjs` — `evaluateAutoRelease()` is pure and fail-closed. It builds on `preparePromotion` (whole-range manifest, per-task `verified_ci_review` evidence) and `protectionFromRulesets` (effective rulesets/environments). It returns `DENY` with reason codes unless: P24 hold released by trusted config (only literal `false`), manifest covers every commit, every task has verified CI+review, CI/review/Codex are completed on the exact current integration SHA with no open findings, SHA/base unchanged, protection confirmed, scope is not payments / outbound sends / pipeline-secrets, migrations are readable and additive (no drop/truncate/delete/update/grant/policy), recovery plan and DB-compatible rollback exist, smoke tests and rollback are defined, and no other release is in flight or already done for this SHA. `ALLOW` only means qualified, with a binding hash of repo+base+head+manifest. Tests: `tests/agent-pipeline/auto-release.test.mjs` (fixtures, no remote effects). Nothing calls it yet and no controller flag is changed.

## Activation plan (not executed)
Separate stage, needs owner-provided items that agents must not create:
1. Trusted workflow on the protected `main` revision (not PR code) that reads live rulesets/environments, CI/review check runs and Codex review state via the existing controller App identity, then calls `evaluateAutoRelease`.
2. Serialization: GitHub Actions `concurrency` group plus a release ledger keyed by integration SHA (feeds `lock` / `released`).
3. Executor: the existing `agent-promote` identity merges the `integration -> main` PR only on `ALLOW`; Vercel production deploy happens from `main` as today; smoke without real payments/contacts; failure freezes later releases.
4. Concrete BLOCKERS before activation: (a) P24 hold must be released by the owner in trusted config; (b) the `production-approval` environment currently requires the owner as reviewer, so an unattended release needs an owner-made change to that environment or a new unattended environment — agents may not change it; (c) no DB backup/PITR evidence reader exists yet; (d) the Codex review state reader is not implemented.
Until (a)–(d) are resolved the status is IMPLEMENTED (qualification + tests), not LIVE.
