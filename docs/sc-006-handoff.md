# SC-006 — screening UI and human review

- TASK: SC-006, Issue #7
- LEVEL: L3; SCOPE: FULLSTACK
- STATUS: implemented locally; draft PR / independent review pending
- BRANCH: feat/sc-006-screening-ui
- BASE: integration at 0003b8d
- IMPLEMENTER: Codex, per direct owner instruction on 2026-10-09
- REVIEWER: independent review required; no self-issued PASS
- DEPENDS ON: SC-005 synthetic provider E2E PASS before production activation;
  existing SC-007 retry conflict migration must be included in the approved deployment plan.

The owner explicitly authorized parallel SC-006 development while SC-005 remains open.
This does not authorize promotion, production changes, or enabling AI.

## Changes and interface

The existing recruitment link now opens “Preselekcja AI”. The screening page renders
ready, pending, processing, completed, failed and stale states, version history,
original per-criterion results, exact evidence, and separately labelled human corrections.
Unknown evidence remains `insufficient_data`; there is no score or hire/reject decision.
Pending/processing polling stops after five minutes and has a manual refresh fallback.

Server Actions authenticate with `companyAccess`, enforce write access, load the current
reviewed redacted CV and complete position, and call existing authenticated RPCs.
Only the attempt returned by `start_screening_analysis` or `retry_screening_analysis`
is dispatched with server-side HMAC. The browser supplies route identifiers and a UUID
idempotency key, never a dispatch capability. Failed dispatch preserves the pending job
and gives a recovery message. Dispatch has a 15-second timeout and rejects redirects.

Review forms support approved, approved_with_changes and needs_reanalysis. Overrides
are parsed only for criterion IDs loaded in the authenticated tenant scope. Quotes must
match the stored analysis snapshot exactly; offsets use UTF-16. The existing RPC checks
freshness, authorization and expected review version under lock. Stale/historical
results cannot be approved as current. Original AI rows are never mutated.

## DB / migrations / secrets

No new schema, migrations, grants, worker deploys or production changes. No provider call.
No service-role client. Attempts, leases, raw source CV, provider errors and secrets are
not passed to client components. The built browser chunks were checked for secret env
names and lease-token fields; no matches.

## Validation

- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `npm run test:auth`: 11 PASS.
- `npm run test:screening`: PASS, including existing PGlite RLS/tenant/review/retry tests.
  One pre-existing optional Deno runtime test skipped because Deno is not installed.
- New `tests/screening-ui.test.mjs`: 10 PASS. Covers authenticated dispatch binding,
  viewer/foreign tenant/disabled AI/draft CV denial, retry scope/freshness, RPC/dispatch
  failures, completed reuse, exact quotes and UTF-16, review dispositions, immutable
  corrections, and rendering the real async page with scoped synthetic adapters.
- Updated SC-005 dispatcher guard test for the new authenticated SC-006 action boundary;
  no arbitrary-attempt server action is allowed.
- `git diff --check`: PASS.

## Limits and next action

No authenticated live browser/provider E2E was performed. Synthetic adapter rendering
and PGlite tests do not establish production readiness. SC-005 remains blocked by the
malformed provider API key observed during the previous diagnostic; AI stays disabled.
CI and independent review must pass before owner acceptance into integration. Production
requires separate owner approval, SC-005 PASS, and a complete authenticated smoke test
covering start, worker completion, review, stale prevention and retry.
