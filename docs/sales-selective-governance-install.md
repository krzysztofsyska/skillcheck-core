# SkillCheck — installation gate for exactly PR #120 (governance seed)

**Status: DRAFT / BLOCKED. Main branch protection is installed; the selective-release workflow and approval enforcement are not ready for activation. This document is a gated runbook, not permission to merge or deploy. PR #128 is NOT the marketing release.**

## Verified administrative checkpoint — 2026-10-17

The owner created `main-production-protection`, ruleset **25301984**, at 14:15:40 Europe/Warsaw. A subsequent GitHub API read confirmed `active`, literal `refs/heads/main`, no exclusions, explicitly empty `bypass_actors`, deletion/force-push protection, PR requirement, one approval, stale-review dismissal, latest-push approval and conversation resolution. Both required contexts (`verify`, `Agent contract / scope gate`) are strict and pinned to GitHub Actions App **15368**. The branch API now reports **protected:true**; main still points to `76760b7ffb7e95231fc7af313cc67bc8d36fefe1`.

This supersedes the earlier `protected:false` observation. It is an operator-session observation, NOT reusable authorization evidence for the workflow's different read-only token. No production commit or workflow installation occurred.

## Gated installation and release sequence

1. Preserve the installed main protection and the separate integration ruleset. Do not add bypass actors, remove required checks or reduce approvals to obtain a green merge.
2. Finish the existing seven-file governance PR **#128** from original main `76760b7ffb7e95231fc7af313cc67bc8d36fefe1`. Its bootstrap classifier exception is tied to this exact base and expires after main advances. Every security boundary requires L3 review, including later ordinary edits to the new workflow. Obtain independent final-SHA review, required CI, owner acceptance and an explicit governance rollout decision before installation on main.
3. Before installation, implement and verify publication of `Sales selective scope verified` on the actual candidate SHA, not merely the default-branch job SHA. Keep trusted-main execution, no candidate checkout/import, and no application credentials. The current job is read-only and still lacks a candidate-bound status publisher. Do not add this required context until its producer and installation sequence are verified.
4. Supply authoritative, current protection evidence that the workflow can actually read. Missing `bypass_actors` remains a hard rejection. Do not grant Administration:write to this workflow, substitute an owner PAT, or treat a screenshot/timestamp snapshot as live evidence. This architecture and its credential boundary require independent review.
5. Enforce GitHub-origin OWNER ACCEPTANCE and PRODUCTION APPROVAL as actual prerequisites for the exact current candidate HEAD/base. Verify required environment reviewers and branch restrictions. `authorizedForProduction:false`, prose, reactions and a plain scope result do not implement this requirement. Confirm a qualifying independent formal reviewer; the observed Codex reviews are COMMENTED, not APPROVED.
6. After approved governance installation, rebuild/revalidate **PR #120** against the new main using only the five immutable reviewed marketing/test blobs from PR #118. All added/modified historical blobs must match the manifest. Do not import full integration, force-push shared history or rewrite the branch without the required authorization. Re-run CI, exact-SHA independent review and candidate-bound gates after any HEAD/base change.
7. Only after these prerequisites and owner Production Approval may the exact release be merged. Confirm the expected Vercel version, `/preselekcja`, both inquiry links, and the absence of checkout or automatic entitlements. Follow the approved rollback procedure on failed smoke. No production DB migration, real AI/voice, payment or secret operation is part of this five-file release.

**PR #120 is a mailto inquiry page, not self-service FREE/PRESELEKCJA activation or a payment launch.** PR #129 and its actual persistence/provider/UI adapters remain a separate launch track.

## Code repair checkpoints

The first batch addressed strict status policy, App pinning, wildcard exclusions, missing bypass evidence, latest-push approval and historical blob pinning. Its 37-test suite passes locally; independent final acceptance was not claimed.

The next bounded batch addresses three findings from Codex review **5557428211** against `2e8b6739f02496b19317e320d8a8dc302c06f6e4`:

- `discussion_r4302382326`: ordinary modifications of `.github/workflows/sales-selective-scope.yml` now classify as operations/security and require L3, including mixed frontend changes.
- `discussion_r4302382334`: only a literal `refs/heads/main` include supplies main evidence; `~DEFAULT_BRANCH` alone cannot stand in for main.
- `discussion_r4302382343`: the existing read-only token authenticates the fixed release fetch through command-scoped Git environment configuration. The token is absent from argv and on-disk config; credential helpers and redirects are disabled, inherited trace configuration is removed and Git error output is not reflected. Checkout still uses `persist-credentials:false`.

Validation on Node **22.16.0**: fetched baseline **37/37 PASS**; new regressions against the unpatched source **38 PASS / 10 FAIL**; patched suite **48/48 PASS**, zero skips. Git's real configuration parser also confirms the synthetic authentication header matches the fixed repository URL and not an unrelated repository. JavaScript syntax and YAML structure checks pass. Source files reconstructed locally were first verified byte-for-byte against the fetched Git blob hashes.

These are deterministic local tests, primarily with GitHub/Git doubles, NOT a live private-repository fetch, a protected-environment test or customer E2E. GitHub CI and independent review must be checked separately on the final commit. The branch update must be one atomic fast-forward with an expected-HEAD lease, retaining the existing seven-file PR scope.

## Remaining P1 findings — do not resolve by configuration shortcuts

- `discussion_r4302382315`: candidate-SHA scope publication.
- `discussion_r4302382323`: live authoritative bypass evidence accessible to the workflow.
- `discussion_r4292657545`: both owner approval gates as actual HEAD/base merge prerequisites.

No merge, production rollout, approval publication, credential escalation or automatic-agent activation is authorized by this checkpoint. The three new code fixes also require independent re-review before their threads are resolved.

References: https://docs.github.com/en/rest/repos/rules ; https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows ; https://git-scm.com/docs/git-config .
