/** SC-BILLING-P24-001: Przelewy24 (REST API v1) as an SC-019 PaymentProvider.
 *
 * Flow: SC-019 order → POST /api/v1/transaction/register (sessionId derived
 * from the order, signed with the CRC key) → customer pays on the Przelewy24
 * hosted page (BLIK / pay-by-link / card) → Przelewy24 POSTs a signed status
 * notification → verifyAndRetrieve checks the notification signature AND
 * merchant scope, confirms the payment with PUT /api/v1/transaction/verify and
 * re-reads the transaction by sessionId; only that fresh read is payment truth.
 *
 * Not wired into resolveSc19PaymentRuntime: activation needs the SC-019
 * migration, an approved offer, live Przelewy24 credentials and a separate
 * owner decision. Tests use an in-memory Przelewy24 API; no network.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { HostedCheckout, PaymentOrder, PaymentProvider, PaymentScope, VerifiedPayment } from './sc19-payments.ts';

export type Przelewy24Config = Readonly<{
  merchantId: number;
  /** Defaults to merchantId (single point of sale). */
  posId?: number;
  /** "Klucz do raportów" / API key: Basic-auth password for REST calls. */
  apiKey: string;
  /** CRC key used only for sha384 signatures. */
  crc: string;
  mode: 'test' | 'live';
}>;
export type Przelewy24ProviderDeps = Readonly<{
  config: Przelewy24Config;
  scope: PaymentScope;
  /** Server-chosen URLs; never taken from the browser. */
  urlReturn(order: PaymentOrder): string;
  urlStatus: string;
  /** Verified buyer e-mail for the order's company (required by Przelewy24). */
  email(order: PaymentOrder): Promise<string>;
  description(order: PaymentOrder): string;
}>;
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect: 'error'; signal: AbortSignal }) =>
  Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;

export const PRZELEWY24_ORIGIN = { test: 'https://sandbox.przelewy24.pl', live: 'https://secure.przelewy24.pl' } as const;
/** Przelewy24 notification source addresses (operator documentation). Defence in depth only. */
export const PRZELEWY24_NOTIFY_IPS = Object.freeze(['5.252.202.254', '5.252.202.255', '20.215.81.124']);

const ORDER = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION = /^sc19-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const TOKEN = /^[A-Za-z0-9-]{8,100}$/;
const TIMEOUT_MS = 15_000;
const NOTIFY_KEYS = ['merchantId', 'posId', 'sessionId', 'amount', 'originAmount', 'currency', 'orderId', 'methodId', 'statement', 'sign'];

export class Przelewy24Error extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'Przelewy24Error'; this.code = code; }
}
const fail = (code: string): never => { throw new Przelewy24Error(code); };

/** sha384 over compact JSON with unescaped slashes/unicode, as the operator's SDKs do. */
export function przelewy24Sign(fields: Record<string, string | number>): string {
  return createHash('sha384').update(JSON.stringify(fields), 'utf8').digest('hex');
}
export const sessionIdFor = (orderId: string) => {
  if (!ORDER.test(orderId)) fail('P24_ORDER_INVALID');
  return `sc19-${orderId}`;
};
/** The notification carries its signature inside the JSON body. */
export function przelewy24NotificationSignature(raw: Uint8Array): string {
  try {
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as { sign?: unknown };
    return typeof body?.sign === 'string' && /^[0-9a-f]{96}$/.test(body.sign) ? body.sign : '';
  } catch { return ''; }
}
const sameHex = (a: string, b: string) => {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  return x.length === 48 && y.length === 48 && timingSafeEqual(x, y);
};
const posInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

export function createPrzelewy24Provider(deps: Przelewy24ProviderDeps, fetchImpl: Fetch = fetch as unknown as Fetch): PaymentProvider {
  const c = deps.config;
  const posId = c.posId ?? c.merchantId;
  if (!posInt(c.merchantId) || !posInt(posId) || typeof c.apiKey !== 'string' || c.apiKey.length < 16 ||
      typeof c.crc !== 'string' || c.crc.length < 8 || (c.mode !== 'test' && c.mode !== 'live'))
    fail('P24_CONFIG_INVALID');
  // Merchant scope must be exactly the configured account and environment.
  if (deps.scope.provider !== 'przelewy24' || deps.scope.account !== String(c.merchantId) || deps.scope.mode !== c.mode)
    fail('P24_CONFIG_INVALID');
  let statusUrl: URL;
  try { statusUrl = new URL(deps.urlStatus); } catch { return fail('P24_CONFIG_INVALID'); }
  if (statusUrl.protocol !== 'https:') fail('P24_CONFIG_INVALID');
  const origin = PRZELEWY24_ORIGIN[c.mode];
  const scope = Object.freeze({ ...deps.scope });
  const auth = 'Basic ' + Buffer.from(`${posId}:${c.apiKey}`).toString('base64');

  async function call(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    let res;
    try {
      res = await fetchImpl(origin + path, { method, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { authorization: auth, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    } catch { return fail('P24_UNAVAILABLE'); }
    let data: unknown = null;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
  }

  function hosted(order: PaymentOrder, token: string): HostedCheckout {
    if (!TOKEN.test(token)) fail('P24_RESPONSE_INVALID');
    return Object.freeze({ orderId: order.id, sessionId: sessionIdFor(order.id), url: `${origin}/trnRequest/${token}`, scope,
      amountMinor: order.amountMinor, currency: 'PLN', paymentKind: 'one_time' });
  }
  function checkOrder(order: PaymentOrder, key: string) {
    if (key !== `sc19:${order.id}`) fail('P24_KEY_MISMATCH');
    if (!Number.isSafeInteger(order.amountMinor) || order.amountMinor < 100 || order.currency !== 'PLN') fail('P24_ORDER_INVALID');
  }
  /** Fresh authenticated read. null = provider-confirmed absence; throws on anything uncertain. */
  async function findSession(sessionId: string) {
    const r = await call('GET', `/api/v1/transaction/by/sessionId/${encodeURIComponent(sessionId)}`);
    if (r.status === 404) return null;
    const d = (r.data as { data?: Record<string, unknown> } | null)?.data;
    if (r.status !== 200 || !d || d.sessionId !== sessionId || !posInt(d.orderId) || !Number.isSafeInteger(d.amount) ||
        d.currency !== 'PLN' || ![0, 1, 2, 3].includes(d.status as number)) return fail('P24_RESPONSE_INVALID');
    return d as { orderId: number; amount: number; status: 0 | 1 | 2 | 3 };
  }

  return Object.freeze({
    async createCheckout(order: PaymentOrder, key: string): Promise<HostedCheckout> {
      checkOrder(order, key);
      const sessionId = sessionIdFor(order.id);
      const email = await deps.email(order);
      if (typeof email !== 'string' || !/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(email)) fail('P24_ORDER_INVALID');
      const returnUrl = deps.urlReturn(order);
      if (!/^https:\/\//.test(returnUrl)) fail('P24_CONFIG_INVALID');
      const sign = przelewy24Sign({ sessionId, merchantId: c.merchantId, amount: order.amountMinor, currency: 'PLN', crc: c.crc });
      const r = await call('POST', '/api/v1/transaction/register', {
        merchantId: c.merchantId, posId, sessionId, amount: order.amountMinor, currency: 'PLN',
        description: deps.description(order).slice(0, 1024), email, country: 'PL', language: 'pl',
        urlReturn: returnUrl, urlStatus: statusUrl.href, timeLimit: 30, waitForResult: false,
        regulationAccept: false, encoding: 'UTF-8', sign,
      });
      const token = (r.data as { data?: { token?: unknown } } | null)?.data?.token;
      if (r.status === 200 && typeof token === 'string') return hosted(order, token);
      // Rejected or lost response: Przelewy24 never returns the original token
      // again, so a session that already exists cannot be safely re-exposed.
      // Refuse instead of registering a second charge; owner reconciles.
      const existing = await findSession(sessionId);
      return fail(existing ? 'P24_SESSION_EXISTS' : 'P24_REGISTER_REJECTED');
    },
    async lookupCheckout(order: PaymentOrder, key: string): Promise<HostedCheckout | null> {
      checkOrder(order, key);
      const existing = await findSession(sessionIdFor(order.id));
      // Present but the hosted token is unknowable here: uncertainty, not absence.
      return existing ? fail('P24_SESSION_EXISTS') : null;
    },
    async verifyAndRetrieve(raw: Uint8Array, signature: string): Promise<VerifiedPayment | null> {
      let n: Record<string, unknown>;
      try { n = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { return fail('P24_NOTIFICATION_INVALID'); }
      if (!n || typeof n !== 'object' || Array.isArray(n) || Object.keys(n).length !== NOTIFY_KEYS.length ||
          !NOTIFY_KEYS.every(k => Object.hasOwn(n, k))) return fail('P24_NOTIFICATION_INVALID');
      if (n.merchantId !== c.merchantId || n.posId !== posId) return fail('P24_SCOPE_MISMATCH');
      if (typeof n.sessionId !== 'string' || !SESSION.test(n.sessionId) || !posInt(n.amount) || !posInt(n.originAmount) ||
          n.currency !== 'PLN' || !posInt(n.orderId) || !Number.isSafeInteger(n.methodId) || typeof n.statement !== 'string' ||
          typeof n.sign !== 'string' || !/^[0-9a-f]{96}$/.test(n.sign))
        return fail('P24_NOTIFICATION_INVALID');
      const expected = przelewy24Sign({ merchantId: c.merchantId, posId, sessionId: n.sessionId, amount: n.amount as number,
        originAmount: n.originAmount as number, currency: 'PLN', orderId: n.orderId as number, methodId: n.methodId as number,
        statement: n.statement, crc: c.crc });
      if (!sameHex(n.sign, expected) || !/^[0-9a-f]{96}$/.test(signature) || !sameHex(signature, expected))
        return fail('P24_NOTIFICATION_UNAUTHENTICATED');
      const sessionId = n.sessionId, orderId = SESSION.exec(sessionId)![1];
      // Confirm receipt; without verify Przelewy24 does not settle the payment.
      const v = await call('PUT', '/api/v1/transaction/verify', { merchantId: c.merchantId, posId, sessionId,
        amount: n.amount, currency: 'PLN', orderId: n.orderId,
        sign: przelewy24Sign({ sessionId, orderId: n.orderId as number, amount: n.amount as number, currency: 'PLN', crc: c.crc }) });
      // A repeated notification may get a non-success verify answer for an
      // already-settled transaction; the fresh read below decides, not this call.
      void v;
      // Payment truth: fresh read, never the notification fields alone.
      // Status 2 = payment settled (after verify); 1 = awaiting verify; 3 = returned.
      const t = await findSession(sessionId);
      if (!t || t.orderId !== n.orderId) return fail('P24_RESPONSE_INVALID');
      const status: VerifiedPayment['status'] = t.status === 2 ? 'paid' : t.status === 3 ? 'failed' : 'pending';
      return Object.freeze({ eventId: `przelewy24:${t.orderId}:${t.status}`, orderId, sessionId,
        paymentId: `przelewy24:${t.orderId}`, scope, amountMinor: t.amount, currency: 'PLN', status });
    },
  });
}
