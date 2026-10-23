# SC-011-A — kontrakt dostawcy Voice AI (offline)

TASK: SC-011-A | LEVEL: L3 | SCOPE: BACKEND | OWNER: ChatGPT / orchestrator | REVIEWER: independent reviewer pending.
DEPENDS ON: SC-010 B1/B2 in integration. SC-010-C live dispatch is **not implemented**.
STATUS: implementation branch, no owner acceptance for integration or production.

Files: lib/voice/provider.ts, lib/voice/fake-provider.ts, tests/voice-provider.test.mjs.

The provider interface defines typed request, acceptance, cancellation and optional idempotency-key reconciliation. The FakeVoiceProvider is memory-only and has no network, telephone, recording, storage, credentials, callbacks or external events. It validates a synthetic E.164 number but stores only an opaque call ID, state and SHA-256 request fingerprint. Never mount this fake as a production call path.

- Unknown results after acceptance never imply permission for automatic retries.
- An unsupported lookup must result in manual reconciliation in a future worker.
- A cancelled idempotency key cannot be reused to create another attempt.
- Recording is an explicit bool; future integration must separately validate recording permission.
- No transport operation proves or grants consent. A production caller must first get a one-time authorization from an SC-010-C trusted worker and control cost, timing, identity and freshness under lock.
- The real Vapi adapter, webhook validation, reconciliation through an external API, EU data/residency approvals and provider account configuration are intentionally not included.

Tests to execute on full repo: node --test tests/voice-provider.test.mjs; npm run typecheck; npm run build. Review/CI results must be attached to PR before owner acceptance.
DB/MIGRATIONS: none. EXTERNAL CALLS: none. PRODUCTION_APPROVAL: no. NEXT: independent review then SC-011-B provider adapter/security design.
