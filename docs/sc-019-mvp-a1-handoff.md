# SC-019-MVP A1 — SAFE BILLING CORE PROTOTYPE

TASK: #91 / SC-019-MVP
STATUS: FIXING — Codex P1 on 69e965f (claim versus complete/fail lock order) repaired in the prototype; independent repeat review still pending
BASE: integration
SCOPE: FREE (5 analyses) + PRESELEKCJA prepaid (60 analyses)
PRICING: 299 PLN is only a proposed initial commercial price; do NOT charge or publish it as approved.
PRODUCT: the existing voicebot, candidate chatbot, AC and subscriptions remain outside this MVP.

## What exists in this change
- `docs/prototypes/sc-019-mvp-credits.sql`: executable isolated PostgreSQL prototype, NOT inside `supabase/migrations`. Applies on a database with the SC-004/005/006 logical analysis schema.
- `tests/sc-019-billing-prototype.test.mjs`: PGlite role/tenant/verified trial/grant/consume/refund/retry tests.
- `tests/sc-019-billing-concurrency.test.mjs`: disposable real PostgreSQL16 two-connection race test for final FREE credit and payment-settlement replay; only runs when SC19_TEST_DATABASE_URL is loopback `/postgres`.
- `lib/screening-flow.ts`: recognizes DB status `PT402` and presents a precise upgrade message; does not start provider dispatch on denial.
- `tests/screening-ui.test.mjs`: checks fail-closed dispatch on PT402.
- `lib/supabase/database.types.ts`: typed billing RPC contracts for when the database migration is approved.
- `app/dashboard/[companyId]/billing/page.tsx` and `actions.ts`: owner-only FREE activation form, quota overview and operator-handled PRESELEKCJA order link; server-side `SC19_PACKAGES_ENABLED` defaults OFF.
- `app/dashboard/[companyId]/page.tsx`: billing link exists only with the server release flag ON.
- `.github/workflows/checks.yml`: executes isolated tests in standard CI.

## Security / billing rules
1. RLS grants nothing directly to browser roles on five private billing tables. No client-controlled balances.
2. FREE is **deny-by-default** until a trusted SkillCheck operator verifies company representation and inserts an approval in `private.sc19_trial_approvals` with an opaque proof reference. Only then can the owner claim FREE once per valid, unique **Polish NIP**. Same company/NIP is idempotent; unverified companies receive 42501. A checksum-valid NIP is NOT proof of company representation; public KYB automation remains future work.
3. `sc19_get_balance` checks authenticated tenant visibility, never returns NIP.
4. Every INSERT of a new logical `screening_analysis_versions` automatically reserves one credit inside the same transaction. It is impossible to bypass with the legacy start RPC; zero balance raises `PT402`. Reusing a current analysis is not charged.
5. Terminal failure/cancellation releases one credit; pending reactivation after fail/cancel reserves one credit. State is tracked in `sc19_analysis_spend`, history in append-style journal.
6. `private.sc19_grant_paid(company,settlement_ref)` grants exactly 60 analyses after the operator verifies external funds settlement. An idempotent settlement reference cannot be credited twice, or to another tenant. Do NOT grant EXECUTE to `authenticated`, `anon`, or a public API role.
7. A new or existing tenant without balance has no right to launch new AI analyses after prototype is activated. A production rollout must first reconcile existing accounts and migrations; never blindly enable the DB trigger on live production.
8. Existing SC-006 worker flag must remain OFF pending separately approved end-to-end synthetic test.

## Gap to customer-usable FREE / paid PRESELEKCJA
- Run independent SQL/security review, confirm CI of the new actual PostgreSQL16 simultaneous-connection race test, validate role/grant edge cases, and complete lock-order/deadlock analysis.
- After PASS, use **Supabase CLI** `supabase migration new sc019_mvp_credits` to create the real migration file. Transfer reviewed SQL and add immutable migration history. Do not manually fabricate or apply a migration to production.
- Confirmed connected database: Supabase project `wsvjawuikxfzjyivxgsu`, labeled `white Label`, matches the repository sample URL and contains SkillCheck schema (20 public RLS tables and historical SC-006/008 migrations). Read-only checks 2026-10-10. Vercel Production declares `SCREENING_AI_ENABLED`, `SCREENING_WORKER_URL`, `SCREENING_WORKER_DISPATCH_SECRET`; encrypted values are not inspected. Verify their effective configuration and test HMAC + DB role with synthetic fixtures before AI activation.
- Define an auditable company/NIP verification process. SQL approval table and fail-closed claim exist; a trusted operator must verify representation before adding an approval. Test onboarding for new and existing tenants. Never expose NIP in logs or public responses.
- Review and test the feature-gated balance/claim panel with a real authenticated tenant; implement verified-payment operator flow and upgrade CTA; no purchase redirect may grant credits.
- Secure first live synthetic flow: company registration → verified claim → approved redacted CV → user start → worker processing → human review → SC-008 ranking → SC-009 report → exhausted FREE → verified payment → credits.
- Complete policy/legal readiness (DPA under GDPR Article 28, privacy info, retention, terms, VAT / invoice handling). State explicitly that AI supports rather than makes hiring decisions.
- Explicit owner approvals remain required for pricing and production release. No real client data and no real charges in testing.

## 2026-10-13 continuation (PR #92, no production)

- HEAD before this pass was `585bb55`. GitHub Checks `verify` (run 38236739739) and `credits` (run 38236739678) failed because `tests/sc-019-billing-prototype.test.mjs` created `private.has_company_access` with an unclosed dollar quote (`as $`). PGlite reported SQLSTATE 42601 at position 1332, so quota, refund, grant and RLS tests never ran.
- That fixture quote is restored, and the disposable PostgreSQL 16 race fixture now declares the same two-argument `has_company_access(uuid, boolean)` signature that `public.sc19_get_balance` calls.
- PR #92 was CONFLICTING with `integration`. The only content conflict was `lib/supabase/database.types.ts`. The resolution keeps `sc19_claim_trial` / `sc19_get_balance` and the SC-010 retention/erasure RPCs already on `integration`.
- No Codex review thread exists on PR #92: review comments and pull-request reviews are empty. The 2026-10-10 comment is a review request, not a PASS.
- No Supabase migration was added. `docs/prototypes/sc-019-mvp-credits.sql` stays review-only. A CLI migration PR is the next step only after an independent PASS, and only for sandbox/`integration`, never Production.
- Payments, production migration, production deploy, voicebot SC-011-B #79 and customer E2E for SC-005 remain out of this change.

## Codex findings on c6f217d

The automated review was not a PASS. This prototype now:

- locks `public.companies` in a BEFORE INSERT trigger, before the analysis foreign key takes a key-share lock, then before balance, spend, and journal writes. A PostgreSQL 16 mixed grant/spend/refund loop covers the same order
- cancels and releases a pending or processing analysis when it becomes stale; a completed analysis that later becomes stale keeps its charge
- rejects FREE after a PRESELEKCJA grant
- aborts installation while any non-completed analysis has no reservation
- when SC-010 is already installed, publishes immutable `erasure_inventory_baseline_r5` in the same transaction, retargets the preview, purge, and scheduler signature checks, and leaves billing `analysis_id` values as company accounting with no foreign key to `screening_analysis_versions`

No file was added under `supabase/migrations`. Payments and production activation stay off.

## Codex findings on ca6eef3

The repeat review was not a PASS. This prototype now:

- abandons a pending or processing `screening_analysis_attempts` row in the same transaction that cancels a newly stale analysis, matching `claim_screening_attempt`, before the reservation is released
- checks in the R5 schema signature `e764d74f5563805185807c6a37b5e08659771f2e8534c76df3651c9ea46ea7d9`, generated from the clean migration chain plus this prototype on both PGlite and PostgreSQL 16
- installs the preview, purge-manifest, retention-authorization, and retention-schedule bodies from that reviewed source with the baseline relation renamed to R5, and refuses install when the stored R4 signature, the live signature, or the relation inventory differs

No file was added under `supabase/migrations`. Payments and production activation stay off.

## Codex finding on 2aff83b

The repeat review was not a PASS. The stale cancellation already holds the analysis row and then locks the attempt. The installed `claim_screening_attempt` locked the attempt first, so the two paths could deadlock. When that function is present, the prototype replaces it with the reviewed body and locks the analysis row, the company row, the attempt, and then the candidate. A PostgreSQL 16 test races the worker claim against the stale update eight times with `deadlock_timeout=100ms` and requires the analysis to end cancelled, the attempt abandoned, and the balance restored.

No file was added under `supabase/migrations`. Payments and production activation stay off.

## Codex finding on 69e965f

The repeat review was not a PASS. Completion and failure still locked the attempt before the analysis, which deadlocks a reclaim that now locks the analysis first. Both finalizers use the reviewed function bodies and take the analysis row, the company row, the attempt, and then the candidate. Completion keeps its application advisory lock before those row locks. The PostgreSQL 16 test races an expired-lease reclaim against both completion and failure, requires exactly one of them to commit, and checks that held credits still match the balance.

No file was added under `supabase/migrations`. Payments and production activation stay off.

## Release guards
NEVER merge SQL prototype into migration tree or activate it on live Supabase automatically.
PRODUCTION_APPROVAL: NO
AI_ENABLED_APPROVAL: NO
PAID_CHECKOUT_APPROVAL: NO
This branch introduces reviewable backend foundations and tests, not customer-usable packages yet.

## Pilot verification — design, do not execute without production approval
1. Confirm the applicant is authorized to represent the named firm; validate submitted NIP against external company registration evidence.
2. Using trusted restricted SQL operator access, insert into `private.sc19_trial_approvals(company_id,nip,proof_reference)`. Proof reference must be an opaque audit ID, not raw identification material. Do not grant browser roles INSERT.
3. Invite the already verified firm owner to activate FREE in the authenticated billing panel only after reviewed migration, final tests and release flags are approved.
4. A NIP checksum alone cannot activate credits; unverifiable or reused identities remain blocked.
