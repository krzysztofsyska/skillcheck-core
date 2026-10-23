# SC-019 credits + payments forward migration — L3 design for independent review

Date: 2026-10-21, Europe/Warsaw. Contract: Issues #93 / #91.
Source: `integration@bcc9a200a8a082c13fa3796e9375b37e4b520c8d`.
Status: architecture revised after independent review; final PASS required before SQL implementation.
Architect: independent Codex agent `/root/migration_design` (read-only repository analysis).

## Goal and boundary

Promote the accepted SC-019 credit policy/ledger and #152 payment storage invariants into a real forward migration with an immutable SC-010 inventory revision. Prove installation and explicitly supported upgrades on disposable PostgreSQL 16 and 17. Preserve the existing ledger, policy, balances, order economics and accepted webhook/payment contracts.

No changes to applied historical migration files. No remote database, main, secrets, flags, runtime resolver, real provider, prices, KYB implementation or new voice implementation. Existing prototype SQL stays a historical/isolated contract, including its refusal to install payments when SC-010 exists. The migration is a separate, reviewed implementation of the complete composition and does not remove that refusal.

## Repository evidence

- `docs/prototypes/sc-019-mvp-credits.sql` owns six billing tables: `sc19_package_policy`, `sc19_balances`, `sc19_trial_nips`, `sc19_trial_approvals`, `sc19_analysis_spend`, `sc19_credit_journal`. It installs company-first locks, billing/reconciliation triggers and revised claim/complete/fail worker bodies, then R5 inventory.
- The credit contract rejects non-completed historical analyses with no spend reservation, while holding a write-blocking table lock. Completed history is left unbilled. Preserve both checks and lock; do not manufacture debt, credits or backfilled spends.
- `docs/prototypes/sc19-payment-storage.sql` owns four tables, immutable snapshots/aliases, company-wide partial uniqueness for `status='awaiting_payment'`, scoped checkout session uniqueness and immutable payment grants.
- The current R5 SC-010 bodies already preserve R4-VOICE's `voice_request_adapter_unknown` check. Do not replace them with the older legacy-only R4 bodies.
- `private.erasure_schema_signature()` covers public/private relations (including views), columns, check/FK constraints, incoming foreign keys from any schema, and non-internal triggers. It does **not** cover ordinary/partial indexes, function bodies, ACL, or role attributes. Therefore signature equality alone is insufficient to accept an existing payment schema.
- Both credit and payment prototypes enumerate actual ACL grantees and remove unexpected default grants, including TRUNCATE and grant options. Preserve this targeted hardening; RLS does not prevent TRUNCATE.
- `tests/helpers/screening-ranking-fixture.mjs` currently applies every migration by default. Historical erasure/billing/voice tests then add prototypes and/or assert R4/R5 constants. A forward migration changes this assumption; fixtures must explicitly distinguish a pinned historical chain from a full current chain.

## Delivery shape

Prefer **one atomic forward migration**, generated with `supabase migration new sc019_credits_payments_inventory` after architecture review. A single transaction prevents an observable committed interval where payment tables exist but erasure inventory still excludes them. Organize the file into readable preflight, credit install/adoption, payment upgrade, ACL, inventory/RPC and postflight sections. Separate documentation/fixtures are fine; do not split a required invariant across independently committed migration files.

Use transaction-local bounded lock/statement timeouts appropriate to an offline rehearsal. Acquire a documented migration advisory lock, lock the touched existing data relations in deterministic order and reject rather than retry silently when the schema/data cannot be stabilized. Actual rollout needs an application maintenance/drain window; do not create or change a runtime maintenance flag here.

## Explicit source-state contract

The implementation must list **every** accepted source state in a checked-in manifest with source commit/file hashes, exact object set, SC-010 inventory revision/signature, targeted index/function expectations and data invariants. A missing/partial/unknown state fails before changes. Never use `CREATE TABLE IF NOT EXISTS` to accept an unverified relation.

Required states:

| State | Construction from checked-in source | Transition |
| --- | --- | --- |
| Fresh legacy | Historical migrations through `20261012031039_retention_scheduler_inventory.sql`; no SC-019 credit/payment objects | Install existing credit contract + four payment tables + final inventory |
| Fresh R4-VOICE | Same chain + the seven isolated voice source/permission/quota/preparation modules from `voice-preparation-fixture.mjs` + `db/isolated/sc010-r4-voice-retention.sql`; no SC-019 credit/payment objects | Preserve voice functions/adapters; install credits/payments + voice final inventory |
| Current credit-only legacy | Historical chain + exact current reviewed credit prototype, with R5 | Adopt existing six tables without data changes; install payments + final inventory |
| Current credit-only voice | R4-VOICE chain + exact current reviewed credit prototype, with R5 | Same, retaining voice adapters |
| Reviewed legacy existing orders | Exact historical #129 three-table payment storage and matching reviewed credit contract installed before SC-010, then the required historical SC-010 migrations | Normalize reviewed function bodies, preserve all ledger/order data, add aliases + unique unresolved index, publish final inventory |
| Reviewed #152 existing orders | Exact four-table payment storage installed before SC-010, then required SC-010 migrations | Preserve aliases and orders, validate invariants, backfill any missing original aliases and publish final inventory |

The last two are explicit **synthetic upgrade fixtures**, not a claim that such schemas exist in Production. They are needed because the isolated payment prototype deliberately forbade installation after SC-010. Do not produce those states by deleting or bypassing the prototype guard. Install sources in their historically permitted order. If only a narrower old-credit revision is supported, name it exactly and refuse the others instead of silently treating them as equivalent.

Do not automatically accept a database without the complete historical SC-010 prerequisites. Apply/reconcile those prerequisites only in the disposable fixture here; real production mapping remains a separate task.

Known checked-in inventory constants:

- Legacy R4: `d2e7725bd5051e15cb7e700a128026a3ad6f0d87f9d3bba3de8e1539c9d3eabd`.
- R4-VOICE: `70cdbf43562f147294c417639b76fe121154f4dc6e49799b9764232a4aedc444`.
- Credit-only legacy R5: `10358458d8802b1ed59a298b305752a89ce110d1019a11cde937f2a2311f79bc`.
- Credit-only voice R5: `c989b84b9eec51fc48c361b8ad9e7404b4044268d56d106b6788fe56f3f1857d`.

New accepted old-order input digests and final output digests must be derived offline from these exact pinned constructions and committed as literals. The runtime migration compares its observed catalog with those literals; it never calculates a new trusted baseline from its target. PG16 and PG17 must confirm the same expected values or document and explicitly support any proven version-specific representation difference. Never blindly whitelist a hash after a test fails.

## Credit installation and adoption

Fresh sources receive the **same** six tables, existing policy semantics, existing grants and reviewed claim/complete/fail bodies. Preserve illustrative initial FREE/PRESELEKCJA quantities already present in the accepted SQL; no offer, price, settlement, approval or credit balance is seeded. Document that retaining existing code defaults is not commercial approval.

An existing-source branch must preserve every policy row/value/timestamp, balance, NIP, approval, spend and journal row exactly. Do not recreate tables, reset policy to defaults, grant again, or derive balance by summing an incomplete history. Adopt only the named reviewed layouts. Reapply exact reviewed procedure bodies where historical installation order could otherwise leave older SC-010 worker bodies in place. Preserve existing role ownership/grants for worker/erasure functions, use explicit safe `search_path`, and revoke untrusted default grants only on the owned SC-019 objects.

If a historical R5 table is absent in an accepted pre-SC010 order fixture, normalize its existence inside this same transaction (with the immutable historical literal, never an observed signature) before final R6 publication, or explicitly version the final output for the absence. Prefer normalization to two final variants (legacy/voice); no intermediate invalid baseline may commit. Existing historical baseline rows are never edited.

## Payment installation and upgrade

Reuse accepted #152 columns, types, FKs, CHECKs, RLS, indexes, triggers and `sc19_payment_immutable()` semantics. No runtime API contract changes are needed.

Before touching existing orders, lock orders and any alias/grant tables and reject:

- More than one `awaiting_payment` order for a company, regardless of offer, buyer or provider scope.
- Any existing alias `(company_id, request_id)` pointing to an order other than the order whose original request it is.
- Cross-company aliases, malformed economics, incoherent paid/session/payment status, or unsupported table/function/index definitions.

Create missing aliases for every original order request as `(order.company_id, order.request_id, order.id)`. Preserve aliases that already map correctly. Aliases remain forever after payment. A uniqueness collision must not be swallowed by unconditional `ON CONFLICT DO NOTHING`; explicitly verify the stored target. Preserve all original order fields, including original `request_id`, timestamps, economics, session and payment identifiers.

Only after duplicate detection, create `sc19_payment_one_unresolved` where absent on the exact legacy branch. Verify existing index uniqueness, columns, predicate, validity and readiness. Verify the `(company_id,id)` supporting unique key before adding the composite alias FK. Never drop duplicates, select a winner, modify order status or infer settlement.

Preserve payment grant uniqueness and scoped session uniqueness. The TypeScript store continues to lock the company first, use SERIALIZABLE/bounded retries and fulfill through the **existing** balance/journal in the same transaction. No second ledger, browser grant RPC or generic operator bypass.

## SC-010 R6 publication

Create `private.erasure_inventory_baseline_r6` with the existing singleton/signature/known_tables pattern, RLS, `contact_immutable()` trigger and targeted ACL reset. Record the complete manually reviewed relation allowlist, including all historical inventory tables, six billing tables, four payment tables, R6 itself, and the exact voice extension only on that supported branch.

Reissue the current reviewed bodies of these four functions, substituting R6 for R5 as source-level code only:

1. `public.preview_candidate_erasure(uuid,text,uuid)`.
2. `private.prepare_erasure_purge_manifest(uuid)`.
3. `private.authorize_retention_suggestion(uuid)`.
4. `public.get_retention_schedule(uuid)`.

Do not extract and string-replace arbitrary installed function bodies with `pg_get_functiondef`. Use checked-in reviewed source. Preserve the voice request adapter check, execution gates, owner authorization, candidate locks, manifest binding, purge protocol and restore behavior. Preserve owner/security-definer attributes and only the existing authorized EXECUTE grants.

Billing/payment rows are company accounting records. They contain no copied CV and are excluded from candidate purge adapters; `analysis_id` remains an opaque reference without FK to a deletable analysis. Tests must show purge/restore leaves policy, balances, accounting rows, payment orders/aliases/grants intact, while removing the candidate/voice data it already removed correctly.

Final postflight must require exact signature, exact relation allowlist with no omissions/extras, all expected FK/index/trigger/RLS/ACL properties, no executable SC-010 function still consulting R4/R5, and all original aliases present. Missing/partial final state aborts the whole transaction. Historical inventory table existence itself is allowed; only stale executable references are rejected.

## Tests and fixtures

Add a dedicated forward-migration suite that applies the **actual checked-in migration**, not a copied SQL implementation. Keep old tests pinned to their declared historical predecessor chain where they are explicitly testing isolated prototypes. Rename/comment the helper contract if its default becomes a historical baseline, and provide an explicit whole-current-chain path used in the new suite. Never let all tests accidentally omit the forward migration.

Run the new suite against PostgreSQL 16 **and** 17, with new random disposable databases on loopback only; refuse arbitrary URLs. Capture actual server versions. PG17 execution is required, not a PGlite substitute. PGlite may provide a fast additional regression.

Required matrix:

- Fresh complete legacy and R4-VOICE source chains; credit-only upgrade with modified policy and existing balances; legacy three-table paid+unpaid order upgrade; #152 alias upgrade.
- Exact source and final signatures/inventory, unknown table/view/column/incoming FK, malformed or unreviewed existing payment layout, missing/incorrect partial index, and unsupported source refusal.
- Two-company isolation and owner/recruiter/viewer/outsider/anon; no browser/private table CRUD, no custom-role TRUNCATE or grant-option leakage under hostile default grants; authorized SQL operator only.
- FREE once per approved legal entity; no self-approval; one credit debit and exactly-once refund. Existing completed analysis history unchanged; unreserved active historical analysis causes atomic refusal.
- Two simultaneous distinct request IDs on separate connections select one unresolved order/key; replay after paid returns original order; fresh deliberate repurchase allowed; different offer/provider/buyer cannot escape slot.
- Concurrent duplicate webhooks produce one grant/journal increment; injected failure rolls back grant/order/balance/journal together. Snapshot terms immutable despite policy/offer changes.
- Original alias backfill preserves old order data exactly; conflicting alias or unresolved duplicates fail without partial changes. Retry after failed migration starts from identical source.
- SC-010 preview/scheduler allow known final schema and deny unknown schema; signed purge plus independent ledger restore, both legacy and voice; survivor tenant unaffected; accounting data byte-for-byte unchanged.
- Required typecheck/build and relevant existing SC-019/SC-010 regression workflows; new workflow matrix has mandatory DB URLs and no skipped database branch. Existing historical PG16 contracts remain intact.

## Evidence and rollout limitations

Record migration filename generated by CLI, CLI version, source SHA, fixture provenance, expected signature literals, test commands and PASS/FAIL/SKIPPED separately. Independent final review binds to exact HEAD and real base, not an earlier draft. The design itself also needs an independent reviewer before SQL implementation.

Main and remote migration ledger stay untouched. Production history timestamp mapping, operator/KYB, provider selection/credentials, commercial approval, resolver activation, and full real-provider E2E remain outside this migration task. A prepared migration in a PR or integration is not an applied database change or launched sales.


## Independent-review clarifications (required, before SQL)

The migration's observed schema digest uses a transaction-local `pg_temp` helper copied from the committed SC-010 catalog algorithm, with inline pg_catalog SHA256. It must not trust an installed `private.erasure_schema_signature()` or `private.erasure_hash()` implementation. Input whole-state fingerprints additionally cover all custom public/private routine sources, owners, security attributes and settings; the exact index set including predicates, uniqueness, readiness/validity and extra indexes; enabled trigger state; RLS policies; and the expected security attributes and memberships of application worker roles. ACL checks must reject unsafe existing access outside the explicit SC-019 cleanup contract. New and owned SC-019 objects remove all non-owner grants, then restore only the previously approved browser RPC grants. Unexpected default grants to newly created objects must not survive.

Alias conflicts mean a `(company_id, request_id)` that is an order's ORIGINAL request ID but maps to a different order. Additional legitimate recovery aliases remain valid and unchanged.

Existing paid orders must have exactly one matching payment grant and canonical `settlement:sc19:<sha256(payment_key)>` journal reference, with matching company, purchased credits and reason. The payment key must bind provider/account/mode/payment ID. Pending orders must have no payment grant. A mismatch aborts; migration does not infer payment settlement, change status, repair money records or recompute balances. Pre-existing manual credit grants unrelated to online orders remain legitimate and unchanged.

Old-order fixtures constructed before SC-010 have no R5. Their observed signature differs from the recorded historical R4 baseline. These are deliberately named, historically blocked precursor states, admitted only by exact pinned whole-state fingerprints and data checks. R5 is normalized with its historical literal inside the same transaction, without executing R5-gated product operations or committing an intermediate state. R6 is the only final usable inventory.

Existing erasure tickets, manifests, authorizations and signed ledger events keep their original signatures and contents. Migration never rewrites their hashes or signatures. Old schema-bound work fails closed; operators must drain/reconcile in-flight erasure work before rollout and recreate stale previews/authorizations where the established protocol requires it. Tests must establish the actual stale-work behavior and the signed-ledger restore/replay behavior on the final schema. If an active execution cannot remain safely resumable, migration must refuse that source state and require draining; no implicit reset is allowed.

One BEGIN/COMMIT spans credits, payments, alias adoption, ACL, R6 publication and postflight. No separately committed intermediate inventory revision is part of this delivery.


### Explicit v1 signed-history precondition

Every accepted source state must have NO rows in SC-010 execution, verified-ledger-event, receipt, tombstone (`retired_candidate_ids`) or restore-checkpoint tables, and no active candidate freeze/request beyond an unsigned preview. Refuse both nonterminal AND terminal executions/old retained signed recovery obligations atomically. The existing restore protocol compares the signed old schema before its terminal/no-op decision, so a finished old execution is not safe to ignore. Do not delete these records, expire them artificially, rewrite signatures, or claim support for their migration. A source with such history requires a separately reviewed signed-history transition; it is outside v1. Tests cover terminal old-schema execution/receipt refusal and preservation, in addition to actual purge/restore created after R6. Unsigned preview tickets/suggestions may remain, but stale authorization cannot succeed and must be reissued.
