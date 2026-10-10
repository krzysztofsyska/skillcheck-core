# SC-012-A — deterministyczny scenariusz rozmowy (offline)

TASK: SC-012-A | LEVEL: L3 | SCOPE: BACKEND | OWNER: ChatGPT / orchestrator | REVIEWER: independent reviewer pending.
DEPENDS ON: approved screening SC-006/008, the existing lib/behavior-guide.ts, SC-010 B1/B2 foundations.
STATUS: implementation branch; no acceptance/integration/production approval.

Files: lib/voice/interview-plan.ts and tests/voice-interview-plan.test.mjs.

Pure domain implementation, no HTTP, phone, Vapi, billing, model calls, database writes, migrations or contact details. Builds 4 common questions from the established 8 behavioral areas, prioritizing explicit required competency levels (Critical, High, Standard, Low) with the existing guide order as tiebreaker. Adds 0–2 controlled clarification questions selected by approved, current screening criterion IDs and reason enum; does not interpolate raw CV, model output, employer notes or prompt instructions into questions.

- Strictly requires the 8 unique valid competency level requirements. Missing/duplicate/unknown levels are BLOCKED; do not invent requirements.
- The source must be marked reviewed/current, but these booleans and input IDs are NOT proof: future server/RPC integration MUST revalidate every source and authenticated operator under tenant RLS and source locks. Do not expose this pure builder to client inputs as an authorization mechanism.
- Generated -> Reviewed -> Released is an immutable **in-memory domain transition** requiring expected revision, unchanged source fingerprint and human actor ID. It is neither a persisted record nor an approval to contact a candidate. Human review UI, versioned Postgres tables/RPC and last-moment stale checks remain SC-012-A continuation tasks.
- 420s target, 600s cap, recording false, notice required. Question budgets leave time for disclosure and closing.
- Candidate/job identifiers stay inside the fingerprint, never the question content. The provider adapter may only receive an allowlisted minimal scenario, not the full internal plan.
- No AI scoring, emotion inference, hire/reject decisions or recorded voice.

Tests to execute on full repo: node --test tests/voice-interview-plan.test.mjs; npm run typecheck; npm run build. No changes to main or production.
BLOCKERS TO FULL SC-012-A: persistence, authenticated human review/release, tenant-safe API/RLS, integration of real review snapshot and fresh screening source. NEXT: independent review, then bounded persistence/API task after schema approval.
