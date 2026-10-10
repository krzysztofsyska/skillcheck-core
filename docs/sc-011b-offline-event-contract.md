# SC-011-B — offline, vendor-agnostic event contract (preparation only)

TASK: SC-011-B | LEVEL: L3 | SCOPE: BACKEND | OWNER: Cursor/ChatGPT | REVIEWER: independent Codex
DEPENDENCIES: merged SC-011-A #75; SC-010-C architecture PR #87; vendor decision not completed.
STATUS: IMPLEMENTATION_PREPARATION / NOT READY FOR REAL PROVIDER | PRODUCTION_APPROVAL: NO.

## Delivered
- Typed strict synthetic provider event envelope with exact fields: account, attempt, provider call, event ID, UTC/offset timestamp and allowed event status.
- Cloned and bounded payload validation; no raw metadata, candidate contact, CV, voice, recording or transcript.
- Deterministic SHA256 receipt hash to distinguish same event identifier with different payloads (the future DB unique constraint enforces replay).
- Pure progression projection: unknown -> signed reconciliation result, accepted -> ringing -> connected -> completed; cancelled/failed/completed terminal; no resurrection or backward transitions. This alone never authorizes an external side effect.
- Deterministic synthetic unit tests and separate GitHub CI.

## NON-FEATURES (hard prohibitions)
No actual signature validation, webhook route, vendor credentials, real API adapter, source read, contact dispatch, stored deduplication, DB migration or production access. Passing this normalizer input does NOT establish authenticity. A future vendor-selected adapter must authenticate raw HTTP bytes and provider account/timestamp, enforce replay protection with persistent receipts and follow vendor-specific signature specification BEFORE calling the normalizer. Tenant/attempt/approval binding, fencing and legal contact permission remain SC-010-C. Never mount this module directly on a public endpoint.

## Next gate
Decide provider (Retell or Vapi based on data protection and capability), review raw signature/idempotency/reconciliation contract, implement adapter with synthetic fixtures, run security review; require production owner approval independently.

BRANCH feat/sc-011b-offline-event-contract | DB NONE | CONTACT NONE | SECRETS NONE | MIGRATION NONE | REQUIRED TESTS node --test tests/voice-provider-event-contract.test.mjs; npm run typecheck; npm run build.
