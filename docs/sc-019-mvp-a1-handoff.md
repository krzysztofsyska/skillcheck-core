# SC-019-MVP A1 — SAFE BILLING CORE PROTOTYPE

TASK: #91 / SC-019-MVP
STATUS: IMPLEMENTED IN ISOLATED BRANCH; REVIEW AND PRODUCTION ACTIVATION PENDING
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
