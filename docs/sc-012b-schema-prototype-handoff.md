# SC-012-B schema prototype — isolated, no migration

TASK: SC-012-B-B1 / DB prototype | LEVEL: L3 | SCOPE: BACKEND
OWNER: ChatGPT builder | REVIEWER: independent Codex
STATUS: REVIEW_PENDING | OWNER_APPROVAL: PENDING | PRODUCTION_APPROVAL: NO

## Scope

This is an **isolated executable SQL PROTOTYPE**, not a Supabase CLI-generated migration. It introduces immutable plan, human-review and release history and one current release pointer per application (logical CAS version), private request-key storage and minimal lineage columns. Source snapshots and envelopes cannot contain phone numbers/CV by contract, but SQL alone does not yet perform a semantic allowlist validation. All five tables are default-deny with FORCE RLS and no exposed API or mutation RPC. No secret, external contact or provider call.

The SQL is intentionally stored under db/prototypes/, not supabase/migrations/. Test harness runs it in isolated PGlite after existing SC-006/008/010 schema setup; no live Supabase connection. Passing the prototype tests only demonstrates schema shape and security defaults, NOT a complete implementation.

## Hard blockers for an accepted migration and RPC

1. Independent PASS on SC-012-B architecture PR #82 and offline data contract PR #84, followed by owner integration acceptance.
2. Generate timestamp and base SQL with `supabase migration new` from a verified CLI; do NOT rename this prototype and assume it is a migration.
3. SQL correctness: verify exact tenant composite FK, source review and shortlist lineage, template catalog and immutable source provenance, app-scoped permission lock order, last approved review, current release CAS, idempotency, retention/purge.
4. Implement authenticated server action + DB RPC so no browser-provided reviewed/current booleans or source lists grant authority; re-read source under locks, compare canonical template content and reject stale data. PostgREST uses READ COMMITTED + row/advisory locking; no imaginary SERIALIZABLE upgrade from PL/pgSQL.
5. Real two-session PostgreSQL tests for actor revocation, source mutation, two plans/reviews/releases and idempotency; safe 409 on conflict.
6. An isolated developer DB is not currently available in the connected Supabase project. Never apply draft SQL to the production project `wsvjawuikxfzjyivxgsu` or run blanket db push.

No RLS grants, end-user UI route, provider API or contact dispatch are delivered by this prototype.

## Confirmed real PostgreSQL 16 race prototype — October 10, 2026

- `tests/voice-plan-schema-concurrency.test.mjs` uses two independent `pg` connections to a throwaway database created and dropped inside GitHub Actions, including existing SC-006/008/010 migration history.
- Two sessions cannot concurrently lock the same current-release pointer using `FOR UPDATE NOWAIT`; loser receives SQLSTATE 55P03, and subsequent stale-version CAS changes zero rows. Mapping zero rows to PT409 is still future trusted RPC work.
- Append-only trigger protects plan, human-review, and release history against UPDATE/DELETE, including privileged test sessions. Future legally authorized retention/deletion requires separate narrow owner-approved protocol.
- Composite parent keys reject foreign-tenant bindings. This prototype does NOT yet validate all same-tenant source provenance in one transactional RPC, nor hold actual authorization locks in a production workflow.
- CI `SC012B isolated schema prototype` runs both PGlite security tests and PostgreSQL 16 two-session tests, without a paid Supabase branch or remote data mutation.

STATUS: module real-PG test PASS on head 9fe406809ea28f06143b3baa46c846b9e38d6464; full Checks and fresh independent review are separate gates. This remains a prototype (NOT `supabase/migrations`), with no production approval.
