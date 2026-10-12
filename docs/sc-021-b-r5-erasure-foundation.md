# SC-021-B/R5 — offline contract for candidate-linked AI costs

Status: ISOLATED PROTOTYPE / NOT DEPLOYABLE / not merged.
TASK: SC-021-B-R5 (#109), stacked on SC-021 #108; SC-010-R4 remains unchanged.
LEVEL: L3, SCOPE: DB / OPERATIONS, PRODUCTION_APPROVAL: NO.

## Threat boundary

The original SC-021 ledger supports both company-wide and per-candidate work,
but has no trusted mapping from a physical provider call to the candidate.
A candidate pseudonym, request UUID, process UUID or provider response ID
can all be joinable back to a person via another system. Merely blanking
the pseudonym does not constitute anonymization.

The R5 prototype uses an explicit, company-scoped FK from candidate to
one physical provider call (private.ai_gateway_candidate_links). A candidate
cannot be deleted while linked rows exist (FK ON DELETE RESTRICT).
The privileged candidate reservation path validates company/candidate
using the locked authoritative candidate row before reserving budget.
There must be no raw CV, prompts, voice content or email in the ledger.

## Signed erasure protocol — prerequisites

The candidate must already be frozen by SC-010. The erasure_purge_owner
capability may execute detach only inside the SAME transaction where the
SC-010 execution-scoped purge context exists (matching txid, request, company,
mode=delete and target candidate set). Direct tenant/browser requests have
no access to this function. A plain erasure request or fake role is insufficient.

The current prototype uses synthetic SC-010 context records in its test.
It does NOT yet prove that it works inside SC-010's real signed erasure,
manifest checkpoint, restore, purge and independent receipt lifecycle.

Any linked operation in reserved/unknown status blocks detach. A successful
settled charge is copied into a tenant-month/task/provider/model/price
aggregated sum and the physical usage record with candidate/process/provider
IDs is deleted. Released reservations are dropped without monetary cost.
The complete financial move and deletion occur in one transaction; rollback
must restore both.

IMPORTANT: a tenant/month/task/model financial subtotal is data-minimized,
but NOT automatically anonymous under GDPR. A tiny cohort (e.g. one candidate)
may still be re-identifiable using external timestamps, invoices or usage
patterns. Privacy review must either establish effective aggregation thresholds
or a lawful retention basis and access restrictions for these summaries. Until
then this is an engineering prototype, not a claim of irreversible anonymity. Re-running detach before the candidate is removed must
not duplicate the aggregate. The original billing event is permanently
unavailable after deletion, so future invoices must reference only
anonymous totals or a separately compliant non-personal invoice ledger.

Budgets MUST include the anonymous spend in addition to active usage.
Otherwise erasure would incorrectly give back consumed quota.

## Hard release gates

1. The existing SC-010-R4 schema signature is intentionally not altered.
   New candidate mapping tables remain outside supabase/migrations.
2. Implement real SC-010 inventory, purge graph, freeze enforcement,
   restore protocol and immutable R5 baseline; review both candidate-related
   tables, compound FKs, anonymous totals and every function/grant.
3. Enumerate all joinable correlation surfaces, including source SC-005,
   analytics, process/operation IDs, provider IDs, workers and audit logs.
   Purge or isolate references consistent with retention/legal obligations.
4. Make candidate-bound reservation the ONLY worker path for
   candidate-related operations. The legacy generic reserve() is not
   proof of safe binding, so neither worker nor API is production-ready.
5. Handle shared-subject operations: reject them or require a reviewed
   multilateral deletion rule. Prototype links one usage to one candidate.
6. Decide retention horizon, legal basis and minimum aggregate granularity
   for financial data, invoicing, backups and exports. This is a privacy
   and accounting decision, not a guessed value in code.
7. Run real SC-010 authorization and two-tenant cross-role tests; check
   concurrency between freeze/reserve/settle/purge, active screening,
   unknown provider charges, rollback/retry, and schema drift fail-closed.
8. Independent Codex/security review and owner acceptance before any
   integration merge. Separate production consent, including DB migration
   and deployment, is still required.

## Test command

Run npm run test:ai-gateway against the isolated ephemeral PostgreSQL
instance in GitHub Actions. No real provider is called and no Supabase
project is mutated. These are technical checks of the prototype only.
