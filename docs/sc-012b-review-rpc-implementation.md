# SC-012-B — first isolated database review RPC

TASK: SC-012-B | SCOPE: BACKEND | LEVEL: L3
BRANCH: feat/sc-012b-trusted-db-rpc
STATUS: IMPLEMENTATION_REVIEW | PRODUCTION_APPROVAL: NO | MERGE_APPROVAL: NO

## Delivered
- A concrete PostgreSQL function `private.sc012b_review_plan` that writes immutable human review history.
- Authenticated actor derived from `auth.uid()`, tenant derived from the immutable plan; no caller-supplied actor or tenant IDs.
- Per-application transaction advisory lock, source hash and expected review version CAS, latest screening/shortlist validation, release guard and reason validation.
- Database-computed request payload hash; successful same-key replay returns original result, changed request with same key fails PT409.
- The function is in a private schema with EXECUTE revoked from PUBLIC, anon and authenticated. No browser route or service-role credential is added.
- Synthetic PostgreSQL 16 integration tests with SC-006/008/010 fixture and negative cases.

## Security limitations and blockers

This is **not yet a production-approved trusted RPC**. Its `SECURITY DEFINER` body is intentionally not executable by client roles. The complete lock graph against SC-006/008/010 writers and membership revocation has not been independently reviewed, and the source hash is not recomputed from a trusted versioned template catalog. A server-side capability with narrowly scoped grants and audited actor membership locks is still required. In particular, a previously authorized actor losing access during a concurrent operation must be covered by real PostgreSQL two-session tests. Review/read and release actions are not connected to the UI.

The function is located under `db/isolated/`, not `supabase/migrations/`. It must only be executed against disposable PostgreSQL test databases. No changes to Supabase Production, Vercel Production, real candidates, Retell/Vapi or external API.

## Next implementation sequence
1. Green isolated CI and independent security review of this exact head.
2. Implement trusted generation and template validation plus exact SC-006/008/010 lock order.
3. Implement restricted release RPC and application-scoped pointer CAS, with source refresh and rejected-plan lineage gates.
4. Run concurrency, revocation, idempotency, RLS and retention tests.
5. Only after acceptance, create a migration with Supabase CLI in an isolated development database, review it and connect the panel.

CHANGED FILES: db/isolated/sc012b-review-rpc.sql; tests/voice-plan-review-rpc.test.mjs; .github/workflows/sc012b-review-rpc-isolated.yml; docs/sc-012b-review-rpc-implementation.md
DB/MIGRATIONS: disposable PostgreSQL only; no migration
TESTS: PostgreSQL 16 synthetic review CAS / replay / tenant denial
SECURITY CHECKS: pending independent PASS
BLOCKERS: membership locks, template/source validation, release RPC, retention and reviewed grants
NEXT ACTION: correct CI findings, independent review, no premature integration merge

## October 11 — Codex review remediation (unmerged)

The independent review of commit `c9a1d2284e` raised P1 findings for stale screening reviews, unlocked actor revocation, unlocked shortlist removal, stale plan versions, terminal `requires_changes`, and missing trusted source/template reconstruction. It also raised P2 for cross-application request keys, whitespace-only rationale and NULL decisions.

Implemented on this branch:
- owner or recruiter membership `FOR SHARE NOWAIT` row lock after the application advisory lock; second membership authorization check;
- analysis `FOR SHARE NOWAIT` and shortlist `FOR SHARE NOWAIT` locks with exact latest screening review version check;
- refusal to review a superseded plan and refusal to append to a plan with terminal `requires_changes`;
- additional request-key advisory lock scoped to company+actor+operation+UUID, preventing cross-application duplicate-key races;
- explicit NULL decision guard and whitespace-only rationale rejection;
- isolated PostgreSQL regression tests for terminal decisions, stale screening review, removed shortlist, superseded plan and malformed inputs.

**Still blocked:** the stored source hash is not recomputed from the *entire current* trusted source and versioned template catalog. Therefore the function MUST remain ungranted to browser/client roles and unpromoted to a production migration. Further two-session revocation/source-change tests and complete lock graph proof are required. These changes must pass current-head CI and fresh independent Codex review; no merge authorization is implied.

## October 14 — remaining Codex findings on `8698f67`

Skipped as already implemented on this branch before this pass: latest screening review, actor membership lock, shortlist lock, cross-application request-key serialization, terminal `requires_changes`, NULL decision, ASCII whitespace, and latest-plan rejection under read committed. The trusted source/template reconstruction P1 stays blocked; no template catalog exists in this isolated candidate and no EXECUTE grant is added.

Implemented in this pass:
- idempotent replay after actor revalidation and before mutable freshness, release, shortlist and screening gates;
- `lock_not_available` from `FOR SHARE NOWAIT` translated to `PT409` / `VOICE_PLAN_SOURCE_BUSY` with no in-transaction retry;
- explicit Unicode space normalization (including U+00A0 and U+202F) before the human-readable reason check;
- `private.erasure_lock_candidate` after the company lock and before a new review write, so a frozen candidate cannot append history;
- rejection of repeatable read and serializable callers with `VOICE_PLAN_REQUIRES_READ_COMMITTED`;
- removal of the unrelated Vercel deployment policy commit. That policy already belongs to merged PR #110 on `integration`.

The existing `private.sc012b_review_plan` is a test-only candidate in `db/isolated`; not a production RPC. No Supabase Production change, no real candidates, no outbound calls.
