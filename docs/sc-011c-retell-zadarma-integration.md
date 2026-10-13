# SkillCheck SC-011-C — Retell + Zadarma: przygotowanie bez telefonowania

TASK: SC-011-C | SCOPE: BACKEND | LEVEL: L3 | OWNER: ChatGPT
REVIEWER: independent Codex (latest-commit re-review required)
DEPENDS_ON: PR #116, SC-011-A, SC-012, SC-010-C worker
STATUS: OFFLINE-ONLY DRAFT, NOT DEPLOYED
PRODUCTION_APPROVAL: NO | EXTERNAL_CALLS: NO | BILLING: NO
DB/MIGRATIONS: NONE

## What is implemented in this PR

- `compileRetellOutboundDraft` is a **pure offline compiler**: NO network, SDK, POST, telephony, charge, or deployment. Retell request drafts use `override_agent_version` as an exact published **tag** (NOT numeric version or floating latest), top-level `idempotency_key`, and `honor_internal_dnc: true`. No CV/name/score metadata.
- `verifyRetellOutboundAgent` is the separate **server-side GET-only gate**, using fixed Retell URLs and `redirect: error`. It checks an exact tag's assigned numeric version and published flag, `pl-PL`, data storage `basic_attributes_only`, and a provider-side duration cap. It reads the exact referenced flow revision and requires both prompt variable placeholders in its **global prompt**; otherwise fail closed. Emits an in-memory capability valid for at most 30 seconds. It MUST be called only by authenticated trusted backend/worker with server-held credentials, never from untrusted client input.
- SC-012 released plans have a nonforgeable in-process provenance WeakSet from generated → reviewed → released transitions. The offline compiler requires an authentic released plan, exact frozen question text/IDs/followups and approved notice revision. Arbitrary text inserted even inside a valid request is rejected. This does **not** replace source freshness, durable human approval or tenant authorization at DB level.
- Provider idempotency key is included at the correct Retell request-body level. Retell's provider deduplication window is bounded; future SC-010-C worker needs durable once-only reservation and exception handling beyond that window.
- The source-approved full Retell flow JSON SHA-256 (`approvedFlowSha256`) must match the exact fetched version, including *all* nested nodes and tools. This is a strict pin to a separately reviewed immutable configuration; changes, including custom function, SMS or call-transfer additions, invalidate the gate. The hash must be reviewed and recorded by the trusted backend, never accepted from candidates, arbitrary users or client inputs.
- The agent must explicitly set a bounded storage retention of 1–30 days. The default indefinite retention is rejected, including when only basic call attributes are stored.
- Retell metadata is entirely omitted: caller-controlled correlation strings must not be retained at the provider. Provider idempotency key is restricted to a generated UUID v4 (Retell-compatible alphabet), and `honor_internal_dnc` remains true.
- Offline compiler also requires at least 420 seconds for the SC-012 approved interview and a vendor cap no shorter than that target.
- Privacy: no audio/transcripts/PII handling in this PR. If a future reporting module requires transcriptions, design a separately approved and GDPR-reviewed processing route rather than silently switching storage from basic_attributes_only.
- Three gate workflow checks; `tests/retell-outbound-draft.test.mjs` is synthetic-only with no live network.

## Manual prerequisites Zadarma/Retell

Official guide: https://zadarma.com/pl/support/instructions/retellai/

1. Register and verify business account with Zadarma, activate virtual PBX.
2. Evaluate virtual caller number +48, confirm exact mobile rates and caller ID verification **before purchases**.
3. Retell dashboard → Phone Numbers → + → Connect to your number via SIP trunking:
   - Phone Number: allocated, verified Zadarma caller ID
   - Termination URI: `pbx.zadarma.com`
   - SIP Trunk User Name: dedicated private PBX extension
   - SIP Trunk Password: dedicated SIP secret; NEVER share in chats, GitHub, frontend, Vercel logs.
4. Assign outbound agent/appropriate outgoing route, publish explicitly reviewed, tagged agent version with global prompt placeholders `{{skillcheck_interview_script}}` and `{{skillcheck_notice_version}}`, minimal storage `basic_attributes_only`, explicitly finite `data_storage_retention_days` (1–30), provider-side duration at least 420 s and no more than 600 s.
5. First owner-approved synthetic-person +48 test, **separate payment authorization required**.

## Remaining gates for any live call

- Independent Codex reviewer PASS on exact current HEAD, GitHub CI PASS, owner acceptance, protected branch rules.
- SC-010-C worker transaction proves authenticated tenant/user, documented lawful basis and candidate permission, current SC-012 plan revision, approved contact window, local DNC, correct identity and amount budget. No redirecting calls to arbitrary user numbers.
- Before **each** vendor POST: re-fetch exact agent tag/version/flow to detect reassignment; durable once-only reservation and top-level idempotency token, safe recovery on network uncertainty, retries only after reconciliation. Provider key alone is NOT sufficient across all failure modes.
- Signed Retell webhook with verification on raw bytes, replay and tenant isolation; safe mapping, storage/retention per SC-010.
- End-to-end Preview test + separately authorized paid phone test. This PR contains no POST worker and cannot place calls.

## Tests

`node --test tests/retell-outbound-draft.test.mjs`
`npm run typecheck`
`npm run build`

This is a reviewable offline artifact, not completed physical telephony, not an API deployment, not a recruitment pipeline acceptance.
