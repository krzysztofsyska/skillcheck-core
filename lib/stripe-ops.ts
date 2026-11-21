/** R7: one-off Stripe setup for the core application (owner decision 20.11.2026,
 * 18:29, point 5, docs/DECYZJE.md), the same pattern as skillcheck-preselekcja.
 *
 * POST /api/internal/stripe-ops with header `x-skillcheck-ops: <token>`. Only the
 * SHA-256 of a one-time token is in the code; the token itself is never committed.
 *
 *  * `status` (read only, any Vercel deployment): which variables are present
 *    (booleans only, never a value), the Stripe key's mode, whether the live gate
 *    would open, a read-only Fakturownia connection check, and whether the Stripe
 *    products, prices and webhook endpoint exist.
 *  * `setup` (production deployment only): idempotent. Products and prices of
 *    PRESELEKCJA, WERYFIKACJA and ASSESSMENT CENTER from the code catalog (prices =
 *    docs/cennik-2026-11-02.md, gross PLN, tax_behavior inclusive, lookup key
 *    `skillcheck-core:<CODE>`, metadata app=skillcheck-core + package_code); for
 *    real money WERYFIKACJA and ASSESSMENT CENTER are marked „wkrótce” (the
 *    application does not sell them live). The webhook endpoint
 *    https://skillcheck.pl/api/billing/stripe/webhook with checkout.session.completed,
 *    checkout.session.expired and charge.refunded. Its signing secret is returned
 *    ONLY in the response that created it (Stripe shows it only then). An existing
 *    price that differs from the catalog is reported, never changed. Nothing is ever
 *    deleted, and endpoints of other URLs (skillcheck-preselekcja) are never touched.
 *
 * Not here: Stripe account settings and branding, refunds, any payment.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { checkFakturowniaConnection, type FakturowniaFetch } from './fakturownia-client.ts';
import { sc19StripeGate } from './sc19-stripe-config.ts';
import { STRIPE_API, STRIPE_API_VERSION, stripeForm, stripeModeOf } from './sc19-stripe-provider.ts';
import { STRIPE_APP, STRIPE_CATALOG, stripeLookupKey, type StripePackageCode } from './stripe-catalog.ts';

/** SHA-256 (hex) of the one-time operations token. */
export const STRIPE_OPS_TOKEN_SHA256 = '5badb0db026e3a6c16e8649a8a058418c8711226836d19550e6ddb7dd92f2c07';
export const STRIPE_OPS_HEADER = 'x-skillcheck-ops';
export const STRIPE_WEBHOOK_URL = 'https://skillcheck.pl/api/billing/stripe/webhook';
/** checkout.session.expired is already handled (R7 PR #578), so the endpoint gets it too. */
export const STRIPE_WEBHOOK_EVENTS = Object.freeze(['checkout.session.completed', 'checkout.session.expired', 'charge.refunded']);
const CODES: readonly StripePackageCode[] = ['PRESELEKCJA', 'WERYFIKACJA', 'ASSESSMENT_CENTER'];

/** Constant-time check of the header against the stored hash. */
export function stripeOpsAuthorized(header: string | null, expectedSha256 = STRIPE_OPS_TOKEN_SHA256): boolean {
  if (typeof header !== 'string' || !/^[0-9a-f]{64}$/.test(header) || !/^[0-9a-f]{64}$/.test(expectedSha256)) return false;
  const given = createHash('sha256').update(header).digest();
  return timingSafeEqual(given, Buffer.from(expectedSha256, 'hex'));
}

type Json = Record<string, unknown>;
const obj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const meta = (v: unknown): Json => obj(v) && obj(v.metadata) ? v.metadata : {};
export class StripeOpsError extends Error {
  readonly status: number; readonly stripeCode: string | null;
  constructor(status: number, stripeCode: string | null) { super('STRIPE_OPS_API'); this.status = status; this.stripeCode = stripeCode; }
}

function stripeClient(key: string, http: typeof fetch) {
  return async (method: 'GET' | 'POST', path: string, params: Json = {}, idempotencyKey?: string): Promise<Json> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${key}`, 'Stripe-Version': STRIPE_API_VERSION };
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const query = method === 'GET' && Object.keys(params).length ? '?' + stripeForm(params) : '';
    let response: Response;
    try {
      response = await http(STRIPE_API + path + query, { method, headers, body: method === 'POST' ? stripeForm(params) : undefined,
        signal: AbortSignal.timeout(15_000) });
    } catch { throw new StripeOpsError(0, 'network'); }
    const body = await response.json().catch(() => null) as Json | null;
    if (response.ok && obj(body)) return body;
    const error = obj(body) && obj(body.error) ? body.error : {};
    const code = typeof error.code === 'string' && /^[a-z_]{1,60}$/.test(error.code) ? error.code : null;
    throw new StripeOpsError(response.status, code);
  };
}
type Call = ReturnType<typeof stripeClient>;

const productName = (code: StripePackageCode) => `SkillCheck ${STRIPE_CATALOG[code].name} — ${STRIPE_CATALOG[code].cvCredits} analiz CV`;
/** Real money buys PRESELEKCJA only; the other two are „wkrótce” in live mode. */
const availability = (code: StripePackageCode, live: boolean) =>
  code === 'PRESELEKCJA' || !live ? (STRIPE_CATALOG[code].available ? 'available' : 'wkrotce') : 'wkrotce';

async function findPrice(call: Call, code: StripePackageCode) {
  const list = await call('GET', '/v1/prices', { lookup_keys: [stripeLookupKey(code)], limit: 1 });
  return Array.isArray(list.data) && obj(list.data[0]) ? list.data[0] as Json : null;
}
function priceMatches(price: Json, code: StripePackageCode, live: boolean) {
  return price.unit_amount === STRIPE_CATALOG[code].grossMinor && price.currency === 'pln' && price.type === 'one_time' &&
    price.tax_behavior === 'inclusive' && price.livemode === live && price.active === true &&
    meta(price).app === STRIPE_APP && meta(price).package_code === code;
}
async function findProduct(call: Call, code: StripePackageCode) {
  const found = await call('GET', '/v1/products/search',
    { query: `metadata['app']:'${STRIPE_APP}' AND metadata['package_code']:'${code}'`, limit: 10 });
  const mine = Array.isArray(found.data) ? (found.data as Json[]).filter(p => meta(p).app === STRIPE_APP && meta(p).package_code === code) : [];
  return mine[0] ?? null;
}
async function findEndpoints(call: Call) {
  const list = await call('GET', '/v1/webhook_endpoints', { limit: 100 });
  return Array.isArray(list.data) ? (list.data as Json[]).filter(e => e.url === STRIPE_WEBHOOK_URL) : [];
}

export type StripeOpsGate = Readonly<{ ok: true; key: string; mode: 'test' | 'live'; production: boolean }> | Readonly<{ ok: false; reason: string }>;
export function stripeOpsGate(env: Record<string, string | undefined>): StripeOpsGate {
  if (env.VERCEL !== '1') return { ok: false, reason: 'not_vercel' };
  const mode = stripeModeOf(env.STRIPE_SECRET_KEY);
  if (!mode) return { ok: false, reason: 'stripe_secret_key' };
  const site = env.NEXT_PUBLIC_SITE_URL;
  const production = env.VERCEL_ENV === 'production' && env.VERCEL_GIT_COMMIT_REF === 'main' &&
    (site === 'https://skillcheck.pl' || site === 'https://skillcheck.pl/');
  return { ok: true, key: env.STRIPE_SECRET_KEY as string, mode, production };
}

const present = (v: string | undefined) => typeof v === 'string' && v.trim().length > 0;

/** Read only. Booleans and fixed codes; never a variable's value, a key or a secret. */
export async function stripeOpsStatus(env: Record<string, string | undefined>, http: typeof fetch = fetch) {
  const gate = stripeOpsGate(env);
  const fakturownia = await checkFakturowniaConnection(env, http as unknown as FakturowniaFetch);
  const report: Json = {
    env: {
      STRIPE_SECRET_KEY: present(env.STRIPE_SECRET_KEY), STRIPE_WEBHOOK_SECRET: present(env.STRIPE_WEBHOOK_SECRET),
      FAKTUROWNIA_ACCOUNT: present(env.FAKTUROWNIA_ACCOUNT), FAKTUROWNIA_API_TOKEN: present(env.FAKTUROWNIA_API_TOKEN),
      SC19_P24_CHECKOUT_DATABASE_URL: present(env.SC19_P24_CHECKOUT_DATABASE_URL),
      SC19_PACKAGES_ENABLED: env.SC19_PACKAGES_ENABLED === 'true',
    },
    stripeMode: gate.ok ? gate.mode : null,
    production: gate.ok ? gate.production : false,
    // The checkout configuration (keys, deployment, database login) as the payment routes see it.
    checkoutConfig: (() => { const g = sc19StripeGate(env as NodeJS.ProcessEnv); return g.ok ? 'ok' : g.reason; })(),
    fakturownia: fakturownia.ok ? { ok: true, departments: fakturownia.departments.length } : { ok: false, code: fakturownia.code },
  };
  if (!gate.ok) return { ...report, stripe: { ok: false, reason: gate.reason } };
  const call = stripeClient(gate.key, http);
  try {
    const live = gate.mode === 'live';
    const prices: Json = {};
    for (const code of CODES) {
      const price = await findPrice(call, code);
      prices[code] = !price ? 'missing' : priceMatches(price, code, live) ? 'ok' : 'mismatch';
    }
    const endpoints = await findEndpoints(call);
    const events = endpoints[0] && Array.isArray(endpoints[0].enabled_events) ? endpoints[0].enabled_events : [];
    return { ...report, stripe: { ok: true, prices, webhook: endpoints.length === 0 ? 'missing' : endpoints.length > 1 ? 'duplicate'
      : STRIPE_WEBHOOK_EVENTS.every(e => events.includes(e)) && endpoints[0].status === 'enabled' ? 'ok' : 'incomplete' } };
  } catch (e) {
    return { ...report, stripe: { ok: false, reason: 'stripe_api', status: e instanceof StripeOpsError ? e.status : 0,
      code: e instanceof StripeOpsError ? e.stripeCode : null } };
  }
}

/** Idempotent setup. Returns the webhook signing secret only when this call created the endpoint. */
export async function stripeOpsSetup(key: string, mode: 'test' | 'live', http: typeof fetch = fetch) {
  const call = stripeClient(key, http);
  const live = mode === 'live';
  const products: Json[] = [];
  for (const code of CODES) {
    const pkg = STRIPE_CATALOG[code];
    const status = availability(code, live);
    const existingPrice = await findPrice(call, code);
    if (existingPrice) {
      products.push({ code, product: 'exists', price: priceMatches(existingPrice, code, live) ? 'exists' : 'mismatch' });
      continue;
    }
    let product = await findProduct(call, code);
    let productState = 'exists';
    if (!product) {
      product = await call('POST', '/v1/products', {
        name: productName(code),
        description: status === 'wkrotce' ? `${pkg.name} — wkrótce, nie można jeszcze kupić.` : `${pkg.name} — pakiet ${pkg.cvCredits} analiz CV.`,
        metadata: { app: STRIPE_APP, package_code: code, availability: status },
      }, `${STRIPE_APP}:product:${mode}:${code}`);
      productState = 'created';
    }
    if (typeof product.id !== 'string' || meta(product).app !== STRIPE_APP) throw new StripeOpsError(500, 'product_invalid');
    const price = await call('POST', '/v1/prices', {
      product: product.id, currency: 'pln', unit_amount: pkg.grossMinor, tax_behavior: 'inclusive',
      lookup_key: stripeLookupKey(code), metadata: { app: STRIPE_APP, package_code: code },
    }, `${STRIPE_APP}:price:${mode}:${code}:${pkg.grossMinor}`);
    products.push({ code, product: productState, price: priceMatches(price, code, live) ? 'created' : 'mismatch' });
  }
  const endpoints = await findEndpoints(call);
  let webhook: Json;
  if (endpoints.length > 1) webhook = { state: 'duplicate' };
  else if (endpoints.length === 1) {
    const endpoint = endpoints[0];
    const events = Array.isArray(endpoint.enabled_events) ? endpoint.enabled_events as string[] : [];
    if (STRIPE_WEBHOOK_EVENTS.every(e => events.includes(e)) && meta(endpoint).app === STRIPE_APP) webhook = { state: 'exists', id: endpoint.id };
    else {
      // Add our events (keeping any already there); never returns the secret.
      await call('POST', `/v1/webhook_endpoints/${encodeURIComponent(String(endpoint.id))}`, {
        enabled_events: Array.from(new Set([...events.filter(e => e !== "*"), ...STRIPE_WEBHOOK_EVENTS])), metadata: { app: STRIPE_APP },
      });
      webhook = { state: 'updated', id: endpoint.id };
    }
  } else {
    const created = await call('POST', '/v1/webhook_endpoints', {
      url: STRIPE_WEBHOOK_URL, enabled_events: [...STRIPE_WEBHOOK_EVENTS], api_version: STRIPE_API_VERSION,
      description: 'SkillCheck core: zakup pakietów i zwroty', metadata: { app: STRIPE_APP },
    }, `${STRIPE_APP}:webhook:${mode}`);
    const secret = typeof created.secret === 'string' && /^whsec_[A-Za-z0-9]{16,}$/.test(created.secret) ? created.secret : null;
    webhook = { state: 'created', id: created.id, secret, apiVersion: created.api_version ?? null };
  }
  return { mode, products, webhook };
}
