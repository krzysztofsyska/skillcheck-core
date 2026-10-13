# SkillCheck — trusted Git inspection (staged, NOT ACTIVE)
This module strengthens the prepared selective-release workflow for exactly **PR #120**.
Status: **preflight only**. No change to main Agent Gates, no Production authorization.

`tools/agent-pipeline/lib/sales-release-verified.mjs` checks the **actual local Git object graph**, rather than caller-supplied commit descriptions:
- base must match the checkout's `refs/remotes/origin/main`, with one-parent contiguous commit history;
- each intermediate commit and final diff must touch only the five reviewed marketing/test paths with A/M status and normal 100644 blobs;
- the HEAD blobs must match immutable reviewed Git blob IDs from PR #118 at `9b9bcdca376b19a36231161fc6f5aa3632223396`;
- rejects deletions, renames (as A/D), symlinks, submodules, extra files, oversize files and recognizable credential patterns in intermediate blobs;
- always outputs `authorizedForProduction:false`, even when `ok:true`.

A few heuristic patterns cannot prove absence of *all* credentials. For a release, add an independent full-range secret scan and vetted review on exact SHA. The verifier MUST run from a trusted checked-out protected `main` source; running PR-modified code would be insecure.

**Blocking prerequisites before enabling ANY main exception:** protect `main` against unreviewed changes, disable history rewrite and deletion, enforce independent CI/review, configure verifiable separate OWNER ACCEPTANCE and PRODUCTION APPROVAL, inspect actual branch and environment protection via an authorized admin API, and fail closed on inaccessible settings. GitHub access returned 403 for branch protection. Existing two rulesets protect only `agent-feedback-state`, **not main**. Do not merge #120 or publish Production before those prerequisites are proven.

No Vercel settings, Supabase, CV, secrets, mail worker, credits, payments or public website are changed by this preflight.
