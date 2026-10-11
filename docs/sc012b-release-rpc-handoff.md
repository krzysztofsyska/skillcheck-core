# SC-012-B — isolated release RPC (preproduction candidate)

TASK: SC-012-B | SCOPE: OPERATIONS | LEVEL: L3
OWNER: SkillCheck | REVIEWER: independent Codex
STATUS: REVIEW_PENDING | OWNER_APPROVAL: PENDING | PRODUCTION_APPROVAL: NO

This separate implementation branch contains a candidate `private.sc012b_release_plan` function. It is installed **only in disposable PostgreSQL 16 CI databases**, not via Supabase migration. The function uses auth.uid(), company owner/recruiter membership locks, latest human approval, active screening review and shortlist locks, application-scoped pointer CAS, per-actor request-key serialization and idempotent replay. No anon/authenticated EXECUTE grant, UI route or vendor call.

**Blocking limitation:** the function currently validates stored source hash and current screening review, but **does not reconstruct the full canonical source fingerprint from live application/recruitment/position/template catalog**. It therefore must not be granted to clients, merged as production runtime or deployed. Exact lock order versus SC-006/008/010 and concurrent membership revocation require independent review and two-session tests. The test-only envelope is synthetic and not a trusted approved template.

Testing: real PostgreSQL 16, fixture from SC-006/008/010, deny unreviewed/stale/cross-tenant, one release per plan, CAS, idempotent replay, immutable history and deny client EXECUTE. Review findings are required before any merge.

CHANGED FILES: db/isolated/sc012b-release-rpc.sql, tests/voice-plan-release-rpc.test.mjs, .github/workflows/sc012b-release-rpc-isolated.yml, docs/sc012b-release-rpc-handoff.md
DB/MIGRATIONS: NONE (isolated ephemeral only)
SECURITY CHECKS: pending Codex
KNOWN ISSUES: canonical source/template validation, source mutation lock graph, permission revocation concurrency, retention/purge
BLOCKERS: independent PASS, owner acceptance and full trusted-source contract
NEXT ACTION: fix CI, review findings and add trusted source catalog validation.
