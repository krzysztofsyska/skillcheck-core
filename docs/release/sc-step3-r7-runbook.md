# Runbook: SC Step 3 + SC-010 R7 erasure inventory

Status: preparation only. Production requires a separate PRODUCTION APPROVAL bound to the SHA and to this list of migrations.

## Preconditions
- M13 (`20261021084732_sc019_credits_payments_inventory`) is applied and R6 is installed (`private.erasure_inventory_baseline_r6`).
- `private.erasure_schema_signature()` equals R6: legacy `e99342b9…` or voice `6fd4900f…`.

## Order (mandatory, migrations one by one, never `supabase db push`)
1. `20261026220100_sc_step3_evidence_extensions.sql`
2. `20261026220200_sc_step3_evidence_worker.sql`
3. `20261028120000_sc_step3_erasure_inventory_r7.sql`

Between steps 1 and 3, candidate erasure is blocked fail-closed (`schema_dependency_unknown`). Run step 3 right after step 2.

After step 3, the signature equals R7 (legacy `4e14a557…` / voice `f61669ad…`), and the erasure preview has no `schema_dependency_unknown` blocker.

## Rollback (manual, files in `supabase/rollbacks/`, in this order)
1. `20261028120000_sc_step3_erasure_inventory_r7_down.sql`: restores M13's exact R6 bodies of the four inventory functions and drops `erasure_inventory_baseline_r7`.
2. `20261026220200_sc_step3_evidence_worker_down.sql`
3. `20261026220100_sc_step3_evidence_extensions_down.sql`: **deletes the data in the Step 3 columns** (`human_note`, `human_evidence`, `missing_info`, …).

After all three, the schema equals R6 again. This is verified by `assertR6` in `tests/sc-step3-erasure-r7.test.mjs`. Between the steps, erasure stays fail-closed.

## Owner decision (2026-10-28): the R7 rollback is one-way
After a rollback, re-applying Step 3 gives the new columns different `attnum` positions, because dropped columns keep their numbers. The schema signature then differs from the reviewed R7 literal, and migration R7 refuses to install (`sc_r7_source_schema_unreviewed`).

**Re-deploying Step 3 after a rollback requires a new, separately reviewed inventory revision** (a new baseline, e.g. R8, with new literals). Until then, candidate erasure stays blocked fail-closed. The owner accepted this on 2026-10-28.
