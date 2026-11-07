# FREE / PRESELEKCJA — acceptance audit, 2026-11-07

Baseline: `integration` `738545c0e1054c513aa3e03ab8858cd9287f6c53` (includes #324).
Contracts: #233, #268, #284. This audit concerns implementation and synthetic
verification, not production activation or a successful real payment.

## #233: each reported item

| Item | Current implementation / evidence | Result |
| --- | --- | --- |
| Global concurrent analysis limit across companies | `20261106230000_cv_bulk_global_capacity_lock.sql`; `cv-bulk-database.test.mjs` runs two tenant pumps concurrently behind the same advisory lock and asserts one slot | Implemented; native CI verifies |
| Erasure of queued/held CV releases reserved credit | R9/R10 inventory and `20261102120000_cv_bulk_erasure_guards.sql`; erasure tests cover held and transferred slots and purge in legacy/voice variants | Implemented; native CI verifies |
| Frozen candidate duplicate visible in batch status | Erasure guards; same test asserts frozen duplicates are hidden, no new frozen candidate is linked, and pumps leave frozen data untouched | Implemented; native CI verifies |
| Old automatic groups treated as current after CV/requirements change | `preselectionGroupCurrent` and shared ranking currency in report, recruitment and batch views; report tests cover stale analysis, older analysis, missing human review and pagination | Implemented; 24 report tests passed locally after file-URL portability fix |
| Caller-supplied pricing poisons usage stats | Pump reads DB-held validated pricing; native test supplies attacker price 999 and verifies no cost/pricing value is stored | Implemented; native CI verifies |
| Signed scheduler lacks replay nonce | `private.cv_bulk_worker_nonces` introduced in review-fixes migration and included in R10; signed background pump test rejects unsigned and replayed calls | Implemented; native CI verifies |
| Single analysis outside bulk receives no automatic group | #330 adds completion hooks for v1/v2 through `private.screening_apply_single_group`; the composed path expects five groups for five analyses. Regressions cover replay, manual decisions, incomplete/failed results, tenant binding, frozen candidates and rollback | Implemented in #330; final merged-base native CI and independent review remain release gates |
| Queued files keep credits while AI is disabled | UI denies new bulk intake before reservation; old queued files release after 24 hours; unit and native tests cover both | Implemented |
| Groups absent from report/CSV until every row reviewed | Report has a separate explicitly provisional automatic-group section; CSV carries application IDs, not names; test verifies group export without per-row approval | Implemented; confirmed locally |
| Text header hides scanned PDF body | Extraction checks image/text coverage and runs OCR; rejects missing or contradictory contact/name evidence; `cv-bulk.test.mjs` has mixed-PDF regression cases | Implemented; local OCR regressions passed |
| Scheduler ignores uploading batch for two hours | `20261106231000_cv_bulk_uploading_scheduler.sql`; native test processes registered CVs while upload remains open | Implemented; native CI verifies |

## #268: candidate report and comparison

- Required/additional marks are read from the same version-aware requirement
  flags; unmarked historic profiles remain unmarked. The database suite checks
  tenant isolation and that relabeling a requirement does not invalidate an analysis.
- Single report starts with summary, groups required requirements first, displays
  status/citation and missing-evidence questions. Unit cases include driving
  licence absent from CV, in-progress analysis, rejected and edited evidence.
- Comparison has at most five candidate columns and the same status vocabulary.
  #324 adds fail-closed handling of failed/incomplete analysis and first nonblank citation.
- New actual Next HTTP test reads five individual reports and their comparison,
  changes one human-reviewed matrix, checks the other four stay unchanged, then
  revokes approval. The individual report retains historical evidence with an
  outdated warning; comparison withholds it. Neither presents it as confirmed.
- Anonymous and cross-company export, revoked access, malformed sizes, missing
  RPC, and private-field leakage remain covered by existing HTTP/unit tests.

## Verification added by #325

`tests/sc-019-migrations-mvp-e2e.test.mjs` composes the real current SQL, billing
action, bulk registration/pump, analysis completion, human review, ranking,
shortlist, report/CSV and payment handler. FREE grants five once; one analysis
with failure/retry consumes one; a five-file batch reserves only the remaining
four; replay cannot reserve again; five completed CVs reach the report; a sixth
analysis is refused. Invalid settlements grant nothing; signed synthetic
settlement and replay grant once; paid credits then fund another report.

Native PostgreSQL 16/17 executes this test in the existing migration workflow.
The synthetic paid fixture deliberately uses 12 credits / 12345 minor currency
units; these are test values, not commercial configuration or approved prices.

Local validation: Next webpack production build and TypeScript completed;
candidate report unit suite passed; report unit suite 24/24; actual Next HTTP
suite 6/6. The test file-URL fix uses `fileURLToPath` on Windows and Unix.
Native CI results and exact final SHA belong in the PR handoff.

## Limits of this evidence

The HTTP test uses synthetic auth/PostgREST responses. The database test uses
synthetic authenticated roles and signed fake provider events; extraction is
tested separately. These tests do not prove live signup email delivery, NIP
registry availability, an AI-provider request, P24 settlement or production
configuration. No real CV, external contact, payment, provider cost or production
mutation was performed. #266 remains HOLD. The single-analysis grouping change in #330
does not approve candidates or change application status. Do not close all of #233 until the
single-analysis grouping passes native CI and independent review on its final integration base.
