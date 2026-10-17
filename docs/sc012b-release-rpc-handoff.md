# SC-012-B — isolated release RPC (preproduction candidate)

TASK: SC-012-B | SCOPE: OPERATIONS | LEVEL: L3
OWNER: SkillCheck | REVIEWER: independent Codex
STATUS: REVIEW_PENDING | OWNER_APPROVAL: PENDING | PRODUCTION_APPROVAL: NO

This separate implementation branch contains a candidate `private.sc012b_release_plan` function and a consumption gate `private.sc012b_effective_release`. Both are installed **only in disposable PostgreSQL 16 CI databases**, not via Supabase migration. No anon/authenticated EXECUTE grant, UI route, provider call, or candidate contact.

The release function reauthorizes owner/recruiter membership under `FOR SHARE NOWAIT`, replays a completed request key before mutable freshness checks, recomputes a non-PII canonical source from locked application, recruitment, position, CV document version, screening review and shortlist rows, and requires an enabled, non-withdrawn row in `private.voice_plan_template_catalog` whose contract hash equals the plan envelope hash. Expired plan or review retention is rejected before history or pointer writes. Replacement releases store `release_version = expected pointer + 1`. The pointer row is not treated as freshness: `sc012b_effective_release` recomputes the same source and fails closed when screening is stale, the shortlist is gone, the template is withdrawn, retention has expired, or a newer voice review is no longer the approved release review.

**Still blocking promotion:** this is not a Supabase migration, the catalog is not a production template install, and client EXECUTE stays revoked. FREE, PRESELEKCJA and SC-005 are unchanged. PR #126 is out of scope.

CHANGED FILES: db/isolated/sc012b-release-rpc.sql, tests/voice-plan-release-rpc.test.mjs, .github/workflows/sc012b-release-rpc-isolated.yml, docs/sc012b-release-rpc-handoff.md, vercel.json
DB/MIGRATIONS: NONE (isolated ephemeral only). `vercel.json` is the selective deployment policy from PR #110 (deploy only `integration`, `main`, and `release/**`). It matches the policy already recorded for that PR and is an operational file, not part of the release RPC contract. It can conflict with any other open PR that edits the same policy.
SECURITY CHECKS: default deny grants; tenant and actor membership; recruiter revocation before the lock and behind an in-flight release; canonical source recomputed without CV text or contact fields; template withdrawal independent of `stale_at`; pointer consumption rechecks freshness; no service_role; no provider call.
KNOWN ISSUES: full production template catalog and audited cross-module lock graph still require an independent PASS before any grant or migration. The isolated catalog proves the gate; it does not install production question text.
BLOCKERS: independent PASS, owner acceptance, and a reviewed production migration. No client EXECUTE.
NEXT ACTION: independent Codex review of the exact new HEAD. No merge and no production deploy.

## Codex finding map

| Finding | Disposition |
| --- | --- |
| P1 recompute canonical source and enabled template catalog | Fixed in `sc012b_recompute_release_source`; withdrawal fails while `stale_at` is null |
| P1 invalidate a stale pointer at consumption | Fixed by `sc012b_effective_release`; the pointer row remains for audit and is not a usable release |
| P2 replay completed requests before mutable freshness | Fixed; same key returns the committed release after the source is marked stale or the plan is superseded |
| P2 first-pointer CAS race | Fixed; two sessions race an unreleased plan and exactly one pointer commits |
| P2 concurrent recruiter revocation | Fixed; demotion denies, in-flight revocation gets `NOWAIT` conflict, and a held release blocks deletion until commit |
| P2 release_version increments on replacement | Fixed and covered by a real successor release |
| P2 reject expired retention | Fixed for plan and latest review deadlines before insert |
| P2 declare vercel.json / PR #110 | Fixed in this handoff |
