# Runbook: SC Step 4 + SC-010 R8 erasure inventory

Status: preparation only. Production requires a separate PRODUCTION APPROVAL bound to the SHA and to this list of migrations.

## Preconditions
- The Step 3 runbook (`docs/release/sc-step3-r7-runbook.md`) is complete: R7 is installed (`private.erasure_inventory_baseline_r7`).
- `20261029100000_sc019_operator_fulfillment.sql` and `20261030120000_sc_step3_matrix_change_invalidates_approval.sql` are applied.
- `private.erasure_schema_signature()` equals R7: legacy `4e14a557…` or voice `f61669ad…`.

## Order (mandatory, migrations one by one, never `supabase db push`)
1. `20261030160000_sc_step4_interview_decision.sql`
2. `20261030160100_sc_step4_erasure_inventory_r8.sql`

Between steps 1 and 2, candidate erasure is blocked fail-closed (`schema_dependency_unknown`). Run step 2 right after step 1.

After step 2, the signature equals R8 (legacy `d87bccd9…` / voice `f057e8bc…`), and the erasure preview has no `schema_dependency_unknown` blocker.

## What R8 changes
- New baseline `private.erasure_inventory_baseline_r8`: R7 tables plus `public.application_stage_events`, `public.application_decision_events`, `public.candidate_assessment_note_revisions`.
- `private.erasure_inventory_rows` and `private.erasure_row_candidates` are renamed to `*_r7` (after an exact source-hash check per variant) and wrapped. The wrappers add the three Step 4 adapters, so preview counts, the purge manifest and manifest validation include every Step 4 row.
- The purge engine is unchanged. Step 4 rows are erased by the `ON DELETE CASCADE` foreign keys when the engine deletes the manifest-checked `applications` / `candidate_assessments` rows. The trigger `aa_erasure_cascade_guard` refuses, inside a purge transaction, a Step 4 row whose key and hash are not in that purge's manifest.
- The four inventory functions are retargeted from R7 to R8 (only the baseline table name changes).
- Receipt counts keep listing the engine's adapters only; the Step 4 counts are in the preview and the manifest.

## Rollback (manual, files in `supabase/rollbacks/`, in this order)
1. `20261030160100_sc_step4_erasure_inventory_r8_down.sql`: restores the R7 bodies of the four inventory functions, unwraps the two adapters, drops the guard triggers and `erasure_inventory_baseline_r8`. The schema returns to the Step 4 source state (legacy `81388d40…` / voice `641650ae…`); erasure stays fail-closed.
2. `20261030160000_sc_step4_interview_decision_down.sql`: **deletes the Step 4 audit logs and decision fields**. It refuses to run while R8 is installed.

`tests/sc-step4-erasure-r8.test.mjs` verifies step 1 and that step 2 refuses while R8 is installed. As with R7, the rollback is one-way for erasure: re-applying Step 4 after its rollback gives the new columns different `attnum` positions, the source schema no longer matches the reviewed R8 literal, and R8 refuses to install (`sc_r8_source_schema_unreviewed`). That needs a new, separately reviewed inventory revision; until then, candidate erasure stays blocked fail-closed.
