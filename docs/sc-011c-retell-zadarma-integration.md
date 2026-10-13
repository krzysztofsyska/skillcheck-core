# SkillCheck SC-011-C — Retell + Zadarma, wersja przygotowawcza

TASK: SC-011-C
SCOPE: BACKEND
LEVEL: L3
OWNER: ChatGPT / orchestrator
REVIEWER: independent Codex PENDING
DEPENDS_ON: SC-011-A, PR #116 (read-only connection), SC-010-C trusted dialing worker, SC-012 reviewed plan and persistence
STATUS: OFFLINE ONLY — DRAFT, NOT DEPLOYED
PRODUCTION_APPROVAL: NO
EXTERNAL_CALLS: NO
BILLING: NO
DB/MIGRATIONS: NONE

## What has been implemented

`lib/voice/retell-outbound-draft.ts` is a **pure compiler**, not a call
provider. Given a validated SC-011-A request and an explicitly pinned Retell
agent + version + verified originating number, it emits an allowlisted draft for
`POST https://api.retellai.com/v2/create-phone-call`. No network, credentials,
SIP configuration or real phone calls. The draft uses
`retell_llm_dynamic_variables.skillcheck_interview_script`,
`skillcheck_notice_version` and `skillcheck_language`, plus opaque metadata.
Recording is disabled in this phase. When the approved, version-pinned
SC-012 plan is later mapped to `VoiceCallRequest`, only trusted, frozen,
curated question text may enter dynamic variables.

The Retell agent must include matching named dynamic variables in its
*published* prompt, be checked for published status, and have a provider-side
max duration cap. The draft's requestedMaxSeconds is only advisory: it does
not enforce Retell duration by itself.

## Zadarma prerequisites (manual account access required)

Official guide: https://zadarma.com/pl/support/instructions/retellai/

1. Register/verify a Zadarma account; activate a virtual PBX.
2. Choose and verify a suitable virtual caller number (+48 as appropriate),
   confirm eligible mobile rate **before purchase**; do not assume Economy
   rate without confirmation.
3. In Retell -> Phone Numbers -> "+" -> "Connect to your number via SIP
   trunking":
   - Phone Number: verified Zadarma DID
   - Termination URI: `pbx.zadarma.com`
   - SIP Trunk User Name: private Zadarma PBX extension identifier
   - SIP Trunk Password: secret extension credential, never in GitHub/chat
   - Nickname: local PBX extension display name
4. Bind this number's *outbound agent* to the SkillCheck voice agent; test
   number eligibility and provider status. Inbound forwarding is optional and
   **not** required for candidate outbound calls.
5. Never store SIP credentials in frontend, logs, PR, nor expose them to ChatGPT.

## Required gates before calling any person

- Retell PR #116 CI and independent review, plus this PR's own CI/review.
- Authorized user/operator; tenant-specific assignment; approved current
  SC-012 plan from trusted DB revision; verified lawful basis and contact
  authorization; do-not-call/time restrictions; one-time lease and idempotency.
- SC-010-C worker with capped spend/attempts, timeout recovery (Retell
  POST is not assumed idempotent), separate outbound enable flag default OFF.
- Verify agent's dynamic-variable compatibility and published version via
  actual Retell authenticated Preview read.
- Verify signed raw-body Retell webhook and replay/cross-tenant isolation,
  map safe events via existing SC-011-B contract, retain transcripts only under
  explicit retention policy (SC-010) before SC-013 reporting.
- Explicit owner approval for paid synthetic-person phone smoke test.
  **No production call, deploy or paid call is authorized by this work.**

## Verification

`node --test tests/retell-outbound-draft.test.mjs`
`npm run typecheck`
`npm run build`

SC-011-C drafts map scenarios only; no proof of provider interoperability until
SIP is configured and a separately authorized controlled Preview smoke test
succeeds.
