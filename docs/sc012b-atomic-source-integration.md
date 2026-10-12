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

## October 11 — security review remediation and migration gate

The independent Codex review on PR #99 flagged three P2 issues. This branch now:

1. Maps verifier `55P03`, `40P01` and `40001` to a stable `PT409` after transaction rollback.
2. Includes prototype schema and screening fixture dependencies in atomic CI path triggers.
3. Resolves committed release and review idempotency keys under application, actor membership and request-key locks **before** revalidating mutable source, while requiring the exact same canonical request payload and the stored review or release row. New keys still undergo the complete trusted-source verifier and pointer CAS. The isolated review and release SQL now also check a committed request before rejecting a superseded or stale plan. A different tenant actor receives `42501` / `VOICE_PLAN_FORBIDDEN` and cannot recover the id.

Real PostgreSQL two-session tests additionally cover an in-flight position update, screening reanalysis advisory lock contention, and recovery of a previously committed release after source revision. They must pass on the exact current commit before review acceptance.

### Supabase CLI migration gate

Do not copy the prototype SQL directly into `supabase/migrations`. Before creating the migration, resolve all fresh review findings, prove end-to-end source freshness for candidate documents and screening materials, verify complete lock order with SC-006/008/010, confirm retention/deletion strategy and establish an isolated Supabase development database. Generate the migration name with `supabase migration new` on a verified CLI version, then apply and test only against that isolated database. No Production access, credentials, grants or deployments are authorized by this branch.

## 2026-10-12 — current safety gate

The source verifier now calls the existing `private.screening_material(application_id, true)` under the SC-006 screening advisory lock, the SC-012-B application lock, source row locks and an explicit `FOR UPDATE NOWAIT` candidate-parent lock. It compares the **current** SC-006 canonical input fingerprint, document ID/version, criteria and binding snapshot with the approved screening analysis. The caller never receives CV text from the verification query. This closes the earlier gap where a new CV revision could remain invisible to the stored voice source hash.

The versioned template manifest now pins all question-defining fields, including priority and tie-break, question count/order, IDs, kinds, text, follow-ups and per-question duration. A change to the generator under the same v1 identifier must fail the verifier.

The isolated PostgreSQL 16 suite includes:
- two sessions competing to create the first release pointer; one committed history entry, one `PT409`;
- reviewer membership revocation racing with a held review transaction, including the revocation-wins case;
- candidate parent lock verification, modified CV rejection and source reanalysis lock contention;
- idempotent replay after a committed release is superseded.

**Remaining gates:** exact-current-head green CI and independent security review, additional tests of candidate document INSERT versus parent lock and source/recruitment mutation lock order, retention/purge integration, plus a reviewed SQL authorization model. No isolated SkillCheck Supabase branch is currently connected (the connected production project has no branches), so a Supabase CLI migration must not be applied to Production or to unrelated projects. A migration filename must be generated using the verified CLI, not guessed or created by renaming this prototype. The project remains non-production and the PR remains unmerged.
