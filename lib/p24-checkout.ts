/** SC-CHECKOUT-P24-001: public guest checkout with Przelewy24 (REST API v1).
 *
 * register: server-priced order → signed public.orders row → POST /transaction/register
 *           (sha384 sign over {sessionId, merchantId, amount, currency, crc}) → hosted page URL.
 * notify:   urlStatus POST → sign check over all notification fields + merchant/POS scope
 *           → amount/session matched against OUR order → PUT /transaction/verify → status paid.
 * return:   the browser redirect is never evidence. The page reads OUR order and, while
 *           it is pending, reconciles with an authenticated read of the transaction.
 *
 * Keys come only from server environment variables (P24_MERCHANT_ID, P24_POS_ID,
 * P24_CRC, P24_API_KEY, P24_SANDBOX). Missing/invalid configuration disables checkout.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { PRZELEWY24_ORIGIN, przelewy24Sign } from './sc19-przelewy24-provider.ts';
import { checkoutProduct, checkoutQuantity } from './checkout-catalog.ts';
import type { CheckoutOrders, OrderStatus } from './checkout-orders.ts';

export type P24Config = Readonly<{ merchantId: number; posId: number; crc: string; apiKey: string; sandbox: boolean }>;
export type P24Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect: 'error'; signal: AbortSignal }) =>
  Promise<{ status: number; json(): Promise<unknown> }>;

export class P24CheckoutError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'P24CheckoutError'; this.code = code; }
}
const fail = (code: string): never => { throw new P24CheckoutError(code); };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION = /^sc-ord-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const TOKEN = /^[A-Za-z0-9-]{8,100}$/;
const NOTIFY_KEYS = ['merchantId', 'posId', 'sessionId', 'amount', 'originAmount', 'currency', 'orderId', 'methodId', 'statement', 'sign'];
const posInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

/** Reads keys from the server environment only. null = checkout disabled (fail closed). */
export function readP24Config(env: Record<string, string | undefined> = process.env): P24Config | null {
  const merchantId = Number(env.P24_MERCHANT_ID), posId = Number(env.P24_POS_ID || env.P24_MERCHANT_ID);
  const crc = env.P24_CRC ?? '', apiKey = env.P24_API_KEY ?? '';
  const sandbox = env.P24_SANDBOX === 'true' ? true : env.P24_SANDBOX === 'false' ? false : null;
  if (!/^\d{1,10}$/.test(env.P24_MERCHANT_ID ?? '') || !posInt(merchantId) || !posInt(posId) ||
      crc.length < 8 || apiKey.length < 16 || sandbox === null) return null;
  return Object.freeze({ merchantId, posId, crc, apiKey, sandbox });
}
export const p24Origin = (c: P24Config) => c.sandbox ? PRZELEWY24_ORIGIN.test : PRZELEWY24_ORIGIN.live;

export function createP24Client(c: P24Config, fetchImpl: P24Fetch = fetch as unknown as P24Fetch) {
  const origin = p24Origin(c);
  const auth = 'Basic ' + Buffer.from(`${c.posId}:${c.apiKey}`).toString('base64');
  async function call(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) {
    let res;
    try {
      res = await fetchImpl(origin + path, { method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { authorization: auth, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    } catch { return fail('P24_UNAVAILABLE'); }
    let data: unknown = null;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data: (data as { data?: unknown } | null)?.data };
  }
  return Object.freeze({
    async register(t: { sessionId: string; amount: number; description: string; email: string; client: string; phone: string;
      urlReturn: string; urlStatus: string }): Promise<string> {
      const sign = przelewy24Sign({ sessionId: t.sessionId, merchantId: c.merchantId, amount: t.amount, currency: 'PLN', crc: c.crc });
      const r = await call('POST', '/api/v1/transaction/register', {
        merchantId: c.merchantId, posId: c.posId, sessionId: t.sessionId, amount: t.amount, currency: 'PLN',
        description: t.description.slice(0, 1024), email: t.email, client: t.client.slice(0, 40), phone: t.phone,
        country: 'PL', language: 'pl', urlReturn: t.urlReturn, urlStatus: t.urlStatus,
        timeLimit: 30, waitForResult: false, regulationAccept: false, encoding: 'UTF-8', sign,
      });
      const token = (r.data as { token?: unknown } | undefined)?.token;
      if (r.status !== 200 || typeof token !== 'string' || !TOKEN.test(token)) return fail('P24_REGISTER_REJECTED');
      return `${origin}/trnRequest/${token}`;
    },
    /** true only when Przelewy24 confirms the verification. */
    async verify(t: { sessionId: string; orderId: number; amount: number }): Promise<boolean> {
      const r = await call('PUT', '/api/v1/transaction/verify', { merchantId: c.merchantId, posId: c.posId,
        sessionId: t.sessionId, amount: t.amount, currency: 'PLN', orderId: t.orderId,
        sign: przelewy24Sign({ sessionId: t.sessionId, orderId: t.orderId, amount: t.amount, currency: 'PLN', crc: c.crc }) });
      return r.status === 200 && (r.data as { status?: unknown } | undefined)?.status === 'success';
    },
    /** Authenticated read. null = no such transaction. Status: 0 none, 1 awaiting verify, 2 settled, 3 returned. */
    async bySession(sessionId: string): Promise<{ orderId: number; amount: number; status: 0 | 1 | 2 | 3 } | null> {
      const r = await call('GET', `/api/v1/transaction/by/sessionId/${encodeURIComponent(sessionId)}`);
      if (r.status === 404) return null;
      const d = r.data as Record<string, unknown> | undefined;
      if (r.status !== 200 || !d || d.sessionId !== sessionId || !Number.isSafeInteger(d.amount) ||
          ![0, 1, 2, 3].includes(d.status as number)) return fail('P24_RESPONSE_INVALID');
      if (d.status !== 0 && !posInt(d.orderId)) return fail('P24_RESPONSE_INVALID');
      return { orderId: d.orderId as number, amount: d.amount as number, status: d.status as 0 | 1 | 2 | 3 };
    },
  });
}
export type P24Client = ReturnType<typeof createP24Client>;

export type P24Notification = Readonly<{ sessionId: string; orderUuid: string; amount: number; orderId: number }>;
/** Strict parse + signature check of the urlStatus body. Throws on anything unexpected. */
export function parseP24Notification(c: P24Config, raw: Uint8Array): P24Notification {
  let n: Record<string, unknown>;
  try { n = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { return fail('P24_NOTIFICATION_INVALID'); }
  if (!n || typeof n !== 'object' || Array.isArray(n) || Object.keys(n).length !== NOTIFY_KEYS.length ||
      !NOTIFY_KEYS.every(k => Object.hasOwn(n, k))) return fail('P24_NOTIFICATION_INVALID');
  if (n.merchantId !== c.merchantId || n.posId !== c.posId) return fail('P24_SCOPE_MISMATCH');
  if (typeof n.sessionId !== 'string' || !SESSION.test(n.sessionId) || !posInt(n.amount) || !posInt(n.originAmount) ||
      n.currency !== 'PLN' || !posInt(n.orderId) || !Number.isSafeInteger(n.methodId) || typeof n.statement !== 'string' ||
      typeof n.sign !== 'string' || !/^[0-9a-f]{96}$/.test(n.sign)) return fail('P24_NOTIFICATION_INVALID');
  const expected = przelewy24Sign({ merchantId: c.merchantId, posId: c.posId, sessionId: n.sessionId, amount: n.amount,
    originAmount: n.originAmount, currency: 'PLN', orderId: n.orderId, methodId: n.methodId as number,
    statement: n.statement, crc: c.crc });
  if (!timingSafeEqual(Buffer.from(n.sign, 'hex'), Buffer.from(expected, 'hex'))) return fail('P24_NOTIFICATION_UNAUTHENTICATED');
  return Object.freeze({ sessionId: n.sessionId, orderUuid: SESSION.exec(n.sessionId)![1], amount: n.amount, orderId: n.orderId });
}

export type CheckoutInput = Readonly<{
  product: unknown; quantity: unknown; name: unknown; email: unknown; phone: unknown;
  company?: unknown; nip?: unknown; terms: unknown;
}>;
export type ValidCheckout = Readonly<{ productCode: string; quantity: number; amountGross: number; name: string; email: string;
  phone: string; company: string | null; nip: string | null; description: string }>;

const clean = (v: unknown, max: number) => typeof v === 'string' && v.length <= max * 2 && !/[\x00-\x1f\x7f]/.test(v)
  ? v.trim().replace(/\s+/g, ' ') : null;
/** Polish NIP checksum. */
export function validNip(nip: string): boolean {
  if (!/^\d{10}$/.test(nip)) return false;
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const sum = w.reduce((s, x, i) => s + x * Number(nip[i]), 0) % 11;
  return sum !== 10 && sum === Number(nip[9]);
}
/** Field-level validation. Returns the first invalid field name or the normalized order. */
export function validateCheckout(input: CheckoutInput): { field: string } | ValidCheckout {
  const product = checkoutProduct(input.product);
  if (!product) return { field: 'product' };
  const quantity = checkoutQuantity(product, input.quantity);
  if (quantity === null) return { field: 'quantity' };
  const name = clean(input.name, 120);
  if (!name || Array.from(name).length < 2 || Array.from(name).length > 120) return { field: 'name' };
  const email = clean(input.email, 254)?.toLowerCase() ?? null;
  if (!email || email.length > 254 || !/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { field: 'email' };
  const phone = clean(input.phone, 32);
  if (!phone || !/^[0-9+() -]{6,32}$/.test(phone) || (phone.match(/\d/g)?.length ?? 0) < 6) return { field: 'phone' };
  const companyRaw = input.company === undefined || input.company === null ? '' : clean(input.company, 200);
  if (companyRaw === null || Array.from(companyRaw).length > 200 || companyRaw.length === 1) return { field: 'company' };
  const nipRaw = input.nip === undefined || input.nip === null ? '' : typeof input.nip === 'string' ? input.nip.replace(/[\s-]/g, '') : null;
  if (nipRaw === null || (nipRaw && !validNip(nipRaw.replace(/^PL/i, '')))) return { field: 'nip' };
  if (input.terms !== true) return { field: 'terms' };
  return Object.freeze({ productCode: product.code, quantity, amountGross: product.unitGross * quantity, name, email, phone,
    company: companyRaw || null, nip: nipRaw ? nipRaw.replace(/^PL/i, '') : null,
    description: `SkillCheck — ${product.name} × ${quantity}` });
}

export type CheckoutDeps = Readonly<{ config: P24Config; orders: CheckoutOrders; p24: P24Client; appOrigin: string }>;

export function createCheckoutService(d: CheckoutDeps) {
  return Object.freeze({
    /** Creates the order, registers the transaction, returns the hosted payment URL. */
    async start(order: ValidCheckout, newId: () => string = randomUUID): Promise<{ orderId: string; redirectUrl: string }> {
      const id = newId();
      if (!UUID.test(id)) fail('CHECKOUT_INVALID');
      const sessionId = await d.orders.create({ id, productCode: order.productCode, quantity: order.quantity,
        amountGross: order.amountGross, customerName: order.name, customerEmail: order.email, customerPhone: order.phone,
        companyName: order.company, nip: order.nip });
      try {
        const redirectUrl = await d.p24.register({ sessionId, amount: order.amountGross, description: order.description,
          email: order.email, client: order.name, phone: order.phone,
          urlReturn: `${d.appOrigin}/checkout/return?order=${id}`, urlStatus: `${d.appOrigin}/api/p24/notify` });
        return { orderId: id, redirectUrl };
      } catch (e) {
        // A paid notification for this session can still move failed → paid.
        await d.orders.update(id, 'failed', null, null).catch(() => undefined);
        throw e;
      }
    },
    /** urlStatus handler core. Resolves only after the order is durably marked. */
    async notify(raw: Uint8Array): Promise<OrderStatus> {
      const n = parseP24Notification(d.config, raw);
      const order = await d.orders.read(n.orderUuid);
      if (!order || order.p24_session_id !== n.sessionId) return fail('P24_ORDER_UNKNOWN');
      if (order.status === 'paid') return 'paid';
      if (n.amount !== order.amount_gross) return fail('P24_AMOUNT_MISMATCH');
      if (await d.p24.verify({ sessionId: n.sessionId, orderId: n.orderId, amount: order.amount_gross }))
        return d.orders.update(n.orderUuid, 'paid', n.orderId, order.amount_gross);
      // Repeated notification for an already verified transaction: the authenticated read decides.
      const t = await d.p24.bySession(n.sessionId);
      if (t && t.status === 2 && t.orderId === n.orderId && t.amount === order.amount_gross)
        return d.orders.update(n.orderUuid, 'paid', t.orderId, t.amount);
      return fail('P24_VERIFY_REJECTED');
    },
    /** Return-page status. Reconciles a pending order with Przelewy24; never trusts the redirect itself. */
    async status(orderId: string): Promise<{ status: OrderStatus; amountGross: number; productCode: string; quantity: number } | null> {
      if (!UUID.test(orderId)) return null;
      const order = await d.orders.read(orderId);
      if (!order) return null;
      let status = order.status;
      if (status === 'pending' || status === 'failed') {
        try {
          const t = await d.p24.bySession(order.p24_session_id);
          if (t && t.amount === order.amount_gross && (t.status === 2 ||
              (t.status === 1 && await d.p24.verify({ sessionId: order.p24_session_id, orderId: t.orderId, amount: t.amount }))))
            status = await d.orders.update(orderId, 'paid', t.orderId, t.amount);
        } catch { /* keep the stored status; the notification will settle it */ }
      }
      return { status, amountGross: order.amount_gross, productCode: order.product_code, quantity: order.quantity };
    },
  });
}
