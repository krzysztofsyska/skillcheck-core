# SC-012-B — Atomic trusted source + review/release (isolated integration)

TASK: SC-012-B
SCOPE: BACKEND
LEVEL: L3
OWNER: SkillCheck / ChatGPT builder
REVIEWER: independent Codex
STATUS: REVIEW_PENDING
PRODUCTION_APPROVAL: NO
MERGE_APPROVAL: NO

## What was implemented

A trusted-server-only Node orchestration module opens **one PostgreSQL transaction** on one dedicated database session. It reconstructs the current source and checks the immutable template catalog, company membership, current approved screening review, shortlist, generated questions, source fingerprint, and stored envelope digest. It retains application/screening and row locks while calling the isolated private SQL review or release function. On success it commits both verification and history/pointer update; on any error it rolls back.

- Review SQL copied from PR #96; release SQL copied from PR #97. Their source branches remain unmerged.
- The verifier comes from PR #98 plus the independent Codex P1/P2 fixes: SC-006 screening advisory lock and stored envelope digest.
- Dedicated real PostgreSQL 16 CI test with synthetic source, approved review, release, idempotency, source mutation denial and cross-tenant denial.
- No browser, Supabase/Vercel Production, provider, phone or migration changes.

## Security limits — no promotion

This is **not a production API**. The private functions remain ungranted to anon/authenticated, and no service role is placed in the browser. The orchestration requires a trusted backend connection. Full source freshness must still be validated against SC-006 screening material, candidate document version, and contract revisions. SC-006/008/010 lock graph and concurrent source mutations require further real-PG tests. The template catalog is an isolated test schema, not a Supabase CLI migration. Retention, purge and grants need independent review. No merge before exact-head green CI and Codex PASS.

## Next gates

1. Green CI for source+RPC same-transaction tests, resolve independent review findings.
2. Add two-session concurrent reanalysis, revocation and pointer CAS tests with the actual orchestrator.
3. Review and align full trusted source/material and template digests.
4. Generate a separate Supabase CLI migration on isolated development DB after owner approval.
5. Only then wire server actions and recruiter panel; never call private SQL directly from browser.
