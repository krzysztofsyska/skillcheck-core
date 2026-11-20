/** SC-019 A2: server-side checkout/fulfillment orchestration; not a live payment adapter.
 * No provider, account, price or production flag is selected here.
 * Store transactions MUST be durable, serializable/retried, and atomic with SC-019 credits.
 * Provider verification MUST authenticate the raw notification and retrieve payment truth.
 */
import { randomUUID } from 'node:crypto';
import { MAX_PACKAGES, STRIPE_CATALOG, isStripePackageCode, type StripePackageCode } from './stripe-catalog.ts';

export type PaymentMode = 'test' | 'live';
export type PaymentScope = Readonly<{ provider: string; account: string; mode: PaymentMode }>;
export type PaymentOffer = Readonly<{
  /** The package the offer sells. Database offers (private.sc19_payment_offers) are
   * PRESELEKCJA only; WERYFIKACJA and ASSESSMENT_CENTER offers exist only in the
   * Stripe runtime (lib/sc19-stripe-packages.ts). */
  id: string; revision: string; plan: StripePackageCode; active: boolean;
  approved: boolean; amountMinor: number; currency: 'PLN'; credits: number;
  termsRevision: string; validUntilMs: number;
}>;
export type PaymentOrder = Readonly<{
  id: string; companyId: string; buyerId: string; requestId: string;
  offerId: string; offerRevision: string; termsRevision: string;
  amountMinor: number; currency: 'PLN'; credits: number; scope: PaymentScope;
  status: 'awaiting_payment' | 'paid'; sessionId: string | null;
  checkoutUrl: string | null; paymentId: string | null; checkoutDeadlineMs: number;
  /** R7: set only for a package other than PRESELEKCJA (absent = PRESELEKCJA, the
   * pre-R7 shape every existing order row has). */
  packageCode?: Exclude<StripePackageCode, 'PRESELEKCJA'>;
}>;
/** The package an order holds; orders without the field are PRESELEKCJA. */
export const orderPackage = (order: Pick<PaymentOrder, 'packageCode'>): StripePackageCode => order.packageCode ?? 'PRESELEKCJA';
export type HostedCheckout = Readonly<{
  orderId: string; sessionId: string; url: string; scope: PaymentScope;
  /** Canonical provider-confirmed gross charge, inclusive of any tax/discount. */
  amountMinor: number; currency: 'PLN'; paymentKind: 'one_time';
}>;
export type VerifiedPayment = Readonly<{
  eventId: string; orderId: string; sessionId: string; paymentId: string;
  scope: PaymentScope; amountMinor: number; currency: string;
  status: 'paid' | 'pending' | 'failed';
}>;
export interface PaymentTransaction {
  /** Fresh DB authorization under the transaction, never browser/JWT user_metadata. */
  companyAccess(companyId: string, userId: string): Promise<{ owner: boolean; verified: boolean }>;
  /** Lock the offer and enforce immutable economic revisions in persistent storage. */
  offer(id: string): Promise<PaymentOffer | null>;
  orderByRequest(companyId: string, requestId: string): Promise<PaymentOrder | null>;
  /** At most one unresolved purchase per company, across offers and scopes. An
   * unpaid order of a retired provider (Przelewy24, whose settlement was removed)
   * can never be paid and is not returned; it stays stored and never grants. */
  unresolvedOrder(companyId: string): Promise<PaymentOrder | null>;
  /** Immutable request alias, committed atomically with selecting/creating the order. */
  bindRequest(companyId: string, requestId: string, orderId: string): Promise<void>;
  /** Lock row before mutation. Tenant must also be checked on authenticated reads. */
  order(id: string): Promise<PaymentOrder | null>;
  insertOrder(order: PaymentOrder): Promise<void>;
  saveOrder(order: PaymentOrder): Promise<void>;
  /** Unique on (provider, account, mode, paymentId), not just the webhook event ID.
   * Grant the ORDER's snapshotted credits, not today's catalog amount.
   * Return existing order ID on duplicate payment; otherwise insert grant AND
   * increment the existing SC-019 balance inside this SAME transaction.
   */
  grantOnce(key: string, order: PaymentOrder): Promise<string | null>;
}
export interface PaymentStore {
  /** Commit all writes on success; rollback ALL writes on any error. Implement
   * unique(company_id,request_id), one awaiting_payment per company (an order
   * past its deadline without a provider session is reopened, never replaced),
   * immutable request aliases, row locks and bounded serialization retries.
   */
  transaction<T>(work: (tx: PaymentTransaction) => Promise<T>): Promise<T>;
}
export interface PaymentProvider {
  /** Reuse the exact same idempotency key for retries after timeout/restart.
   * Never create a second charge. After the order's checkout deadline this is
   * called again only when lookupCheckout's session read answered "not found"
   * for the key AND the order's exact offer revision is still on sale; the key
   * (and the provider session derived from the order id) is the same, so it is
   * the one registration that never happened, not a new charge. Even if that
   * read were wrong, a second URL can never be bound or returned: bindHosted
   * refuses it with SC19_PAYMENT_SESSION_CONFLICT.
   */
  createCheckout(order: PaymentOrder, idempotencyKey: string): Promise<HostedCheckout>;
  /** READ ONLY: find the original provider session by durable order/key.
   * Return null only on provider-confirmed absence, throw on uncertainty.
   * Never create a new payment during reconciliation. Both operations MUST
   * return canonical charge economics: exact gross PLN and one-time payment.
   * Real adapters must reject automatic tax, discounts and subscriptions
   * that differ from the immutable snapshotted order.
   */
  lookupCheckout(order: PaymentOrder, idempotencyKey: string): Promise<HostedCheckout | null>;
  /** Verify raw-body signature, timestamp and merchant scope; retrieve canonical
   * payment state. Return null only for authenticated, irrelevant event types.
   * Throw on missing/invalid verification or uncertain provider response.
   * Do not accept a success redirect, browser JSON or screenshot as evidence.
   */
  readSettlement?(order: PaymentOrder): Promise<VerifiedPayment | null>;
  /** OPTIONAL, READ ONLY: true only when the provider confirms the order's stored
   * session has expired and can never be paid (Stripe Checkout: status=expired).
   * The stored link is then not returned. Throw on any uncertainty. */
  expiredSession?(order: PaymentOrder): Promise<boolean>;
  verifyAndRetrieve(rawBody: Uint8Array, signature: string): Promise<VerifiedPayment | null>;
}
export type PaymentDependencies = Readonly<{
  store: PaymentStore; provider: PaymentProvider;
  /** Must resolve an authenticated server-side user, not an ID in a request. */
  authenticate(): Promise<{ userId: string } | null>;
  scope: PaymentScope; checkoutOrigins: readonly string[];
  enabled: boolean; liveApproved: boolean;
  /** R7: the ONE call site for work that follows a granted package (the VAT
   * invoice will hook in here). Runs after the grant has committed, only for the
   * delivery that actually applied it (never for a duplicate). It must never undo
   * the grant: a failure is logged by a fixed code and the grant stays. */
  onPaid?(order: PaymentOrder): Promise<void>;
}>;
export class Sc19PaymentError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
const deny = (code: string): never => { throw new Sc19PaymentError(code); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const opaque = /^[A-Za-z0-9][A-Za-z0-9_.:-]{1,159}$/;
function stringId(value: unknown): value is string { return typeof value === 'string' && opaque.test(value); }
function validScope(s: PaymentScope): boolean {
  return !!s && stringId(s.provider) && stringId(s.account) && (s.mode === 'test' || s.mode === 'live');
}
function sameScope(a: PaymentScope, b: PaymentScope): boolean {
  return validScope(a) && validScope(b) && a.provider === b.provider && a.account === b.account && a.mode === b.mode;
}
function clone<T>(input: T): T { try { return structuredClone(input); } catch { return deny('SC19_PAYMENT_INVALID'); } }
function exact(input: unknown, keys: readonly string[]): input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const proto = Object.getPrototypeOf(input);
  return (proto === Object.prototype || proto === null) && Reflect.ownKeys(input).length === keys.length &&
    Reflect.ownKeys(input).every(k => typeof k === 'string' && keys.includes(k));
}
function money(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 100_000_000;
}
function offerValid(offer: PaymentOffer | null, id: string, terms: string): offer is PaymentOffer {
  return !!offer && offer.id === id && isStripePackageCode(offer.plan) && STRIPE_CATALOG[offer.plan].available &&
    offer.approved === true &&
    offer.active === true && offer.currency === 'PLN' && money(offer.amountMinor) &&
    Number.isSafeInteger(offer.credits) && offer.credits >= 1 && offer.credits <= 100_000 &&
    stringId(offer.revision) && offer.termsRevision === terms && stringId(offer.termsRevision) &&
    Number.isSafeInteger(offer.validUntilMs) && offer.validUntilMs > Date.now();
}

/** How many whole packages of `offer` the order holds, or null when its amount and
 * credits are not the same whole multiple of the offer (a changed price). */
function packagesOf(offer: PaymentOffer, order: PaymentOrder): number | null {
  const n = order.credits / offer.credits;
  return orderPackage(order) === offer.plan &&
    Number.isSafeInteger(n) && n >= 1 && n <= Math.min(MAX_PACKAGES, STRIPE_CATALOG[offer.plan].maxPackages) &&
    order.credits === offer.credits * n && order.amountMinor === offer.amountMinor * n ? n : null;
}
/** Optional R7 purchase fields. `packages` = whole packages (default 1, the
 * pre-R7 behaviour); `packageCode` must name the offer's package (checked against
 * the offer below). A catalog package that is not on sale („wkrótce”) is refused
 * with its own code; more packages than the package allows is invalid. */
function purchaseShape(req: Record<string, unknown>): { packages: number | null; packageCode: StripePackageCode | null } {
  let packageCode: StripePackageCode | null = null;
  if ('packageCode' in req) {
    if (!isStripePackageCode(req.packageCode)) return deny('SC19_PAYMENT_INVALID');
    if (!STRIPE_CATALOG[req.packageCode].available) return deny('SC19_PAYMENT_PACKAGE_UNAVAILABLE');
    packageCode = req.packageCode;
  }
  if (!('packages' in req)) return { packages: null, packageCode };
  const limit = Math.min(MAX_PACKAGES, STRIPE_CATALOG[packageCode ?? 'PRESELEKCJA'].maxPackages);
  if (!Number.isSafeInteger(req.packages) || Number(req.packages) < 1 || Number(req.packages) > limit)
    return deny('SC19_PAYMENT_INVALID');
  return { packages: Number(req.packages), packageCode };
}
const requiredKeys = ['companyId', 'offerId', 'requestId', 'termsRevision'] as const;
function checkoutShape(input: unknown): input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const optional = ['packages', 'packageCode'].filter(k => Object.prototype.hasOwnProperty.call(input, k));
  return exact(input, [...requiredKeys, ...optional]);
}

export function createSc19Payments(deps: PaymentDependencies) {
  // Snapshot activation and allowlist inputs so later mutation cannot enable LIVE.
  const scope = Object.freeze(clone(deps.scope));
  const origins = Object.freeze([...deps.checkoutOrigins]);
  const active = deps.enabled === true;
  const liveApproved = deps.liveApproved === true;
  const checkoutEnabled = active && validScope(scope) && (scope.mode !== 'live' || liveApproved);
  const checkoutGate = () => {
    if (!checkoutEnabled) deny('SC19_PAYMENTS_DISABLED');
  };
  // Disabling new checkouts must NOT strand an existing paid checkout. Verified
  // receipts for previously created, correctly scoped orders continue settling.
  const fulfillmentGate = () => {
    if (!validScope(scope)) deny('SC19_PAYMENTS_DISABLED');
  };
  const safeCheckoutUrl = (text: string): boolean => {
    try {
      const url = new URL(text);
      return typeof text === 'string' && text.length <= 4096 && url.protocol === 'https:' &&
        url.username === '' && url.password === '' && url.hash === '' &&
        origins.includes(url.origin);
    } catch { return false; }
  };
  const requireOrderScope = (order: PaymentOrder) => {
    if (!sameScope(order.scope, scope)) deny('SC19_PAYMENT_SCOPE_MISMATCH');
  };
  const checkoutKey = (order: PaymentOrder) => `sc19:${order.id}`;
  const validateHosted = (order: PaymentOrder, hosted: HostedCheckout): HostedCheckout => {
    // Do not expose a URL without provider-authoritative one-time charge data.
    if (!hosted || hosted.orderId !== order.id || !stringId(hosted.sessionId) ||
        !sameScope(hosted.scope, order.scope) || !safeCheckoutUrl(hosted.url) ||
        !money(hosted.amountMinor) || hosted.amountMinor !== order.amountMinor ||
        hosted.currency !== order.currency || hosted.paymentKind !== 'one_time')
      return deny('SC19_PAYMENT_CHECKOUT_INVALID');
    return hosted;
  };
  async function bindHosted(order: PaymentOrder, hosted: HostedCheckout, userId?: string) {
    return deps.store.transaction(async tx => {
      const current = await tx.order(order.id);
      if (!current) return deny('SC19_PAYMENT_ORDER_MISSING');
      requireOrderScope(current);
      validateHosted(current, hosted);
      // A signed webhook can reconcile without a user; customer checkout still
      // checks CURRENT owner/verified-company authorization after the round trip.
      if (userId !== undefined) {
        const access = await tx.companyAccess(current.companyId, userId);
        if (access.owner !== true || access.verified !== true ||
            current.buyerId !== userId) return deny('SC19_PAYMENT_FORBIDDEN');
      }
      if (current.sessionId !== null && current.sessionId !== hosted.sessionId)
        return deny('SC19_PAYMENT_SESSION_CONFLICT');
      if (current.checkoutUrl !== null && current.checkoutUrl !== hosted.url)
        return deny('SC19_PAYMENT_SESSION_CONFLICT');
      if (current.status === 'paid') return { orderId: current.id, paid: true as const };
      if (current.sessionId === null || current.checkoutUrl === null)
        await tx.saveOrder({ ...current, sessionId: hosted.sessionId, checkoutUrl: hosted.url });
      return hosted;
    });
  }
  async function reconcileSession(order: PaymentOrder, userId?: string) {
    // SAFE even after provider idempotency expiry: no payment creation here.
    const found = clone(await deps.provider.lookupCheckout(clone(order), checkoutKey(order)));
    return found === null ? null : bindHosted(order, validateHosted(order, found), userId);
  }
  const storedCheckout = (order: PaymentOrder): HostedCheckout => {
    if (!order.sessionId || !order.checkoutUrl || !safeCheckoutUrl(order.checkoutUrl))
      return deny('SC19_PAYMENT_CHECKOUT_INVALID');
    return { orderId: order.id, sessionId: order.sessionId, url: order.checkoutUrl,
      scope, amountMinor: order.amountMinor, currency: order.currency,
      paymentKind: 'one_time' as const };
  };
  /** Past the deadline, the provider's session read answered "not found" for this
   * order's key (lookupCheckout throws on any uncertainty). The provider session
   * id is derived from the order id, so registering now is the very same
   * registration that never happened: any payment stays attributable to this one
   * order, and the customer pays the exact snapshot they accepted, only while
   * that offer revision is still on sale. Even if that read were wrong, a second
   * URL can never be bound or returned: bindHosted refuses it with
   * SC19_PAYMENT_SESSION_CONFLICT. Re-checked under the row lock; no provider I/O
   * inside the transaction.
   * An order that already HAS a stored link is returned without an offer re-check
   * (storedCheckout). With timeLimit 0 that link stays payable at its snapshot
   * price after the offer ends. Accepted for the Sandbox; the owner decides
   * before any live use. */
  async function reopenAbsentSession(order: PaymentOrder, userId: string):
      Promise<HostedCheckout | { orderId: string; paid: true } | { reopen: PaymentOrder }> {
    return deps.store.transaction(async tx => {
      const current = await tx.order(order.id);
      if (!current) return deny('SC19_PAYMENT_RECONCILIATION_REQUIRED');
      requireOrderScope(current);
      const access = await tx.companyAccess(current.companyId, userId);
      if (access.owner !== true || access.verified !== true ||
          current.buyerId !== userId) return deny('SC19_PAYMENT_FORBIDDEN');
      if (current.status === 'paid') return { orderId: current.id, paid: true as const };
      if (current.status !== 'awaiting_payment') return deny('SC19_PAYMENT_RECONCILIATION_REQUIRED');
      if (current.sessionId && current.checkoutUrl) return storedCheckout(current);
      if (current.sessionId !== null || current.checkoutUrl !== null)
        return deny('SC19_PAYMENT_RECONCILIATION_REQUIRED');
      const offer = clone(await tx.offer(current.offerId));
      if (!offerValid(offer, current.offerId, current.termsRevision) ||
          offer.revision !== current.offerRevision || packagesOf(offer, current) === null)
        return deny('SC19_PAYMENT_RECONCILIATION_REQUIRED');
      return { reopen: clone(current) };
    });
  }

  async function checkout(input: unknown): Promise<HostedCheckout | { orderId: string; paid: true }> {
    checkoutGate();
    const req = clone(input);
    if (!checkoutShape(req) ||
        typeof req.companyId !== 'string' || !uuid.test(req.companyId) ||
        typeof req.requestId !== 'string' || !uuid.test(req.requestId) ||
        !stringId(req.offerId) || !stringId(req.termsRevision)) return deny('SC19_PAYMENT_INVALID');
    const companyId = req.companyId, requestId = req.requestId;
    const offerId = req.offerId, terms = req.termsRevision;
    const { packages, packageCode } = purchaseShape(req);
    // With explicit packages, an existing order counts as "the same purchase" only
    // when it holds exactly that many whole packages of its own offer revision.
    // A named package must be the existing order's package.
    const samePackages = async (tx: PaymentTransaction, existing: PaymentOrder) => {
      if (packageCode !== null && orderPackage(existing) !== packageCode) return false;
      if (packages === null) return true;
      const offer = await tx.offer(existing.offerId);
      return !!offer && offer.revision === existing.offerRevision && packagesOf(offer, existing) === packages;
    };
    const auth = await deps.authenticate();
    if (!auth || typeof auth.userId !== 'string' || !uuid.test(auth.userId)) return deny('SC19_PAYMENT_FORBIDDEN');
    const userId = auth.userId;
    const order = await deps.store.transaction(async tx => {
      const access = await tx.companyAccess(companyId, userId);
      if (access.owner !== true || access.verified !== true) return deny('SC19_PAYMENT_FORBIDDEN');
      const previous = await tx.orderByRequest(companyId, requestId);
      if (previous) {
        requireOrderScope(previous);
        if (previous.buyerId !== userId || previous.offerId !== offerId || previous.termsRevision !== terms ||
            !(await samePackages(tx, previous)))
          return deny('SC19_PAYMENT_REQUEST_CONFLICT');
        return clone(previous);
      }
      // Browser IDs are only retry aliases, never permission to open another
      // unresolved purchase. Keep the original economics and provider key even
      // after a lost response, storage eviction, new device or service restart.
      const pending = await tx.unresolvedOrder(companyId);
      if (pending) {
        if (!sameScope(pending.scope, scope) || pending.buyerId !== userId ||
            pending.offerId !== offerId || pending.termsRevision !== terms ||
            !(await samePackages(tx, pending)))
          return deny('SC19_PAYMENT_PURCHASE_PENDING');
        await tx.bindRequest(companyId, requestId, pending.id);
        return clone(pending);
      }
      const offer = clone(await tx.offer(offerId));
      if (!offerValid(offer, offerId, terms)) return deny('SC19_PAYMENT_OFFER_UNAVAILABLE');
      // The named package must be the offer's; an unnamed purchase is PRESELEKCJA only
      // (the pre-R7 request shape), so another package is never bought by accident.
      if ((packageCode ?? 'PRESELEKCJA') !== offer.plan) return deny('SC19_PAYMENT_INVALID');
      const units = packages ?? 1;
      if (units > STRIPE_CATALOG[offer.plan].maxPackages) return deny('SC19_PAYMENT_INVALID');
      const created: PaymentOrder = Object.freeze({
        id: randomUUID(), companyId, buyerId: userId, requestId, offerId,
        offerRevision: offer.revision, termsRevision: offer.termsRevision,
        amountMinor: offer.amountMinor * units, currency: 'PLN', credits: offer.credits * units,
        scope, status: 'awaiting_payment', sessionId: null, checkoutUrl: null, paymentId: null,
        checkoutDeadlineMs: Math.min(offer.validUntilMs, Date.now() + 30 * 60_000),
        ...(offer.plan === 'PRESELEKCJA' ? {} : { packageCode: offer.plan }),
      });
      await tx.insertOrder(created);
      await tx.bindRequest(companyId, requestId, created.id);
      return created;
    });
    if (order.status === 'paid') return { orderId: order.id, paid: true };
    if (order.sessionId && order.checkoutUrl) {
      // A provider-confirmed expired session can never be paid. The order row keeps
      // its session for good (trigger sc19_order_immutable), so the buyer gets the
      // reconciliation answer instead of a dead payment link. Releasing such an
      // order needs an owner-approved schema change (see PR #556, KNOWN ISSUES).
      if (deps.provider.expiredSession && await deps.provider.expiredSession(clone(order)))
        return deny('SC19_PAYMENT_RECONCILIATION_REQUIRED');
      return storedCheckout(order);
    }
    let pending = order;
    if (Date.now() >= order.checkoutDeadlineMs) {
      const recovered = await reconcileSession(order, userId);
      if (recovered) return recovered;
      const reopened = await reopenAbsentSession(order, userId);
      if (!('reopen' in reopened)) return reopened;
      pending = reopened.reopen;
    }
    // Durable order exists before the external call; retry with SAME key only.
    const hosted = validateHosted(pending,
      clone(await deps.provider.createCheckout(clone(pending), checkoutKey(pending))));
    return bindHosted(pending, hosted, userId);
  }

  async function notification(raw: Uint8Array, signature: string) {
    fulfillmentGate();
    if (!(raw instanceof Uint8Array) || raw.byteLength === 0 || raw.byteLength > 262144 ||
        typeof signature !== 'string' || signature.length === 0 || signature.length > 8192)
      return deny('SC19_PAYMENT_NOTIFICATION_INVALID');
    const result = await applySettlement(clone(await deps.provider.verifyAndRetrieve(new Uint8Array(raw), signature)));
    if (result.state === 'applied') await afterPaid(result.orderId);
    return result;
  }

  /** Post-grant hook (see PaymentDependencies.onPaid). The grant has committed;
   * nothing here can roll it back, and the webhook is still acknowledged. */
  async function afterPaid(orderId: string) {
    if (!deps.onPaid) return;
    try {
      const order = await deps.store.transaction(tx => tx.order(orderId));
      if (order && order.status === 'paid') await deps.onPaid(clone(order));
    } catch { console.error('SC19_PAYMENT_AFTER_PAID_FAILED'); }
  }

  // Called only after the HTTP handler has authorized a read of THIS order.
  async function refreshSettlement(order: PaymentOrder) {
    fulfillmentGate();
    requireOrderScope(order);
    if (!deps.provider.readSettlement || !order.sessionId) return;
    const payment = await deps.provider.readSettlement(order);
    if (payment && (payment.orderId !== order.id || payment.sessionId !== order.sessionId))
      return deny('SC19_PAYMENT_ORDER_MISMATCH');
    await applySettlement(payment);
  }

  async function applySettlement(payment: VerifiedPayment | null) {
    if (payment === null) return { state: 'ignored' as const };
    if (!payment || !sameScope(payment.scope, scope) || !stringId(payment.eventId) ||
        !stringId(payment.sessionId) || !stringId(payment.paymentId) ||
        typeof payment.orderId !== 'string' || !uuid.test(payment.orderId) ||
        !money(payment.amountMinor) || payment.currency !== 'PLN' ||
        !['paid', 'pending', 'failed'].includes(payment.status)) return deny('SC19_PAYMENT_NOTIFICATION_INVALID');
    if (payment.status !== 'paid') return { state: 'not_paid' as const };
    // Lost createCheckout response: first re-bind the independently verified
    // original checkout, never trust a webhook-supplied session by itself.
    const before = await deps.store.transaction(tx => tx.order(payment.orderId));
    if (!before) return deny('SC19_PAYMENT_ORDER_MISSING');
    requireOrderScope(before);
    if (!before.sessionId) {
      const recovered = await reconcileSession(before);
      if (recovered === null) return deny('SC19_PAYMENT_SESSION_NOT_BOUND');
    }
    return deps.store.transaction(async tx => {
      const order = await tx.order(payment.orderId);
      if (!order) return deny('SC19_PAYMENT_ORDER_MISSING');
      requireOrderScope(order);
      // A second actual payment needs a refund/review even with a NEW session.
      if (order.status === 'paid' && order.paymentId !== payment.paymentId)
        return deny('SC19_PAYMENT_DOUBLE_PAYMENT_REVIEW');
      if (!order.sessionId) return deny('SC19_PAYMENT_SESSION_NOT_BOUND');
      if (order.sessionId !== payment.sessionId || order.amountMinor !== payment.amountMinor ||
          order.currency !== payment.currency) return deny('SC19_PAYMENT_ORDER_MISMATCH');
      if (order.status === 'paid')
        return { state: 'already_applied' as const, orderId: order.id };
      // Collision-free tuple encoding; event IDs alone do not deduplicate payments.
      const key = JSON.stringify([scope.provider, scope.account, scope.mode, payment.paymentId]);
      const previouslyGrantedTo = await tx.grantOnce(key, order);
      if (previouslyGrantedTo !== null && previouslyGrantedTo !== order.id)
        return deny('SC19_PAYMENT_REUSED');
      await tx.saveOrder({ ...order, status: 'paid', paymentId: payment.paymentId });
      return { state: previouslyGrantedTo === null ? 'applied' as const : 'already_applied' as const, orderId: order.id };
    });
  }
  return Object.freeze({ checkout, notification, refreshSettlement, checkoutEnabled });
}
