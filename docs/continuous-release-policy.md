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
