# Preview payment test freeze

This change is a local preparation until reviewed and merged into integration.
It does not itself freeze a running environment. The minimal policy lives in
`config/preview-freeze.json`; deployment URLs, database fingerprints and payment
evidence belong in a local operator record outside the repository.

## Controls

- Automatic Git deployments from integration are disabled in `vercel.json`.
  Existing main and release deployment rules remain unchanged.
- Preview migration/seed and AI smoke workflows first check out
  `refs/heads/integration`, irrespective of the triggering branch. This trusted
  checkout supplies both the guard and the policy. No environment or application
  secrets are available to that job. An active hold skips the entire job that
  uses `preview-db`; missing/invalid policy or checkout failure denies access.
- Product branches and merges can continue. Weryfikacja/Assessment Center tests
  use local or ephemeral CI databases while shared Preview writes are held.
  They must not manually deploy to the frozen Preview or run shared DB workers.

## Activation and verification

1. Record the existing READY immutable deployment and its commit, current DB
   migration fingerprint, payment status counts and callback configuration in a
   local operator record. Use the immutable deployment for new payment tests.
2. Inspect running/queued Vercel builds and both Preview workflows. Let existing
   approved work finish before activating. A started job is not stopped by this
   patch. Check again after the activation merge.
3. Merge the guard, active policy and Vercel rule together into integration.
   Verify that the merge does not produce a new integration Git deployment and
   that migration/seed work is skipped after a successful held preflight.
4. Inspect branch tips before any `preview-db/**` or `preview-ai/**` push: they
   must include these guarded workflows. Never rerun historical unguarded runs.
   Old workflow revisions cannot be retroactively protected by this patch.
5. Confirm the alias still resolves to the recorded deployment and the shared
   schema fingerprint has not changed. Only then call the freeze active.

The guard is an operational interlock for these workflows, not a permission
boundary against a person able to change workflows or integration policy.
There is also a check/use window between preflight and a privileged job: drain
in-flight jobs before starting a new hold. It does not block direct database
access, manual deployments, or other external writers. Maintain the agreed hold
on those operations throughout payment testing.

Vercel documents `git.deploymentEnabled` as controlling deployment triggers on
Git commits, not as a runtime change requiring a successful new deployment.
It does not cancel existing builds or prevent CLI/manual deployments. Verify
the first activation push rather than claiming this local patch is already
effective: https://vercel.com/docs/project-configuration/git-configuration

## Release

After payment testing and an explicit reviewed release decision, check the
queued migration/seed changes against the frozen DB state. In the release change
set `enabled` to false and restore `git.deploymentEnabled.integration` to true;
update the policy contract test intentionally. Do not expire a hold by date or
override it from a task branch. Keep the production release process unchanged.

## Local checks

`node --test tests/preview-freeze.test.mjs tests/vercel-deployment-policy.test.mjs tests/cv-bulk-workflows.test.mjs`

The existing native PostgreSQL CI workflow test imports the freeze tests, so
the guard contract is also checked by the existing required migration checks.
