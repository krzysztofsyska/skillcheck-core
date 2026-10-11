# SC-012-B — trusted source reconstruction (read-only)

TASK: SC-012-B | SCOPE: OPERATIONS | LEVEL: L3
OWNER: SkillCheck / ChatGPT builder | REVIEWER: independent Codex
STATUS: REVIEW_PENDING | OWNER_APPROVAL: PENDING | PRODUCTION_APPROVAL: NO

## Implementation

`reconstructTrustedVoiceSource` reads tenant-scoped application, recruitment, position, completed current screening analysis, latest human review, active human shortlist, complete approved criteria and criterion results, and review overrides. It uses a PostgreSQL transaction, application advisory lock and row-level `FOR SHARE NOWAIT` locks. Tenant actor is derived from `auth.uid()`, not a browser-supplied role or company. Only owner/recruiter may access the trusted source.

The function re-derives interview questions through the pinned, deterministic `skillcheck-voice-plan-v1` generator, then calculates the canonical source and question hashes using the offline SC-012-B contract. It does not use CV text, phone numbers, arbitrary provider responses or browser-provided source assertions. The `verifyStoredVoicePlan` preflight rejects mismatched stored hash/envelope or unknown template version.

## Explicit remaining gates

- This is **read-only verification**, not an authorized release or write. The caller must use one dedicated PostgreSQL connection; production integration must perform source reconstruction **inside the same transaction as the write RPC**, not preflight followed by an unprotected write.
- Template version is pinned in the deployed code, not yet an immutable database template-catalog row. Add an independently versioned, immutable catalog and verify its canonical digest before production use. A change to the generator requires a new template version.
- Complete source freshness against candidate document versions, `private.screening_material`, screening contract version and all SC-006/008/010 writers must be proven with a reviewed global lock order. Source hash alone is insufficient.
- The stored plan and its live source are now verified inside the same read transaction. This still does NOT authorize a subsequent write; production mutation must repeat all checks in its own transaction.
- No migration, no grants to client roles, no browser endpoint, no Production, no provider calls.

## Acceptance

Isolated PostgreSQL 16 test: canonical plan reconstruction from real SC-006/008 screening fixture, matching saved envelope, denial to other-tenant actor, rejection of forged review IDs and position mutation. Additional concurrency, retention and template-catalog tests required before promotion.

CHANGED FILES: lib/voice/trusted-source-verifier.ts; tests/voice-trusted-source-verifier.test.mjs; .github/workflows/sc012b-trusted-source.yml; docs/sc012b-trusted-source-handoff.md
DB/MIGRATIONS: NONE | SECURITY REVIEW: PENDING | NEXT ACTION: CI fixes, independent review, immutable template catalog, same-transaction integration with #96/#97.

## Code-side template registry

The v1 template manifest is pinned under `lib/voice/template-registry.ts` and has a deterministic digest of the approved behavior question catalog and safety defaults. Unknown versions are rejected. This is a code-side versioned registry, **not** yet a database immutable template catalog; production migration and review must pin a released digest independently. CI tests check the registry and reject unknown versions.
