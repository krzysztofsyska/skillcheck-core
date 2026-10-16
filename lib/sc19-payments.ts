/** SC-019 A2: server-side checkout/fulfillment orchestration; not a live payment adapter.
 * No provider, account, price or production flag is selected here.
 * Store transactions MUST be durable, serializable/retried, and atomic with SC-019 credits.
 * Provider verification MUST authenticate the raw notification and retrieve payment truth.
 */
import { randomUUID } from 'node:crypto';

export type PaymentMode = 'test' | 'live';
export type PaymentScope = Readonly<{ provider: string; account: string; mode: PaymentMode }>;
export type PaymentOffer = Readonly<{
  id: string; revision: string; plan: 'PRESELEKCJA'; active: boolean;
  approved: boolean; amountMinor: number; currency: 'PLN'; credits: number;
  termsRevision: string; validUntilMs: number;
}>;
export type PaymentOrder = Readonly<{
  id: string; companyId: string; buyerId: string; requestId: string;
  offerId: string; offerRevision: string; termsRevision: string;
  amountMinor: number; currency: 'PLN'; credits: number; scope: PaymentScope;
  status: 'awaiting_payment' | 'paid'; sessionId: string | null;
  checkoutUrl: string | null; paymentId: string | null; checkoutDeadlineMs: number;
}>;
export type HostedCheckout = Readonly<{
  orderId: string; sessionId: string; url: string; scope: PaymentScope;
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
   * unique(company_id,request_id), row locks and bounded serialization retries.
   */
  transaction<T>(work: (tx: PaymentTransaction) => Promise<T>): Promise<T>;
}
export interface PaymentProvider {
  /** Reuse the exact same idempotency key for retries after timeout/restart.
   * Must refuse reuse after the provider's deduplication window expires unless
   * the original session is positively reconciled. Never create a second charge.
   */
  createCheckout(order: PaymentOrder, idempotencyKey: string): Promise<HostedCheckout>;
  /** Verify raw-body signature, timestamp and merchant scope; retrieve canonical
   * payment state. Return null only for authenticated, irrelevant event types.
   * Throw on missing/invalid verification or uncertain provider response.
   * Do not accept a success redirect, browser JSON or screenshot as evidence.
   */
  verifyAndRetrieve(rawBody: Uint8Array, signature: string): Promise<VerifiedPayment | null>;
}
export type PaymentDependencies = Readonly<{
  store: PaymentStore; provider: PaymentProvider;
  /** Must resolve an authenticated server-side user, not an ID in a request. */
  authenticate(): Promise<{ userId: string } | null>;
  scope: PaymentScope; checkoutOrigins: readonly string[];
  enabled: boolean; liveApproved: boolean;
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
  return !!offer && offer.id === id && offer.plan === 'PRESELEKCJA' && offer.approved === true &&
    offer.active === true && offer.currency === 'PLN' && money(offer.amountMinor) &&
    Number.isSafeInteger(offer.credits) && offer.credits >= 1 && offer.credits <= 100_000 &&
    stringId(offer.revision) && offer.termsRevision === terms && stringId(offer.termsRevision) &&
    Number.isSafeInteger(offer.validUntilMs) && offer.validUntilMs > Date.now();
}

export function createSc19Payments(deps: PaymentDependencies) {
  // Snapshot activation and allowlist inputs so later mutation cannot enable LIVE.
  const scope = Object.freeze(clone(deps.scope));
  const origins = Object.freeze([...deps.checkoutOrigins]);
  const active = deps.enabled === true;
  const liveApproved = deps.liveApproved === true;
  const gate = () => {
    if (!active || !validScope(scope) || (scope.mode === 'live' && !liveApproved))
      deny('SC19_PAYMENTS_DISABLED');
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

  async function checkout(input: unknown): Promise<HostedCheckout | { orderId: string; paid: true }> {
    gate();
    const req = clone(input);
    if (!exact(req, ['companyId', 'offerId', 'requestId', 'termsRevision']) ||
        typeof req.companyId !== 'string' || !uuid.test(req.companyId) ||
        typeof req.requestId !== 'string' || !uuid.test(req.requestId) ||
        !stringId(req.offerId) || !stringId(req.termsRevision)) return deny('SC19_PAYMENT_INVALID');
    const companyId = req.companyId, requestId = req.requestId;
    const offerId = req.offerId, terms = req.termsRevision;
    const auth = await deps.authenticate();
    if (!auth || typeof auth.userId !== 'string' || !uuid.test(auth.userId)) return deny('SC19_PAYMENT_FORBIDDEN');
    const userId = auth.userId;
    const order = await deps.store.transaction(async tx => {
      const access = await tx.companyAccess(companyId, userId);
      if (access.owner !== true || access.verified !== true) return deny('SC19_PAYMENT_FORBIDDEN');
      const previous = await tx.orderByRequest(companyId, requestId);
      if (previous) {
        requireOrderScope(previous);
        if (previous.buyerId !== userId || previous.offerId !== offerId || previous.termsRevision !== terms)
          return deny('SC19_PAYMENT_REQUEST_CONFLICT');
        return clone(previous);
      }
      const offer = clone(await tx.offer(offerId));
      if (!offerValid(offer, offerId, terms)) return deny('SC19_PAYMENT_OFFER_UNAVAILABLE');
      const created: PaymentOrder = Object.freeze({
        id: randomUUID(), companyId, buyerId: userId, requestId, offerId,
        offerRevision: offer.revision, termsRevision: offer.termsRevision,
        amountMinor: offer.amountMinor, currency: 'PLN', credits: offer.credits,
        scope, status: 'awaiting_payment', sessionId: null, checkoutUrl: null, paymentId: null,
        checkoutDeadlineMs: Math.min(offer.validUntilMs, Date.now() + 30 * 60_000),
      });
      await tx.insertOrder(created);
      return created;
    });
    if (order.status === 'paid') return { orderId: order.id, paid: true };
    if (order.sessionId && order.checkoutUrl) {
      if (!safeCheckoutUrl(order.checkoutUrl)) return deny('SC19_PAYMENT_CHECKOUT_INVALID');
      return { orderId: order.id, sessionId: order.sessionId, url: order.checkoutUrl, scope };
    }
    if (Date.now() >= order.checkoutDeadlineMs) return deny('SC19_PAYMENT_RECONCILIATION_REQUIRED');
    // Persist the order before the external side effect. No automatic new key/retry.
    const hosted = clone(await deps.provider.createCheckout(clone(order), `sc19:${order.id}`));
    if (!hosted || hosted.orderId !== order.id || !stringId(hosted.sessionId) ||
        !sameScope(hosted.scope, scope) || !safeCheckoutUrl(hosted.url)) return deny('SC19_PAYMENT_CHECKOUT_INVALID');
    return deps.store.transaction(async tx => {
      const current = await tx.order(order.id);
      if (!current) return deny('SC19_PAYMENT_ORDER_MISSING');
      requireOrderScope(current);
      // Recheck authorization after the provider round trip.
      const access = await tx.companyAccess(companyId, userId);
      if (access.owner !== true || access.verified !== true) return deny('SC19_PAYMENT_FORBIDDEN');
      if (current.sessionId !== null && current.sessionId !== hosted.sessionId)
        return deny('SC19_PAYMENT_SESSION_CONFLICT');
      if (current.status === 'paid') return { orderId: current.id, paid: true as const };
      await tx.saveOrder({ ...current, sessionId: hosted.sessionId, checkoutUrl: hosted.url });
      return hosted;
    });
  }

  async function notification(raw: Uint8Array, signature: string) {
    gate();
    if (!(raw instanceof Uint8Array) || raw.byteLength === 0 || raw.byteLength > 262144 ||
        typeof signature !== 'string' || signature.length === 0 || signature.length > 8192)
      return deny('SC19_PAYMENT_NOTIFICATION_INVALID');
    const payment = clone(await deps.provider.verifyAndRetrieve(new Uint8Array(raw), signature));
    if (payment === null) return { state: 'ignored' as const };
    if (!payment || !sameScope(payment.scope, scope) || !stringId(payment.eventId) ||
        !stringId(payment.sessionId) || !stringId(payment.paymentId) ||
        typeof payment.orderId !== 'string' || !uuid.test(payment.orderId) ||
        !money(payment.amountMinor) || payment.currency !== 'PLN' ||
        !['paid', 'pending', 'failed'].includes(payment.status)) return deny('SC19_PAYMENT_NOTIFICATION_INVALID');
    if (payment.status !== 'paid') return { state: 'not_paid' as const };
    return deps.store.transaction(async tx => {
      const order = await tx.order(payment.orderId);
      if (!order) return deny('SC19_PAYMENT_ORDER_MISSING');
      requireOrderScope(order);
      if (!order.sessionId) return deny('SC19_PAYMENT_SESSION_NOT_BOUND'); // Retry, never acknowledge as processed.
      if (order.sessionId !== payment.sessionId || order.amountMinor !== payment.amountMinor ||
          order.currency !== payment.currency) return deny('SC19_PAYMENT_ORDER_MISMATCH');
      if (order.status === 'paid') {
        if (order.paymentId !== payment.paymentId) return deny('SC19_PAYMENT_DOUBLE_PAYMENT_REVIEW');
        return { state: 'already_applied' as const, orderId: order.id };
      }
      // Collision-free tuple encoding; event IDs alone do not deduplicate payments.
      const key = JSON.stringify([scope.provider, scope.account, scope.mode, payment.paymentId]);
      const previouslyGrantedTo = await tx.grantOnce(key, order);
      if (previouslyGrantedTo !== null && previouslyGrantedTo !== order.id)
        return deny('SC19_PAYMENT_REUSED');
      await tx.saveOrder({ ...order, status: 'paid', paymentId: payment.paymentId });
      return { state: previouslyGrantedTo === null ? 'applied' as const : 'already_applied' as const, orderId: order.id };
    });
  }
  return Object.freeze({ checkout, notification });
}
