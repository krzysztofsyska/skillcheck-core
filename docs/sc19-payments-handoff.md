# SC-019 A2 — payment orchestration (not LIVE)

TASK: #93, child of #91. User requires payments as part of PRESELEKCJA launch, not only a contact form. FREE never uses this paid checkout. Implemented by ChatGPT; independent Codex L3 review required.

## Implemented
`lib/sc19-payments.ts` coordinates an authenticated owner's purchase using a server-approved PLN gross-total offer, immutable price/credit/terms snapshot, persisted order before provider side effects, stable per-order provider idempotency, bound checkout session, verified provider receipt, and one transaction for payment deduplication, the existing SC-019 credit increment, and the paid order marker. It does not implement a second balance ledger. No numeric customer offer, tax rate, processor or account is selected.

No default HTTP transport, secret reads, public route, deployment or provider calls are installed by this PR. `PaymentProvider` and `PaymentStore` are required injection ports, not working integrations. The tests supply synthetic adapters only. The code must not be advertised as accepting money.

## Required adapters before activation
- A real processor adapter must authenticate the unmodified request body/signature/timestamp, pin merchant and test/live scope, and retrieve authoritative payment status. Browser success redirects never fulfill orders. Creating Checkout must use the durable order ID as the provider idempotency key; ambiguous attempts must reconcile before any new charge. The unbound order's 30-minute creation window is a safety ceiling, not a guarantee about any provider's idempotency retention. Confirm the selected provider retains keys at least that long.
- A real PostgreSQL `PaymentStore` must use transactional locking and bounded serialization retries; enforce unique `(company_id,request_id)`, scoped checkout session, and `(provider,account,mode,payment_id)` across processes. `grantOnce` must increment the EXISTING SC-019 balance using the purchased order's credits (not the mutable current policy) atomically with grant and order state. No browser-accessible grant method. Authorization and verified-company status come from current trusted DB records, never user-editable metadata.
- No SQL migration is introduced here. Before adding payment tables, reconcile #92/#115 and SC-010 inventory/signature; do not bypass erasure protection. Run actual PostgreSQL concurrent duplicate-webhook and rollback tests. In-memory tests below are not that evidence.
- Bind authenticated UI/checkout route and raw webhook route to those adapters. A notification received before session binding, failed signature check, uncertain payment result or failed transaction must NOT receive a successful processed acknowledgment. Return retryable status where appropriate; never mark an event processed before the grant transaction commits.
- An additional settled payment for an already-paid order raises `SC19_PAYMENT_DOUBLE_PAYMENT_REVIEW`: do not grant twice or discard the money silently. Operational handling of refunds, chargebacks, duplicate charges and failed fulfillment is still required before LIVE. No subscriptions or automatic refunds are implemented.
- Create the service per request using trusted activation configuration, so revoked authorization/flags are not cached indefinitely. LIVE requires independently approved merchant, amount/terms, migrations, security review and end-to-end test. No switch is enabled here.

## Evidence
Local Node 22.16 built-in test runner: 22/22 PASS, zero skipped; strict TypeScript check PASS. Tests cover authorization, tampered price, unapproved offers, duplicate events, checkout idempotency, ambiguous timeouts, session binding, merchant/mode mismatch, fake-transaction concurrency, rollback and cross-order reuse. No real PostgreSQL/processor/payment/candidate data used. GitHub CI and independent review remain separate evidence.

Official provider references used for the integration contract (not a provider selection):
- https://docs.stripe.com/checkout/fulfillment
- https://docs.stripe.com/events/manage-webhook-endpoints

## Open activation inputs
Confirmed processor/account, approved PRESELEKCJA gross price and commercial terms are not present in the verified task contract. Do not activate the illustrative 299 PLN / 60 credits as an approved sale. Do not substitute manual contact for the requested final online-payment path.
