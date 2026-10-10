# SC-019-MVP A1 — SAFE BILLING CORE PROTOTYPE

TASK: #91 / SC-019-MVP
STATUS: IMPLEMENTED IN ISOLATED BRANCH; REVIEW AND PRODUCTION ACTIVATION PENDING
BASE: integration
SCOPE: FREE (5 analyses) + PRESELEKCJA prepaid (60 analyses)
PRICING: 299 PLN is only a proposed initial commercial price; do NOT charge or publish it as approved.
PRODUCT: the existing voicebot, candidate chatbot, AC and subscriptions remain outside this MVP.

## What exists in this change
- `docs/prototypes/sc-019-mvp-credits.sql`: executable isolated PostgreSQL prototype, NOT inside `supabase/migrations`. Applies on a database with the SC-004/005/006 logical analysis schema.
- `tests/sc-019-billing-prototype.test.mjs`: PGlite role/tenant/trial/grant/consume/refund/retry tests.
- `lib/screening-flow.ts`: recognizes DB status `PT402` and presents a precise upgrade message; does not start provider dispatch on denial.
- `tests/screening-ui.test.mjs`: checks fail-closed dispatch on PT402.
- `lib/supabase/database.types.ts`: typed billing RPC contracts for when the database migration is approved.
- `app/dashboard/[companyId]/billing/page.tsx` and `actions.ts`: owner-only FREE activation form, quota overview and operator-handled PRESELEKCJA order link; server-side `SC19_PACKAGES_ENABLED` defaults OFF.
- `app/dashboard/[companyId]/page.tsx`: billing link exists only with the server release flag ON.
- `.github/workflows/checks.yml`: executes isolated tests in standard CI.

## Security / billing rules
1. RLS grants nothing directly to browser roles on four private billing tables. No client-controlled balances.
2. Owner claims FREE once per unique valid **Polish NIP** through `sc19_claim_trial(company,nip)`; idempotent on the same company/NIP. Unique NIP is an anti-duplicate control, NOT proof of legal control of the entity. Additional KYB/anti-abuse before open public self-service FREE release is required.
3. `sc19_get_balance` checks authenticated tenant visibility, never returns NIP.
4. Every INSERT of a new logical `screening_analysis_versions` automatically reserves one credit inside the same transaction. It is impossible to bypass with the legacy start RPC; zero balance raises `PT402`. Reusing a current analysis is not charged.
5. Terminal failure/cancellation releases one credit; pending reactivation after fail/cancel reserves one credit. State is tracked in `sc19_analysis_spend`, history in append-style journal.
6. `private.sc19_grant_paid(company,settlement_ref)` grants exactly 60 analyses after the operator verifies external funds settlement. An idempotent settlement reference cannot be credited twice, or to another tenant. Do NOT grant EXECUTE to `authenticated`, `anon`, or a public API role.
7. A new or existing tenant without balance has no right to launch new AI analyses after prototype is activated. A production rollout must first reconcile existing accounts and migrations; never blindly enable the DB trigger on live production.
8. Existing SC-006 worker flag must remain OFF pending separately approved end-to-end synthetic test.

## Gap to customer-usable FREE / paid PRESELEKCJA
- Run independent SQL/security review, including actual PostgreSQL 16 simultaneous-connection race tests, role/grant checks, and lock-order/deadlock analysis.
- After PASS, use **Supabase CLI** `supabase migration new sc019_mvp_credits` to create the real migration file. Transfer reviewed SQL and add immutable migration history. Do not manually fabricate or apply a migration to production.
- Verify correct SkillCheck Supabase project connection (currently not visible to the connected Supabase account). Verify existing migration history and live worker secrets **presence only**, edge function code, HMAC/DB role.
- Complete real company/NIP verification and anti-abuse beyond the existing feature-gated claim UI. Test onboarding for both existing and new firms; pilot operator can approve manually. Do not expose private NIP in logs or public responses.
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
