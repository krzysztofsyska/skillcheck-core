# SC-011 Retell AI — Preview read-only metadata foundation

TASK: SC-011-RETELL-READONLY | LEVEL: L3 | SCOPE: BACKEND
OWNER: ChatGPT / orchestrator | REVIEWER: independent Codex pending
DEPENDS ON: SC-011 provider contract and SC-012 interview scenario, neither authorizes a live call
STATUS: Draft PR; independent review and CI required
PRODUCTION_APPROVAL: NO | EXTERNAL_CALLS: NO | DB/MIGRATIONS: none

## Preview configuration

Vercel project `skillcheck-core`, **Preview only**:
- `RETELL_API_KEY`: secret, **never** in browser / repository / logs
- `RETELL_AGENT_ID`: agent identifier (not a credential)

Both variables must remain absent from production unless separately approved.

## Current capability

`lib/voice/retell-agent.ts` offers an internal, server-side function:
`readRetellAgent(process.env)`.

It performs **only** `GET https://api.retellai.com/get-agent/{agent_id}` (Bearer API key),
with timeout, no retries, fail-closed error codes and a small sanitized status projection.
No routes expose it to unauthenticated callers; no public status endpoint is added.
It does not send telephone calls, process applicants, publish agents, create web calls,
capture audio, upload CVs, or change vendor configuration.

`tests/retell-agent-readonly.test.mjs` uses a mocked HTTP client with synthetic data.
GitHub CI runs the tests without credentials and without reaching Retell.

## Remaining gates to live preview smoke test

1. Independent security review of the read-only module and CI; fix any findings.
2. Implement a **trusted, authenticated, Preview-only** invocation path or internal
   worker for one-time metadata probe, with tenant/operator authorization. Do not
   expose the vendor credential or provider payload.
3. Deploy accepted code in an appropriate Preview deployment using the already
   scoped variables; verify `agentId` match, `pl-PL`, agent draft/published state,
   and Retell response. Do not claim live connectivity from mocked tests.
4. Implement and review Retell voice dispatch with SC-010-C one-time candidate contact
   authorization, idempotency, cost caps, retention/erasure, signed webhook validation,
   tenant scoping and human-approved SC-012 source version.
5. A later explicit owner approval is required before real calls or production activation.

References:
- https://docs.retellai.com/api-references/get-agent
- docs/sc-011a-voice-provider-contract.md
- docs/sc-012a-interview-plan.md
