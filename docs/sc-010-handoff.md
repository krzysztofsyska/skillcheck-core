# SC-010 B1 — offline backend foundation

TASK: SC-010; LEVEL: L3; SCOPE: BACKEND.
STATUS: IMPLEMENTED, REVIEW / CI VERIFICATION.
Architecture: PR #68 (merged), scoped B1 independent review PASS.
Implementation base: integration fdcd9f2bff6a6ad280cf8c9f2a46a3f36f0945ae.
Owner instructed review and backend foundation; production not approved.

## Implemented contract
Four public read-only tenant tables: candidate_contact_permissions,
candidate_contact_preferences, candidate_communications, candidate_communication_events.
Private contact_requests provides request idempotency; contact_audit keeps immutable
permission/preference metadata. No email, phone, message, CV or token is copied.

- record_contact_permission(candidate,recruitment nullable,channel,state,evidence_ref,
  expected_revision,request_key): only unverified/revoked/blocked; unverified requires
  evidence UUID but this is an operator claim, never proof or effective permission.
  Actor/source set by server; denied state cannot be reset to unverified.
- set_contact_preferences(candidate,timezone,weekday_windows,blocked_channels,
  expected_revision,request_key): operator_recorded, not candidate-confirmed.
  Windows: JSON array of <=7 objects with numeric weekday/start_minute/end_minute,
  unique weekday 1..7, start 0..1439, end 1..1440, start < end; IANA timezone/UTC.
  A preference change cancels existing drafts conservatively; it never clears deny.
- prepare_candidate_communication(application,shortlist,channel,request_key): draft
  only, explicit current human shortlist of that same application/tenant, open
  recruitment, active application, no applicable denial/blocked channel.
  Unknown/missing permission can support a draft; it cannot authorize delivery.
- cancel_candidate_communication(id,expected_version,request_key): safe idempotent
  cancellation; already cancelled remains cancelled without an extra event.
- get_candidate_communications(application,after_created_at,after_id,page_size)
  and get_candidate_communication_history(id,same cursor): invoker/RLS, 1..100 rows,
  paired cursor, stable created_at/id ordering. UUID metadata only.

Version 0 creates permissions/preferences. Updates require current revision.
Same actor/company/operation/key plus identical payload returns existing ID;
changed payload conflicts. Revoked/blocked cancels matching drafts atomically.
Only one draft per application/purpose; no implicit channel fallback.
Mutation authorization precedes locks. Candidate NOWAIT serializes writes; owner/
member SHARE protects authorization; source locks follow SC008 with NOWAIT. Conflicts
return PT409; 401/403/404/422 are safe codes, no raw provider or PII errors.

## Deliberately unavailable
No granted, approved, scheduled, attempt, lease, provider, callback, send, recording,
contact ingestion, pricing or automatic retry APIs. Changing reserved flags cannot
create a delivery path. Draft/cancel does not alter hiring decisions or AI results.
SC011/012 and future B2 require separate trusted consent/contact/policy/provider
contracts. This B1 is not the completed outbound communication product.

## Migration and production gate
New, CLI-generated migration:
20261009105025_candidate_communication_foundation.sql.
Not applied remotely. Atomic BEGIN/COMMIT; RLS and explicit grants/revokes;
private helpers inaccessible to anon/authenticated/screening_worker; user writes
only via tenant-checked RPCs. No new worker capability.

FK RESTRICT deliberately prevents deleting parents with communication history.
Before any production apply, implement/review the authorised redaction/purge path
and UI handling of restricted deletion. No production readiness claimed for this PR.
Do not use blanket db push: SC006/007/008 production timestamps differ from repo.
Rollback uses a forward fix; do not remove audit or replay installed migrations.

## Verification
- Independent static code review PASS for B1, including strict numeric windows.
- PGlite actual complete migration chain: 17/17 PASS, including SC006 human review
  -> SC008 actual shortlist -> SC010 draft, NULL score, RLS, deny, idempotency,
  revisions, restrictive FK, immutable history, private evidence, pagination.
- Real PostgreSQL concurrency suite: 10 scenarios plus parent, wired into CI with
  postgres:16. Local host has a single-UID namespace, so it was not simulated with
  PGlite or reported as locally executed. Final CI evidence belongs in the PR.
- Typecheck PASS. Joint SC006/008/009 9/9; ranking 20/20; report 13/13 PASS.
- Build, base DB/screening regressions and final full CI results recorded in PR.
- No production mutation, real provider call or candidate contact.

## Next handoff
Executor: Codex, continuation in krzysztofsyska/skillcheck-core.
Review the B1 PR against the scoped SC010 architecture; verify CI on its exact head,
real PG race final states, role/tenant isolation, deny precedence, unreachable grant/
delivery, type contracts, audit, and parent-deletion limitation. Fix any findings
on the same branch, rerun affected gates, and report PASS/FAIL with commit and tests.
After PASS ask OWNER ACCEPTANCE for integration. Do not deploy this migration or
contact candidates; production needs the separate purge/UI readiness work and approval.
