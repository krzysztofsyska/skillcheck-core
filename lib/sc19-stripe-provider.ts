/** R7: Stripe Checkout adapter for the SC-019 payment orchestration (lib/sc19-payments.ts).
 *
 * Hosted Stripe Checkout page, mode=payment, PLN. The package is granted ONLY by
 * the orchestration after a signed `checkout.session.completed` whose session,
 * re-read from the Stripe API, is paid and matches the stored order. A signed
 * `checkout.session.expired` whose session the API confirms expired unpaid closes
 * the order bound to that session without any grant (R7). Every other
 * event type, and every event of another application on the same Stripe account
 * (metadata.app != "skillcheck-core"), is acknowledged with no action.
 *
 * Keys come only from the caller (environment); this module never logs a key,
 * a buyer's e-mail or NIP, or a Stripe response body. Failures are logged as a
 * fixed code plus the HTTP status and Stripe's own error code.
 *
 * No Stripe invoices: invoices will be issued from Fakturownia through the single
 * post-grant hook PaymentDependencies.onPaid (a later R7 step).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { HostedCheckout, PaymentMode, PaymentOrder, PaymentProvider, PaymentScope, VerifiedPayment } from './sc19-payments.ts';
import { Sc19PaymentError, orderPackage } from './sc19-payments.ts';
import { STRIPE_APP, STRIPE_CATALOG, stripeLookupKey, stripeQuote, type StripePackageCode } from './stripe-catalog.ts';

export const STRIPE_API = 'https://api.stripe.com';
export const STRIPE_CHECKOUT_ORIGIN = 'https://checkout.stripe.com';
/** Pinned API version: the same one skillcheck-preselekcja uses on this account
 * (stripe-node 23.1.0), so request and response shapes do not follow the account default. */
export const STRIPE_API_VERSION = '2026-10-28.endive';
/** Seconds a signed webhook stays acceptable (Stripe's own default tolerance). */
export const STRIPE_SIGNATURE_TOLERANCE_S = 300;

/** Mode from the key itself: sk_/rk_ + live/test. Anything else is no key at all. */
export function stripeModeOf(key: string | undefined): PaymentMode | null {
  if (typeof key !== 'string') return null;
  if (/^(sk|rk)_live_[A-Za-z0-9]{16,}$/.test(key)) return 'live';
  if (/^(sk|rk)_test_[A-Za-z0-9]{16,}$/.test(key)) return 'test';
  return null;
}

/** Brand of the core site (app/globals.css: buttons #204bba on #f5f7fa). Images in public/brand. */
export const STRIPE_BRAND = Object.freeze({
  displayName: 'SkillCheck', buttonColor: '#204bba', backgroundColor: '#f5f7fa',
  logoPath: '/brand/stripe-logo.png', iconPath: '/brand/stripe-icon.png',
});
export function stripeBranding(origin: string) {
  return { display_name: STRIPE_BRAND.displayName, button_color: STRIPE_BRAND.buttonColor,
    background_color: STRIPE_BRAND.backgroundColor, border_style: 'rounded',
    logo: { type: 'url', url: origin + STRIPE_BRAND.logoPath },
    icon: { type: 'url', url: origin + STRIPE_BRAND.iconPath } };
}
/** Legal links shown next to the pay button (core pages /regulamin and /polityka-prywatnosci). */
export function stripeLegalText(origin: string) {
  return `Płacąc, zamawiasz pakiet zgodnie z [Regulaminem](${origin}/regulamin). ` +
    `Dane przetwarzamy zgodnie z [Polityką prywatności](${origin}/polityka-prywatnosci).`;
}

/** Stripe-Signature check: HMAC-SHA256 of "<t>.<raw body>" with the endpoint
 * secret, any of the v1 entries, timestamp within the tolerance. Constant time. */
export function verifyStripeSignature(raw: Uint8Array, header: string, secret: string, nowS: number,
  toleranceS = STRIPE_SIGNATURE_TOLERANCE_S): boolean {
  if (typeof header !== 'string' || header.length > 8192 || typeof secret !== 'string' || secret.length < 16) return false;
  let timestamp: number | null = null; const signatures: string[] = [];
  for (const part of header.split(',')) {
    const at = part.indexOf('='); if (at < 1) continue;
    const key = part.slice(0, at).trim(), value = part.slice(at + 1).trim();
    if (key === 't' && /^[0-9]{1,12}$/.test(value)) timestamp = Number(value);
    else if (key === 'v1' && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
  }
  if (timestamp === null || !signatures.length || Math.abs(nowS - timestamp) > toleranceS) return false;
  const mac = createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest();
  return signatures.some(sig => timingSafeEqual(Buffer.from(sig, 'hex'), mac));
}

/** Stripe's form encoding: nested objects as a[b][c], arrays as a[0][b]. */
export function stripeForm(params: Record<string, unknown>): string {
  const out = new URLSearchParams();
  const walk = (prefix: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
    else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(prefix ? `${prefix}[${k}]` : k, v);
    else out.append(prefix, String(value));
  };
  walk('', params);
  return out.toString();
}

export type StripeBuyer = Readonly<{ email: string; companyName: string; nip: string | null }>;
/** Company name and NIP for the Stripe checkout form, through the security-definer
 * sc19_stripe.buyer() (the adapter roles cannot read the NIP column directly). It
 * answers only while the company has an unpaid Stripe order, PRESELEKCJA or (after
 * migration 20261121150000) WERYFIKACJA / ASSESSMENT CENTER; otherwise
 * SC19_PAYMENT_FORBIDDEN. `query` runs on the adapter's restricted login. */
export async function readStripeBuyerCompany(
  query: (sql: string, values: unknown[]) => Promise<Record<string, unknown>[]>, companyId: string,
): Promise<{ companyName: string; nip: string | null }> {
  const rows = await query('select company_name,nip from sc19_stripe.buyer($1)', [companyId]);
  if (!rows[0] || typeof rows[0].company_name !== 'string') throw new Sc19PaymentError('SC19_PAYMENT_FORBIDDEN');
  const nip = typeof rows[0].nip === 'string' && /^[0-9]{10}$/.test(rows[0].nip) ? rows[0].nip : null;
  return { companyName: rows[0].company_name, nip };
}
/** One Stripe customer per company and mode, stored by the runtime (sc19_stripe.customers). */
export type StripeCustomerStore = Readonly<{
  find(companyId: string, mode: PaymentMode): Promise<string | null>;
  /** Insert-if-absent; returns the id that is stored afterwards (first writer wins). */
  save(companyId: string, mode: PaymentMode, customerId: string): Promise<string>;
  /** Replace a mapping ONLY while it still points at `staleId` (a customer Stripe
   * confirmed deleted); returns the id stored afterwards. */
  replace(companyId: string, mode: PaymentMode, staleId: string, customerId: string): Promise<string>;
}>;
export type StripeProviderOptions = Readonly<{
  secretKey: string; webhookSecret: string; mode: PaymentMode; appOrigin: string; scope: PaymentScope;
  buyer(order: PaymentOrder): Promise<StripeBuyer>;
  customers: StripeCustomerStore;
  fetch?: typeof fetch; nowMs?: () => number;
}>;

type Json = Record<string, unknown>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sessionIdShape = /^cs_(test|live)_[A-Za-z0-9]{8,200}$/;
const customerIdShape = /^cus_[A-Za-z0-9]{6,64}$/;
const intentIdShape = /^pi_[A-Za-z0-9]{6,64}$/;
const obj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const meta = (v: unknown): Json => obj(v) && obj(v.metadata) ? v.metadata : {};
const fail = (code: string): never => { throw new Sc19PaymentError(code); };
export class StripeApiError extends Error {
  readonly status: number; readonly stripeCode: string | null;
  constructor(status: number, stripeCode: string | null) {
    super('STRIPE_API'); this.status = status; this.stripeCode = stripeCode;
  }
}

export function createStripeProvider(options: StripeProviderOptions): PaymentProvider & Readonly<{
  expiredSession(order: PaymentOrder): Promise<boolean>;
  expiredUnboundSession(order: PaymentOrder): Promise<string | null>;
}> {
  const { secretKey, webhookSecret, mode, appOrigin, scope } = options;
  if (stripeModeOf(secretKey) !== mode || mode !== scope.mode || typeof webhookSecret !== 'string' ||
      !/^whsec_[A-Za-z0-9]{16,}$/.test(webhookSecret)) throw Error('SC19_STRIPE_CONFIGURATION_INVALID');
  const http = options.fetch ?? fetch;
  const now = options.nowMs ?? Date.now;
  const live = mode === 'live';

  async function api(method: 'GET' | 'POST', path: string, params?: Json, idempotencyKey?: string): Promise<Json | null> {
    const query = method === 'GET' && params ? '?' + stripeForm(params) : '';
    const headers: Record<string, string> = { Authorization: `Bearer ${secretKey}`, 'Stripe-Version': STRIPE_API_VERSION };
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let response: Response;
    try {
      response = await http(STRIPE_API + path + query, { method, headers,
        body: method === 'POST' ? stripeForm(params ?? {}) : undefined, signal: AbortSignal.timeout(15_000) });
    } catch { console.error('SC19_STRIPE_FAILURE', 'network'); return fail('SC19_PAYMENT_RETRY'); }
    const body = await response.json().catch(() => null) as Json | null;
    if (response.ok && obj(body)) return body;
    const error = obj(body) && obj(body.error) ? body.error : {};
    const code = typeof error.code === 'string' && /^[a-z_]{1,60}$/.test(error.code) ? error.code : null;
    // Confirmed absence of one object is an answer, not a failure.
    if (response.status === 404 && code === 'resource_missing' && method === 'GET') return null;
    console.error('SC19_STRIPE_FAILURE', response.status, code ?? '-');
    throw new StripeApiError(response.status, code);
  }
  const call = async (...args: Parameters<typeof api>) => {
    try { return await api(...args); }
    catch (e) { if (e instanceof Sc19PaymentError) throw e; return fail('SC19_PAYMENT_RETRY'); }
  };

  /** Server-side check that the snapshotted order is whole packages of its own
   * package at the catalog price (WERYFIKACJA and ASSESSMENT CENTER: exactly one). */
  function packagesOf(order: PaymentOrder): number {
    const code = orderPackage(order);
    const n = order.credits / STRIPE_CATALOG[code].cvCredits;
    const quote = stripeQuote(code, n);
    if (!quote || quote.grossMinor !== order.amountMinor || quote.cvCredits !== order.credits || order.currency !== 'PLN')
      return fail('SC19_PAYMENT_CHECKOUT_INVALID');
    return n;
  }

  /** One customer per company: stored id → search by metadata → create (idempotent). */
  async function ensureCustomer(companyId: string, buyer: StripeBuyer): Promise<string> {
    const details = { name: buyer.companyName, email: buyer.email, preferred_locales: ['pl'] };
    const ours = (c: Json | null) => !!c && c.deleted !== true && meta(c).app === STRIPE_APP &&
      meta(c).company_id === companyId && typeof c.id === 'string' && customerIdShape.test(c.id);
    let id = await options.customers.find(companyId, mode);
    let stale: string | null = null;
    if (id) {
      const existing = await call('GET', `/v1/customers/${encodeURIComponent(id)}`);
      // Only a customer Stripe confirms deleted (or absent) may be replaced. Any
      // other mismatch is not ours to overwrite: fail closed.
      if (existing === null || existing.deleted === true) { stale = id; id = null; }
      else if (!ours(existing)) return fail('SC19_PAYMENT_RETRY');
    }
    if (!id) {
      const found = await call('GET', '/v1/customers/search',
        { query: `metadata['company_id']:'${companyId}' AND metadata['app']:'${STRIPE_APP}'`, limit: 10 });
      const match = Array.isArray(found?.data) ? (found.data as Json[]).find(c => ours(c)) : undefined;
      id = match ? String(match.id) : null;
    }
    if (id) {
      await call('POST', `/v1/customers/${encodeURIComponent(id)}`, details);
    } else {
      const created = await call('POST', '/v1/customers', {
        ...details, metadata: { app: STRIPE_APP, company_id: companyId },
        ...(buyer.nip ? { tax_id_data: [{ type: 'eu_vat', value: 'PL' + buyer.nip }] } : {}),
      // After a deleted customer, a new key: the original key would replay the deleted one.
      }, `${STRIPE_APP}:customer:${mode}:${companyId}${stale ? `:after:${stale}` : ''}`);
      if (!ours(created)) return fail('SC19_PAYMENT_RETRY');
      id = String(created!.id);
    }
    return stale ? options.customers.replace(companyId, mode, stale, id) : options.customers.save(companyId, mode, id);
  }

  /** Price created by the setup step (lookup key skillcheck-core:<code>), checked
   * against the code catalog. Absent → inline price data from the same catalog. */
  async function linePrice(code: StripePackageCode, n: number) {
    const pkg = STRIPE_CATALOG[code];
    const list = await call('GET', '/v1/prices', { lookup_keys: [stripeLookupKey(code)], active: true, limit: 1 });
    const price = Array.isArray(list?.data) ? (list.data as Json[])[0] : undefined;
    if (price) {
      if (price.unit_amount !== pkg.grossMinor || price.currency !== 'pln' || price.type !== 'one_time' ||
          price.livemode !== live || meta(price).app !== STRIPE_APP || meta(price).package_code !== code ||
          typeof price.id !== 'string') return fail('SC19_PAYMENT_CHECKOUT_INVALID');
      return { price: price.id, quantity: n };
    }
    return { quantity: n, price_data: { currency: 'pln', unit_amount: pkg.grossMinor, tax_behavior: 'inclusive',
      product_data: { name: `SkillCheck ${pkg.name} — ${pkg.cvCredits} analiz CV`,
        metadata: { app: STRIPE_APP, package_code: code } } } };
  }

  function hosted(order: PaymentOrder, session: Json | null): HostedCheckout {
    if (!session || typeof session.id !== 'string' || !sessionIdShape.test(session.id) ||
        session.mode !== 'payment' || session.currency !== 'pln' || session.livemode !== live ||
        meta(session).app !== STRIPE_APP || meta(session).order_id !== order.id ||
        meta(session).company_id !== order.companyId || session.client_reference_id !== order.id ||
        typeof session.url !== 'string' || !Number.isSafeInteger(session.amount_total))
      return fail('SC19_PAYMENT_CHECKOUT_INVALID');
    return { orderId: order.id, sessionId: session.id, url: session.url, scope,
      amountMinor: Number(session.amount_total), currency: 'PLN', paymentKind: 'one_time' };
  }

  async function createCheckout(order: PaymentOrder, idempotencyKey: string): Promise<HostedCheckout> {
    if (!sameScope(order.scope, scope)) return fail('SC19_PAYMENT_SCOPE_MISMATCH');
    const n = packagesOf(order);
    const code = orderPackage(order), pkg = STRIPE_CATALOG[code];
    const buyer = await options.buyer(order);
    const customer = await ensureCustomer(order.companyId, buyer);
    const line = await linePrice(code, n);
    const metadata = { app: STRIPE_APP, order_id: order.id, company_id: order.companyId,
      package_code: code, packages: String(n), pool_cv: String(order.credits) };
    const back = `${appOrigin}/dashboard/${order.companyId}/billing/checkout`;
    const session = await call('POST', '/v1/checkout/sessions', {
      mode: 'payment', locale: 'pl', currency: 'pln', customer,
      customer_update: { name: 'auto', address: 'auto' },
      client_reference_id: order.id, metadata,
      payment_intent_data: { metadata, description: `SkillCheck ${pkg.name} — ${n} × ${pkg.cvCredits} analiz CV` },
      line_items: [line],
      // Immediate methods only: the package is granted solely on checkout.session.completed
      // (owner, 19.11.2026), so a delayed method (bank transfer, SEPA…) is never offered.
      // Apple Pay and Google Pay arrive as `card`. An allowlist filter on the dynamic
      // methods (API 2026-10-28 has no static `payment_method_types` on Checkout).
      allowed_payment_method_types: ['card', 'blik', 'p24', 'link'],
      billing_address_collection: 'required', tax_id_collection: { enabled: true },
      success_url: `${back}?stripe=${order.id}`, cancel_url: `${back}?stripe=${order.id}&cancelled=1`,
      branding_settings: stripeBranding(appOrigin),
      custom_text: { submit: { message: stripeLegalText(appOrigin) } },
    }, `${STRIPE_APP}:${idempotencyKey}`);
    return hosted(order, session);
  }

  async function sessionsFor(order: PaymentOrder): Promise<Json[] | null> {
    const customer = await options.customers.find(order.companyId, mode);
    // The customer is stored before any session is created for it, so no stored
    // customer means no session can exist for this order.
    if (!customer) return null;
    const list = await call('GET', '/v1/checkout/sessions', { customer, limit: 100 });
    if (!list || !Array.isArray(list.data)) return fail('SC19_PAYMENT_RETRY');
    const mine = (list.data as Json[]).filter(s => meta(s).app === STRIPE_APP && meta(s).order_id === order.id);
    if (!mine.length && list.has_more === true) return fail('SC19_PAYMENT_RETRY');
    return mine;
  }

  async function lookupCheckout(order: PaymentOrder): Promise<HostedCheckout | null> {
    if (!sameScope(order.scope, scope)) return fail('SC19_PAYMENT_SCOPE_MISMATCH');
    const found = order.sessionId
      ? [await call('GET', `/v1/checkout/sessions/${encodeURIComponent(order.sessionId)}`)].filter(obj)
      : await sessionsFor(order);
    if (!found || !found.length) return null;
    // An expired session can never be paid; only a live one is the order's checkout.
    const usable = found.filter(s => s.status !== 'expired');
    if (!usable.length) return null;
    if (usable.length > 1) return fail('SC19_PAYMENT_RECONCILIATION_REQUIRED');
    // A completed session has no URL any more; it is settled by its webhook only.
    if (typeof usable[0].url !== 'string') return fail('SC19_PAYMENT_RECONCILIATION_REQUIRED');
    return hosted(order, usable[0]);
  }

  /** True only when Stripe confirms the stored session is expired: it can no
   * longer be paid, so the order may get a fresh session. Throws on uncertainty. */
  async function expiredSession(order: PaymentOrder): Promise<boolean> {
    if (!order.sessionId || !sameScope(order.scope, scope)) return false;
    const session = await call('GET', `/v1/checkout/sessions/${encodeURIComponent(order.sessionId)}`);
    if (!session) return fail('SC19_PAYMENT_RECONCILIATION_REQUIRED');
    if (session.id !== order.sessionId || meta(session).order_id !== order.id) return fail('SC19_PAYMENT_ORDER_MISMATCH');
    return session.status === 'expired' && session.payment_status !== 'paid';
  }

  /** R7: the create response was lost, so the order has no stored session. Returns
   * the id of its session only when Stripe lists exactly one session for this order
   * (complete list, no further page) and confirms it expired unpaid. Read only. */
  async function expiredUnboundSession(order: PaymentOrder): Promise<string | null> {
    if (order.sessionId !== null || !sameScope(order.scope, scope)) return null;
    const customer = await options.customers.find(order.companyId, mode);
    if (!customer) return null;
    const list = await call('GET', '/v1/checkout/sessions', { customer, limit: 100 });
    if (!list || !Array.isArray(list.data)) return fail('SC19_PAYMENT_RETRY');
    if (list.has_more === true) return null;
    const mine = (list.data as Json[]).filter(s => obj(s) && meta(s).app === STRIPE_APP && meta(s).order_id === order.id);
    if (mine.length !== 1) return null;
    const s = mine[0];
    if (typeof s.id !== 'string' || !sessionIdShape.test(s.id) || s.client_reference_id !== order.id ||
        meta(s).company_id !== order.companyId || s.livemode !== live || s.mode !== 'payment') return null;
    return s.status === 'expired' && s.payment_status !== 'paid' ? s.id : null;
  }

  async function verifyAndRetrieve(raw: Uint8Array, signature: string): Promise<VerifiedPayment | null> {
    if (!verifyStripeSignature(raw, signature, webhookSecret, Math.floor(now() / 1000)))
      return fail('SC19_PAYMENT_NOTIFICATION_INVALID');
    let event: Json;
    try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
    catch { return fail('SC19_PAYMENT_NOTIFICATION_INVALID'); }
    if (!obj(event) || typeof event.id !== 'string' || !/^evt_[A-Za-z0-9]{6,200}$/.test(event.id) ||
        typeof event.type !== 'string' || !obj(event.data) || !obj(event.data.object))
      return fail('SC19_PAYMENT_NOTIFICATION_INVALID');
    // Only checkout.session.completed grants a package. checkout.session.expired (R7)
    // only closes the unpaid order bound to that session, never grants. Every other
    // type is acknowledged with no action.
    const expiredEvent = event.type === 'checkout.session.expired';
    if (event.type !== 'checkout.session.completed' && !expiredEvent) return null;
    const candidate = event.data.object;
    // The other application on the same Stripe account: 200, no action.
    if (meta(candidate).app !== STRIPE_APP) return null;
    if (event.livemode !== live) return fail('SC19_PAYMENT_NOTIFICATION_INVALID');
    if (typeof candidate.id !== 'string' || !sessionIdShape.test(candidate.id)) return fail('SC19_PAYMENT_NOTIFICATION_INVALID');
    // Payment truth comes from the API, never from the delivered body.
    const session = await call('GET', `/v1/checkout/sessions/${encodeURIComponent(candidate.id)}`);
    const orderId = meta(session).order_id;
    if (!session || session.id !== candidate.id || session.mode !== 'payment' || session.livemode !== live ||
        session.currency !== 'pln' || meta(session).app !== STRIPE_APP || typeof orderId !== 'string' ||
        !uuid.test(orderId) || session.client_reference_id !== orderId || !Number.isSafeInteger(session.amount_total))
      return fail('SC19_PAYMENT_NOTIFICATION_INVALID');
    if (expiredEvent) {
      // Closing needs Stripe's own word that the session expired unpaid; anything else
      // (still open, complete, paid) is acknowledged with no action.
      if (session.status !== 'expired' || session.payment_status === 'paid') return null;
      return { eventId: event.id, orderId, sessionId: session.id, paymentId: session.id, scope,
        amountMinor: Number(session.amount_total), currency: 'PLN', status: 'expired' };
    }
    const intent = typeof session.payment_intent === 'string' ? session.payment_intent
      : obj(session.payment_intent) && typeof session.payment_intent.id === 'string' ? session.payment_intent.id : null;
    const paid = session.payment_status === 'paid' && session.status === 'complete';
    if (paid && (!intent || !intentIdShape.test(intent))) return fail('SC19_PAYMENT_NOTIFICATION_INVALID');
    return { eventId: event.id, orderId, sessionId: session.id, paymentId: intent ?? session.id, scope,
      amountMinor: Number(session.amount_total), currency: 'PLN',
      status: paid ? 'paid' : session.payment_status === 'unpaid' ? 'pending' : 'failed' };
  }

  return Object.freeze({ createCheckout, lookupCheckout, expiredSession, expiredUnboundSession, verifyAndRetrieve });
}

function sameScope(a: PaymentScope, b: PaymentScope) {
  return !!a && !!b && a.provider === b.provider && a.account === b.account && a.mode === b.mode;
}
