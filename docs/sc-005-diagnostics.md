# SC-005 — diagnostyka błędów workera

TASK: SC-005 / issue #6
LEVEL: L3
SCOPE: BACKEND
OWNER: Krzysztof / ChatGPT implementation
REVIEWER: independent Codex reviewer
DEPENDS ON: existing SC-005 worker and SC-006 UI

## Problem
On 2026-10-11 the real Vercel dispatch received HTTP 202 from screening-worker.
Both synthetic attempts for analysis version 2 then failed with openai_invalid_output.
The existing error hides HTTP rejection, malformed envelopes, incomplete responses,
invalid criterion sets and evidence mismatch behind the same public code.
Historical logs cannot establish which case occurred.

## Change and acceptance
Keep database error codes, user messages, strict evidence checks, prompt/model,
retry policy, authorization and tenant boundaries unchanged. Add only finite
allowlisted diagnostic_reason and numeric http_status to server failure logs.
Never log provider bodies, raw error messages, request headers, CV, quotes or keys.
Do not persist raw provider responses. No migration or production activation.
Success means mocked failures can be distinguished, still fail closed, and do not
leak sentinel payloads. Existing screening, typecheck and build gates must pass.
Independent review and owner acceptance precede merge to integration.

## Controlled production verification after approval
Deploy the reviewed worker bundle through the approved release process. Leave AI
disabled until a coordinated synthetic test. Enable only for that test, retry the
existing synthetic application once from the UI, correlate attempt IDs with logs
and DB state. If rejected, inspect diagnostic_reason/http_status without weakening
validation. The underlying production error is NOT fixed merely by diagnostics.
Restore SCREENING_AI_ENABLED=false in both Vercel (with redeploy) and Supabase.
Do not mark SC-005 done until a real UI -> worker -> provider -> DB -> UI result is
successful and cleanup is confirmed.
