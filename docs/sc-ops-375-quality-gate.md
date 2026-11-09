# SC-OPS-375 — complete CI and history review

TASK: SC-OPS-375 · LEVEL: L3 · SCOPE: OPERATIONS

## Architecture

Extend the existing controller; do not introduce a second scheduler. The trusted
policy, protected review environment, App writer, journal lease and disabled-by-
default LIVE flags remain mandatory. No setting or production change is part of
this patch.

1. Freeze the final binary diff and every commit (including merge-parent diffs)
   into reviewer data. The reviewer must enumerate the reviewed commit SHAs and
   affirm full-diff coverage. The controller independently compares that list
   with GitHub's complete comparison. Missing/truncated history fails closed.
2. Before merge, read branch-required checks, all head checks/statuses, and all
   review threads with pagination. Require finished successful results from the
   configured source; a pending, missing, failed or unresolved item blocks merge.
   Controller-owned evidence checks are verified separately before publication.
3. A new head/base invalidates the existing evidence through the current state
   machine. Only PASS with no required findings is accepted; the existing bounded
   repair loop consumes FAIL/PASS_WITH_FIXES.
4. A confirmed integration merge enters a post-merge waiting state. The queue
   cannot start another task until the exact merge commit's configured push CI
   completes successfully. Failure/timeout blocks the queue for investigation.
5. Promotion uses the same full-history review and additionally requires every
   contributing task's post-merge CI evidence. Production authorization remains
   separate and is not granted by this work.

## Validation

Exercise missing/pending/failing checks, stale review after a commit, incomplete
commit coverage, a reverted transient change, unresolved findings, merge conflict,
post-merge CI failure/timeout, pagination and successful queue continuation.
Tests use synthetic transport and temporary Git repositories, without provider
calls, repository settings, secrets, production or live customer data.

## Activation boundary

The current trusted workflows execute from main, while this task permits only
integration merges. LIVE also requires verified App/environment/branch settings.
Passing local tests is not proof of live dispatch or activation; those conditions
must be independently verified before enabling the existing controller.
