# SC-013-A — syntetyczny kontrakt transkrypcji i dowodów

TASK: SC-013-A | LEVEL: L3 | SCOPE: BACKEND (offline only)  
STATUS: IMPLEMENTATION / NOT PRODUCTION | PRODUCTION_APPROVAL: NO | PROMOTION: NO

This slice freezes a synthetic transcript-event and evidence-span contract so later work can consume an authenticated transcript without treating a raw provider event or a claimed transcript as trusted evidence. It does not modify the SC-013 architecture document and it does not add a migration or share schema with SC-012-B.

## Interface

- Transcript: schema version, speaker `interviewer|candidate`, integer `startMs`/`endMs`, immutable segment id, tenant and interview ids, plan revision, transcript revision, source id, provider event/call correlation, attempt id, provenance, and `untrusted`.
- Only `provenance: synthetic_fixture` with `untrusted: false` can be sealed, and only for this offline harness. `authenticated` on every sealed value and every result is `false`. `provider_event`, `claimed`, and `authenticated_channel` fail closed. A provider status event is not a transcript.
- Canonical bytes are RFC 8785 (`rfc8785-transcript-v1`) over the ordered segments. SHA-256 is taken from those UTF-8 bytes. Evidence offsets are UTF-16 indexes into one candidate segment: `quote === text.slice(startUtf16, endUtf16)`.
- Ratings: `insufficient_data | below | meets | above`. Substantive ratings need 1–5 exact candidate quotes. `insufficient_data` needs zero quotes and `numericScore: null`. Absence is never stored as 0. No hire/reject field is accepted or emitted.
- Reviewer override: `approved | approved_with_changes | requires_follow_up | rejected_result`. Those values judge the assessment, not the candidate. Only an approval can become the effective current result, and only through compare-and-swap of the pointer and a higher analysis version. A newer transcript revision clears that pointer immediately.

## Non-features

No telephone provider, signed callback check, recording, external model call, real candidate data, database write, migration, worker, secret, or production scoring. Passing this module does not authorize a live voice flow.

## Tests

`npm run test:voice-transcript`  
`npm run typecheck`  
`npm run build`

DB/MIGRATIONS: none. EXTERNAL CALLS: none.
