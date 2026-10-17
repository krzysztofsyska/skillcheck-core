# SC-019 A2 — payment orchestration (not LIVE)

TASK: #93, child of #91. User requires payments as part of PRESELEKCJA launch, not only a contact form. FREE never uses this paid checkout. Implemented by ChatGPT; independent Codex L3 review required.

## Historical baseline — core at aa17946c (superseded below)
`lib/sc19-payments.ts` coordinates an authenticated owner's purchase using a server-approved PLN gross-total offer, immutable price/credit/terms snapshot, persisted order before provider side effects, stable per-order provider idempotency, bound checkout session, verified provider receipt, and one transaction for payment deduplication, the existing SC-019 credit increment, and the paid order marker. It does not implement a second balance ledger. No numeric customer offer, tax rate, processor or account is selected.

The port now requires canonical gross PLN and **one-time** checkout economics before revealing a payment URL, plus a read-only `lookupCheckout` to recover the original session after an ambiguous provider timeout or an expired checkout creation window. A verified paid webhook may perform that lookup and persist the original session before granting credits; uncertain results fail closed and must be retried. The checkout kill switch only denies *new checkouts*: signed, scoped payments initiated before disablement or LIVE approval revocation still settle. A distinct second provider payment on an already-paid order triggers operations review even with a different session.

No default HTTP transport, secret reads, public route, deployment or provider calls are installed by this PR. `PaymentProvider` and `PaymentStore` are required injection ports, not working integrations. The tests supply synthetic adapters only. The code must not be advertised as accepting money.

## Baseline adapter requirements (progress is recorded in the continuation below)
- A real processor adapter must authenticate the unmodified request body/signature/timestamp, pin merchant and test/live scope, and retrieve authoritative payment status. Browser success redirects never fulfill orders. Creating Checkout must use the durable order ID as the provider idempotency key; ambiguous attempts must reconcile before any new charge. The unbound order's 30-minute creation window is a safety ceiling, not a guarantee about any provider's idempotency retention. Confirm the selected provider retains keys at least that long. Implement `lookupCheckout` as an authoritative, READ-ONLY provider query keyed by durable order metadata/idempotency key; `null` requires proof no session exists, and ambiguous responses must throw. The adapter must independently return/retrieve the canonical charged gross amount, PLN currency, and one-time payment mode, and must disallow any provider-side tax, discounts or subscription changes not in the saved order. This contract must be checked with the selected provider in a real sandbox before activation.
- A real PostgreSQL `PaymentStore` must use transactional locking and bounded serialization retries; enforce unique `(company_id,request_id)`, scoped checkout session, and `(provider,account,mode,payment_id)` across processes. `grantOnce` must increment the EXISTING SC-019 balance using the purchased order's credits (not the mutable current policy) atomically with grant and order state. No browser-accessible grant method. Authorization and verified-company status come from current trusted DB records, never user-editable metadata.
- No SQL migration is introduced here. Before adding payment tables, reconcile #92/#115 and SC-010 inventory/signature; do not bypass erasure protection. Run actual PostgreSQL concurrent duplicate-webhook and rollback tests. In-memory tests below are not that evidence.
- Bind authenticated UI/checkout route and raw webhook route to those adapters. A notification received before session binding, failed signature check, uncertain payment result or failed transaction must NOT receive a successful processed acknowledgment. Return retryable status where appropriate; never mark an event processed before the grant transaction commits.
- An additional settled payment for an already-paid order raises `SC19_PAYMENT_DOUBLE_PAYMENT_REVIEW`: do not grant twice or discard the money silently. Operational handling of refunds, chargebacks, duplicate charges and failed fulfillment is still required before LIVE. No subscriptions or automatic refunds are implemented.
- Create the service per request using trusted activation configuration, so revoked authorization/flags are not cached indefinitely. Never reuse the new-checkout kill switch to block fulfillment of an already accepted scoped order; preserve draining and operational reconciliation when checkout is disabled. LIVE requires independently approved merchant, amount/terms, migrations, security review and end-to-end test. No switch is enabled here.

## Evidence
Original commit: Node 22.16 built-in test runner 22/22 PASS, zero skipped; strict TypeScript check PASS. This revision adds eight targeted P1/P2 regression tests, requiring CI and independent review on the new SHA. Tests cover authorization, tampered price, unapproved offers, duplicate events, checkout idempotency, ambiguous timeouts, session binding, merchant/mode mismatch, fake-transaction concurrency, rollback and cross-order reuse. No real PostgreSQL/processor/payment/candidate data used. GitHub CI and independent review remain separate evidence.

Official provider references used for the integration contract (not a provider selection):
- https://docs.stripe.com/checkout/fulfillment
- https://docs.stripe.com/events/manage-webhook-endpoints

## Open activation inputs
Confirmed processor/account, approved PRESELEKCJA gross price and commercial terms are not present in the verified task contract. Do not activate the illustrative 299 PLN / 60 credits as an approved sale. Do not substitute manual contact for the requested final online-payment path.

## 2026-10-17 continuation — provider-independent persistence and checkout

TASK: SC-019-MVP-A2-PAYMENTS (#93); LEVEL: L3; SCOPE: FULLSTACK.
OWNER: ChatGPT / SkillCheck; REVIEWER: independent Codex.
STATUS: IMPLEMENTED; isolated PostgreSQL verification PASS; final SHA CI pending. PRODUCTION_APPROVAL: NO.

### Dependency evidence (read 2026-10-17)
- #92: `bb2cf5272914fb1438224959612aacaee5cba5a9`, Draft, Checks/Agent Gates/SC-019 MVP SUCCESS. One unresolved P1 thread (`PRRT_kwDOPjDIhs6spHcH`) concerning candidate/advisory/finalizer ordering, with author response; no final independent PASS accepted here.
- #115: `79daea590f9cd7c546ff6e1d2b55e62ee0a834b0`, Draft and conflicting with #92; three unresolved threads on catalog display, audit timestamp and landing-page resilience. Prior replies are not a current-HEAD PASS. Current-HEAD workflow query returned no runs.
- #129 baseline `aa17946c`: 30 tests and Checks/Agent Gates green, four old threads resolved. That evidence does not cover this continuation.

### Added implementation
- `createPostgresPaymentStore`: real parameterized PostgreSQL transactions with company-before-order/balance locking, bounded SERIALIZABLE/deadlock retries, durable request uniqueness and globally scoped payment receipt uniqueness. Uses the existing `private.sc19_balances` and `private.sc19_credit_journal`; no parallel credit system. Owner and KYB approval come from current DB rows.
- Immutable offers and order economic snapshots, scoped session uniqueness, browser-denied private tables with RLS. No seeded commercial offer. Manual recovery must use the canonical `settlement:sc19:<sha256(JSON.stringify([provider,account,mode,paymentId]))>` journal reference and reconcile the existing order/receipt atomically; never issue a separate manual grant for an online payment.
- Same-origin JSON checkout POST, authenticated company-scoped offer/status GETs, bounded streaming raw webhook POST. Response minimization and no-store; no browser success marker grants credits. Webhook fulfillment does not depend on the new-checkout kill switch.
- Owner-only `/dashboard/[companyId]/billing/checkout`: approved gross price, exact credits and full terms from the catalog, explicit acceptance, persistent retry UUID, server-confirmed order status; FREE is excluded. It shows an unavailable state when configuration/catalog is absent.
- `composeSc19PaymentRuntime` connects the real store and existing core to an injected provider. **The deployed resolver deliberately returns null** until a real provider, approved account/offer, trusted auth.getUser() composition and reviewed schema are registered. Thus all new routes currently return 503 without accessing DB/provider. No fake adapter is shipped in runtime and no environment flag alone activates it.

### Isolated database contract and remaining migration gate
`docs/prototypes/sc19-payment-storage.sql` is additive REVIEW-ONLY SQL, not a Supabase migration. It requires the #92 credit tables. It deliberately aborts before changes when SC-010 `erasure_schema_signature()` exists: adding tables requires a new, checked-in, independently reviewed immutable erasure inventory revision after #92/#115 are reconciled. It never recomputes a production baseline or bypasses erasure guards. Full-chain SC-010 deployment is therefore **not ready**.

Tests load the exact #92/#115 SQL via pinned git SHAs (no copied quota implementation), on newly created disposable loopback PostgreSQL16 databases. CI fetches full history and uses a local postgres:16 service. Missing DB URL is an explicit skip locally; dedicated CI always provides it. No cloud database, credentials, external operator, real transaction or migration is used.

### Required verification
Original 30 tests + HTTP security tests; two independent PostgreSQL connections, concurrent checkout and webhook replay, restart replay, cross-company payment reuse, RLS/grants, immutable economics/current-policy change, injected rollback after credit writes, lost provider response, kill-switch draining, real quota spend/refund concurrency and actual HTTP-handler→core→PostgreSQL flow. Typecheck/build and independent review are required for this revision. Provider sandbox and browser-to-real-provider purchase remain pending selection/approval.

### Next after dependency approval
Reconcile #92/#115, generate a CLI migration including the immutable SC-010 inventory revision, verify the full schema and operator/KYB flow in disposable Preview. Choose the real operator/account and approve price/terms, implement its signature and canonical lookup adapter, bind per-request auth.getUser() and a scoped server DB pool, run sandbox tests, then request separate LIVE/production approval. No automatic LIVE activation, transactions, merges or production schema changes are part of this continuation.

### Verification receipts for the continuation
- `fa3e343e8910a8df40c33a12a3c1382ba618dc6f`: dedicated GitHub Actions run 39041710773, actual PostgreSQL16 + core + HTTP **64/64 PASS**, zero skipped. Twelve PostgreSQL subtests run against each pinned dependency. This includes live concurrent DB sessions and stale owner/KYB revocation, not an in-memory concurrency claim.
- Typecheck and production Next build PASS locally. Real Next HTTP/SSR tests: 3/3 PASS (anonymous redirect, owner/non-owner rendering and all concrete endpoints fail closed). Uses synthetic Supabase auth/PostgREST only.
- Independent reviewer found repeat-purchase P2, now fixed. Reproducible component-handler tests: 3/3 PASS (lost response retry, explicit second purchase, paid offer B cannot clear pending offer A). This is a component test, not a full browser/provider sandbox purchase.
- CI teardown originally FORCE-dropped the test database before pg.Pool had fully disconnected, causing 57P01 after all assertions passed. Teardown now waits for zero database sessions and drops without FORCE; the next run passed.
- Final dedicated workflow also builds Next and runs the real route tests. Final SHA/run evidence is recorded in the PR, independently from earlier receipts.
