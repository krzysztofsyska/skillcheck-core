# SC-012-B B2 — panel rekrutera (safe preview)

TASK: SC-012-B/B2; LEVEL: L3; SCOPE: FRONTEND + pure presentation state.
STATUS: IMPLEMENTED_PRESENTATIONAL_ONLY, NOT CONNECTED TO LIVE DB.
DEPENDS ON: SC-012-A merged and SC-012-B B1 persistence/RPC not yet ready (#80, PR #82).

Components:
- `components/voice/VoicePlanApprovalPanel.tsx` — displays four common and up to two clarification questions, the exact criterion IDs, source freshness and history metadata, review/release controls.
- `lib/voice/plan-panel-state.ts` — read-only gating; actions off for viewer/stale/unavailable backend and release only when reviewed+approved.
- Tests in `tests/voice-plan-panel-state.test.mjs`.

**NO BACKEND WRITES**: `backendReady` defaults to false and optional callbacks are absent until a separately reviewed, authenticated tenant-safe RPC layer exists. Even if the UI is manipulated in a browser, all future writes must be authorized independently in database. This is not a finished feature or production preview. No route is added, no misleading status is persisted, no telephone calls, no recording, no external AI charges.

Next integration: after SQL/RPC review, create a server component route scoped by recruitment/application IDs, derive role and status through Supabase RLS from authenticated session, attach secure server actions using compare-and-swap version, then test multi-tenant UI and stale errors on Preview. No model-generated text is directly rendered as HTML.

TESTS: node --test tests/voice-plan-panel-state.test.mjs, full typecheck/build on GitHub Actions, a11y and E2E after route integration.

DB/MIGRATIONS: NONE. MAIN/PRODUCTION: NONE. NEXT: independent Codex review; link to B1 backend RPC only once implemented and verified.
