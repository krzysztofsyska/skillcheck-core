# SC-019 A2 — payment orchestration (not LIVE)

TASK: #93, child of #91. User requires payments as part of PRESELEKCJA launch, not only a contact form. FREE never uses this paid checkout. Implemented by ChatGPT; independent Codex L3 review required.

## 2026-10-21 forward-migration continuation

The new SC-019 migration, six explicitly supported source states, immutable R6
inventory and native PostgreSQL16/17 verification are described in
[`sc19-migrations-handoff.md`](sc19-migrations-handoff.md). This supersedes the
historical statement that migration work has not been prepared; it does not
claim the migration is merged, remotely applied or activated. Fresh policy is
empty, adopted policy is preserved, and the payment resolver remains null.
Exact final HEAD/BASE, CI and independent code-review receipts belong in the PR.

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

## 2026-10-20 reconciliation after #92 and #115

TASK: SC-019-MVP-A2-PAYMENTS; LEVEL: L3; SCOPE: FULLSTACK.
PRODUCTION_APPROVAL: NO. Existing payment core retained; no provider is selected or activated.

- Ordinary merge of `integration` at `fbc75c79530fa81ddb8e94e71fcc5f1293f5553e`
  into the existing #129 branch, without rebase or history rewriting.
- The final reviewed dependency revisions are #92
  `5166f3ce354ecffb5c7d77b1573a185e83f0f476` and #115
  `5701b16e3dcbfe4f79fb27a315c1db4614d93811`. Both are already merged into this
  integration base. The dependency blockers recorded on 2026-10-17 above are historical.
- PostgreSQL16 payment tests now run against both final pinned revisions **and
  the actual credit SQL read from the current checkout**. The payment workflow
  also triggers on changes to that credit SQL. No copied quota implementation is used.
- Each contract verifies concurrent checkout and settlement, exact-once grants,
  rollback, tenant/merchant/mode binding, stale owner/KYB revocation and
  spend/refund races. A new check denies a late FREE claim after paid fulfillment.
  For every contract containing configurable policy, the policy changes after
  checkout but before settlement; fulfillment still grants the saved 12-credit
  order, never the later 99-credit policy.
- Existing immutable economic snapshots, provider idempotency, lost-response
  reconciliation, double-payment review, and checkout-disable/fulfillment-drain
  separation are unchanged.
- Independent review identified inherited custom-role default grants as a
  `TRUNCATE CASCADE` bypass of RLS and row immutability triggers. Storage now
  enumerates and revokes every actual non-owner grantee on exactly the three new
  payment tables and the new trigger function. Existing credit ACLs are preserved.
  Every PostgreSQL contract runs with hostile global and schema default grants,
  including grant options, and checks all seven table capabilities, function
  execution, actual denied SQL operations and preservation of the original ACLs.

The runtime resolver still returns `null`. Payment SQL remains an isolated
prototype and still refuses installation when SC-010 erasure inventory exists.
An independently reviewed immutable erasure inventory revision and proper
migration are explicit release blockers. This merge does not satisfy them.
There are no production schema, flags, secrets, provider calls or transactions.

Local core/HTTP/component checks and TypeScript are required for this tree.
PostgreSQL16 is unavailable in the local executor; the dedicated CI service must
run all three database variants without skips. Full Checks, built Next route
tests and independent review must pass on the new published HEAD before merge.
Exact run/SHA receipts belong in the PR; older green CI does not certify this tree.

## 2026-10-21 — checkout corrections after #129

TASK: SC-019-MVP-A2-CHECKOUT-FIXES; PARENT: #91; CONTRACT: #93.
LEVEL: L3; SCOPE: FULLSTACK; OWNER: ChatGPT / SkillCheck.
Implementation: Codex / Builder in an isolated worktree; no available Cursor
session for this new scope. Independent architecture assessment by Codex session
`/root/sc19_review`: PASS before implementation on integration
`7cc79a146a65f41ea9f463b514cff6845ec1e159`. Final code review and test receipts
must name the final HEAD/BASE in the PR; architecture PASS is not code PASS.
PRODUCTION_APPROVAL: NO. The resolver still returns null.

### A — unresolved purchases, request aliases and lifecycle

One company may have **at most one `awaiting_payment` order**, across all offers,
providers, accounts and test/live scopes. A PostgreSQL partial unique index
`sc19_payment_one_unresolved` enforces this durably. The service selects the
existing order under the established company-first SERIALIZABLE lock order.
Known request/alias/unresolved uniqueness races get bounded transaction retries;
provider network calls remain outside retried transactions.

`private.sc19_payment_requests` stores immutable `(company_id, request_id)` →
`order_id` aliases. The composite FK prevents a cross-company alias. The original
request and every accepted recovery alias are saved atomically with order
selection/creation. All aliases remain after settlement: retrying one after
`paid` returns that order, rather than accidentally starting a second purchase.
RLS, browser privilege denial and hostile-default ACL cleanup cover the alias
table as well. This is request deduplication, not another credit ledger.

A fresh request for the same buyer, immutable offer/terms and provider scope
reuses the original order, economic snapshot, deadline and provider key. A
conflicting unresolved purchase returns `SC19_PAYMENT_PURCHASE_PENDING` without
opening a second checkout. A different company has its own slot and request IDs.
Only independently verified, atomic settlement to `paid` releases the slot;
a subsequent deliberate request may then purchase again. Old aliases still
resolve to the old paid order even while the next purchase is pending.

Timeout, lost response, failed/pending notification, elapsed offer/deadline or
unavailable browser storage **never** release the slot. Existing read-only
provider reconciliation still applies after the original creation deadline.
There is deliberately no time-based deletion or cancellation shortcut. A
provider-confirmed cancellation/absence protocol, safe against a late paid
notification, is an operational dependency before LIVE; an abandoned unresolved
order can currently require support. Do not clear aliases or mark an order paid
to unblock a purchase. No automatic refund or real cancellation is introduced.

### B — one new-checkout gate, separate settlement

The service exposes its snapshotted `checkoutEnabled` result derived from
`enabled === true`, valid provider/account/mode and LIVE approval. Both HTTP
offers and checkout consult that same value; no independently computed HTTP
availability flag exists. Fulfillment still requires valid scope, signature and
provider truth, but is independent of `enabled` and `liveApproved`. Status reads
and correctly scoped existing orders remain available for settlement when new
sales are switched off. Recompose from trusted current configuration per request.

### C — server-authoritative offers and UI

The browser wall clock makes no purchase decision. The server filters the catalog
and validates new-order expiry and terms inside checkout. An existing order keeps
its immutable accepted conditions. `SC19_PAYMENT_OFFER_UNAVAILABLE` refreshes the
catalog, clears acceptance and asks the customer to review/accept again; it never
automatically retries a purchase. Manual refresh does the same. A missing/empty
catalog does not show a buy button. Session storage is a best-effort retry hint;
in-memory reuse helps the UI, while PostgreSQL protects new tabs/devices/restarts.

### Verification contract

Core/HTTP/component tests cover fresh IDs after a lost response, alias replay after
paid, concurrent fresh IDs, conflict across offer/terms/scope, post-settlement
repurchase, both directions of client-clock skew, server expiry, empty/refreshed
catalog, renewed acceptance, blocked session storage and gate parity. Real PG16
runs against final #92, final #115 and the current credit SQL; it checks distinct
concurrent requests using independent connections, direct unique-index violation,
alias FK/immutability/hostile ACLs, same request ID in two companies, rollback,
replay, immutable economics, owner/KYB revocation and disabled-checkout draining.
Existing SC-010 refusal remains tested. Typecheck, build, actual Next route/SSR
checks, current GitHub workflows/check-runs/legacy statuses and final independent
review remain mandatory. Do not interpret a skipped DB test as PASS.

### Handoff — next stage, still no activation

KONTYNUUJ SKILLCHECK — use skillcheck-orchestrator and skillcheck-builder in the
current or a new coding session. Repository krzysztofsyska/skillcheck-core,
contract #93, parent #91. First refresh this correction PR's exact HEAD, merge,
CI, review and integration base; do not redo merged #115/#129 or overlap pricing
#137/#149–151/#147. The next implementation step is the reviewed credit/payment
forward-migration plan with immutable SC-010 inventory, not activating checkout.

Work possible in the repository / disposable local environment:
1. Inventory actual migration dependencies, credit SQL and four payment tables
   (offers, orders, requests, grants), their indexes, triggers, FK, RLS and ACL.
   Design the immutable SC-010 revision for both approved legacy and R4-VOICE
   chains; never learn a trusted baseline from an arbitrary installed schema.
   Generate a forward migration via Supabase CLI after architecture review.
   Keep the existing prototype installation guard until the separately reviewed
   migration supplies the complete inventory. Test clean install and upgrade
   from mapped production-equivalent fixtures, rollback/forward repair and
   erasure/purge/restore. If historical orders exist, fail closed on unresolved
   duplicates and backfill original request aliases without changing economics.
2. Extend existing company access and operator verification, preserving immutable
   legal-entity/NIP/representative attestations, tenant isolation and audited
   revocation. No self-approval or duplicate FREE claims. Reuse the existing
   ledger and order receipt for recovery, never grant online-payment credits via
   a separate manual adjustment bypass.
3. Once the provider is approved, implement its real adapter: raw signature and
   timestamp validation, independent canonical payment retrieval, exact account/
   mode/amount/currency binding, stable idempotency, read-only session lookup and
   safe terminal cancellation/reconciliation. Add offline contract fixtures first.
   Do not select a provider or invent its API semantics in this task.
4. Assemble isolated synthetic E2E: two firms/roles → verification → FREE →
   approved redaction → screening → human review → ranking/report/quota; then
   checkout → independently verified settlement → one existing-ledger grant →
   another analysis. Include expiry, lost responses, different request IDs,
   double-submit/replay, failure/refund, restart and revoked access. Distinguish
   mock-provider E2E from an authorized provider sandbox test.

Missing decisions / environmental evidence before real use:
- Approved provider, merchant/legal entity and account ownership; price, credits,
  gross/net/VAT treatment, terms, expiry/rebuy/refund/cancellation rules and legal
  notices. Illustrative fixtures are not approval.
- Fresh read-only migration ledger/definition mapping, SC-010 inventory, grants,
  effective runtime flags and isolated environment identity. Preview is not
  presumed separate from Production. Secret names/presence and safe agreement
  checks must not expose values.
- Reviewed scoped server pool and per-request auth.getUser composition, verified
  provider test credentials and separately authorized cost/sandbox testing;
  final SC-005 worker/config/HMAC evidence and real provider E2E where required.
- Final immutable release manifest, migration/restore rehearsal and rollback
  that disables NEW purchases but preserves settlement of accepted orders.
  Separate explicit Production approval precedes main, remote migrations,
  deployments, secrets/flags or real payments. No sale is LIVE from this fix.
