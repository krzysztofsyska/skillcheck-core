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
