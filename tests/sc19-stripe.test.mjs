// R7: Stripe Checkout on the SC-019 payment orchestration. Offline: Stripe is a
// fake behind an injected fetch, the store is an in-memory transactional fake. No
// network, no database, no real key (keys below are synthetic test-mode strings).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createSc19Payments, Sc19PaymentError } from '../lib/sc19-payments.ts';
import { createSc19PaymentHttp } from '../lib/sc19-payment-http.ts';
import { createStripeProvider, stripeModeOf, verifyStripeSignature, stripeForm, STRIPE_CHECKOUT_ORIGIN } from '../lib/sc19-stripe-provider.ts';
import { STRIPE_APP, STRIPE_CATALOG, packagesForPool, stripeQuote } from '../lib/stripe-catalog.ts';
import { sc19StripeGate } from '../lib/sc19-stripe-config.ts';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SECRET = 'sk_test_' + 'a'.repeat(24);
const WHSEC = 'whsec_' + 'b'.repeat(32);
const ORIGIN = 'https://skillcheck.pl';
const scope = { provider: 'stripe', account: 'ktig-consulting', mode: 'test' };
const offer = () => ({ id: 'preselection-v1', revision: 'revision-v1', plan: 'PRESELEKCJA', active: true, approved: true,
  amountMinor: 30000, currency: 'PLN', credits: 60, termsRevision: 'terms-v1', validUntilMs: Date.now() + 3_600_000 });
const buy = (extra = {}) => ({ companyId: id(1), offerId: 'preselection-v1', requestId: id(10), termsRevision: 'terms-v1',
  packageCode: 'PRESELEKCJA', ...extra });

function fakeStripe() {
  const s = { customers: new Map(), sessions: new Map(), prices: [], keys: new Map(), calls: [], seq: 0 };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const missing = () => json({ error: { code: 'resource_missing' } }, 404);
  s.fetch = async (url, init) => {
    const u = new URL(url); const method = init.method; const body = Object.fromEntries(new URLSearchParams(init.body ?? ''));
    const key = init.headers['Idempotency-Key'];
    assert.equal(init.headers.Authorization, `Bearer ${SECRET}`);
    s.calls.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, key });
    if (key && s.keys.has(key)) return json(s.keys.get(key));
    const remember = obj => { if (key) s.keys.set(key, obj); return json(obj); };
    const path = u.pathname;
    if (method === 'GET' && path === '/v1/customers/search') {
      const company = /company_id'\]:'([^']+)'/.exec(u.searchParams.get('query'))[1];
      return json({ data: [...s.customers.values()].filter(c => c.metadata.company_id === company) });
    }
    if (method === 'POST' && path === '/v1/customers') {
      const c = { id: `cus_fake${++s.seq}x`, object: 'customer', metadata: { app: body['metadata[app]'], company_id: body['metadata[company_id]'] },
        name: body.name, email: body.email, tax: body['tax_id_data[0][value]'] ?? null };
      s.customers.set(c.id, c); return remember(c);
    }
    let m;
    if ((m = /^\/v1\/customers\/(cus_[A-Za-z0-9]+)$/.exec(path))) {
      const c = s.customers.get(m[1]); if (!c) return missing();
      if (method === 'POST') Object.assign(c, { name: body.name, email: body.email });
      return json(c);
    }
    if (method === 'GET' && path === '/v1/prices') return json({ data: s.prices });
    if (method === 'POST' && path === '/v1/checkout/sessions') {
      const qty = Number(body['line_items[0][quantity]']);
      const unit = body['line_items[0][price]'] ? s.prices.find(p => p.id === body['line_items[0][price]']).unit_amount
        : Number(body['line_items[0][price_data][unit_amount]']);
      const metadata = {}; for (const [k, v] of Object.entries(body)) { const mm = /^metadata\[(.+)\]$/.exec(k); if (mm) metadata[mm[1]] = v; }
      const sid = `cs_test_fake${++s.seq}session`;
      const session = { id: sid, object: 'checkout.session', mode: body.mode, currency: body.currency, livemode: false,
        customer: body.customer, client_reference_id: body.client_reference_id, metadata, amount_total: unit * qty,
        url: `${STRIPE_CHECKOUT_ORIGIN}/c/pay/${sid}`, status: 'open', payment_status: 'unpaid', payment_intent: null, params: body };
      s.sessions.set(sid, session); return remember(session);
    }
    if (method === 'GET' && path === '/v1/checkout/sessions') {
      return json({ has_more: false, data: [...s.sessions.values()].filter(x => x.customer === u.searchParams.get('customer')) });
    }
    if (method === 'GET' && (m = /^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(path))) {
      const x = s.sessions.get(m[1]); return x ? json(x) : missing();
    }
    return json({ error: { code: 'unexpected_call' } }, 500);
  };
  s.pay = sid => Object.assign(s.sessions.get(sid), { status: 'complete', payment_status: 'paid', payment_intent: `pi_fake${sid.slice(-12)}`, url: null });
  return s;
}

function harness(opts = {}) {
  const stripe = fakeStripe();
  const st = { offer: offer(), orders: new Map(), requests: new Map(), grants: new Map(), credits: new Map(),
    customers: new Map(), paidHook: [], nip: '7394002294' };
  let tail = Promise.resolve();
  const store = { async transaction(fn) {
    let release; const wait = tail; tail = new Promise(r => { release = r; }); await wait;
    const before = structuredClone({ orders: st.orders, requests: st.requests, grants: st.grants, credits: st.credits });
    const tx = {
      async companyAccess(c, u) { return c === id(1) && u === id(2) ? { owner: true, verified: true } : { owner: false, verified: false }; },
      async offer(k) { return k === st.offer.id ? structuredClone(st.offer) : null; },
      async orderByRequest(c, r) { return structuredClone(st.orders.get(st.requests.get(`${c}:${r}`)) ?? null); },
      async unresolvedOrder(c) { return structuredClone([...st.orders.values()].find(o => o.companyId === c && o.status === 'awaiting_payment') ?? null); },
      async bindRequest(c, r, o) { const k = `${c}:${r}`; if (st.requests.has(k)) throw Error('unique'); st.requests.set(k, o); },
      async order(k) { return structuredClone(st.orders.get(k) ?? null); },
      async insertOrder(o) { st.orders.set(o.id, structuredClone(o)); },
      async saveOrder(o) { st.orders.set(o.id, structuredClone(o)); },
      async grantOnce(key, o) {
        if (st.grants.has(key)) return st.grants.get(key);
        st.grants.set(key, o.id); st.credits.set(o.companyId, (st.credits.get(o.companyId) ?? 0) + o.credits); return null;
      },
    };
    try { return await fn(tx); } catch (e) { Object.assign(st, before); throw e; } finally { release(); }
  } };
  const customers = {
    async find(c, mode) { return st.customers.get(`${c}:${mode}`) ?? null; },
    async save(c, mode, cid) { const k = `${c}:${mode}`; if (!st.customers.has(k)) st.customers.set(k, cid); return st.customers.get(k); },
    async replace(c, mode, stale, cid) { const k = `${c}:${mode}`; if (st.customers.get(k) === stale) st.customers.set(k, cid); return st.customers.get(k); },
  };
  const provider = createStripeProvider({ secretKey: SECRET, webhookSecret: WHSEC, mode: 'test', appOrigin: ORIGIN, scope,
    customers, fetch: stripe.fetch, nowMs: () => opts.now ?? Date.now(),
    async buyer(order) { assert.equal(order.buyerId, id(2)); return { email: 'buyer@example.test', companyName: 'Firma Testowa', nip: st.nip }; } });
  const service = createSc19Payments({ store, provider, scope, checkoutOrigins: [STRIPE_CHECKOUT_ORIGIN], enabled: true, liveApproved: false,
    authenticate: async () => ({ userId: id(2) }), onPaid: async order => { st.paidHook.push(order.id); } });
  return { st, stripe, service, provider };
}

function signed(event, secret = WHSEC, t = Math.floor(Date.now() / 1000)) {
  const raw = new TextEncoder().encode(JSON.stringify(event));
  const sig = createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex');
  return { raw, header: `t=${t},v1=${sig}` };
}
const completed = (session, extra = {}) => ({ id: 'evt_fake' + Math.random().toString(36).slice(2, 10), type: 'checkout.session.completed',
  livemode: false, data: { object: { id: session.id, metadata: { ...session.metadata } } }, ...extra });

test('catalog equals docs/cennik-2026-11-02.md; WERYFIKACJA and ASSESSMENT CENTER are „wkrótce”', () => {
  const doc = readFileSync(new URL('../docs/cennik-2026-11-02.md', import.meta.url), 'utf8');
  const row = name => { const m = new RegExp(`^\\| ${name} \\| ([0-9 ]+) zł \\| ([0-9]+) \\|`, 'm').exec(doc); return [Number(m[1].replace(/ /g, '')) * 100, Number(m[2])]; };
  assert.deepEqual(row('PRESELEKCJA'), [STRIPE_CATALOG.PRESELEKCJA.grossMinor, STRIPE_CATALOG.PRESELEKCJA.cvCredits]);
  assert.deepEqual(row('WERYFIKACJA'), [STRIPE_CATALOG.WERYFIKACJA.grossMinor, STRIPE_CATALOG.WERYFIKACJA.cvCredits]);
  assert.deepEqual(row('ASSESSMENT CENTER'), [STRIPE_CATALOG.ASSESSMENT_CENTER.grossMinor, STRIPE_CATALOG.ASSESSMENT_CENTER.cvCredits]);
  assert.equal(STRIPE_CATALOG.PRESELEKCJA.available, true);
  assert.equal(STRIPE_CATALOG.WERYFIKACJA.available, false);
  assert.equal(STRIPE_CATALOG.ASSESSMENT_CENTER.available, false);
  assert.equal(STRIPE_APP, 'skillcheck-core');
});

test('pool slider (co 5) becomes whole PRESELEKCJA packages of 60 CV', () => {
  assert.equal(packagesForPool(5), 1); assert.equal(packagesForPool(60), 1); assert.equal(packagesForPool(65), 2);
  assert.equal(packagesForPool(120), 2); assert.equal(packagesForPool(125), 3); assert.equal(packagesForPool(1200), 20);
  for (const bad of [0, 3, 62, 1205, -60, 60.5, '60', null]) assert.equal(packagesForPool(bad), null, String(bad));
  assert.deepEqual(stripeQuote('PRESELEKCJA', 2), { code: 'PRESELEKCJA', packages: 2, grossMinor: 60000, cvCredits: 120 });
  assert.equal(stripeQuote('PRESELEKCJA', 0), null); assert.equal(stripeQuote('FREE', 1), null);
});

test('mode comes from the key prefix only', () => {
  assert.equal(stripeModeOf('sk_live_' + 'x'.repeat(20)), 'live'); assert.equal(stripeModeOf('rk_live_' + 'x'.repeat(20)), 'live');
  assert.equal(stripeModeOf(SECRET), 'test'); assert.equal(stripeModeOf('pk_live_' + 'x'.repeat(20)), null);
  assert.equal(stripeModeOf(undefined), null); assert.equal(stripeModeOf('sk_live_short'), null);
});

test('Stripe-Signature: good, wrong secret, tampered body, stale timestamp', () => {
  const now = Math.floor(Date.now() / 1000);
  const { raw, header } = signed({ id: 'evt_x' }, WHSEC, now);
  assert.equal(verifyStripeSignature(raw, header, WHSEC, now), true);
  assert.equal(verifyStripeSignature(raw, `${header},v1=${'0'.repeat(64)}`, WHSEC, now), true);
  assert.equal(verifyStripeSignature(raw, signed({ id: 'evt_x' }, 'whsec_' + 'c'.repeat(32), now).header, WHSEC, now), false);
  assert.equal(verifyStripeSignature(new TextEncoder().encode('{"id":"evt_y"}'), header, WHSEC, now), false);
  assert.equal(verifyStripeSignature(raw, header, WHSEC, now + 301), false);
  assert.equal(verifyStripeSignature(raw, 'garbage', WHSEC, now), false);
});

test('checkout: server amount for 2 packages, metadata on session AND PaymentIntent, one customer, branding, legal links', async () => {
  const { st, stripe, service } = harness();
  const result = await service.checkout(buy({ packages: 2 }));
  assert.match(result.url, /^https:\/\/checkout\.stripe\.com\//);
  assert.equal(result.amountMinor, 60000);
  const order = st.orders.get(result.orderId);
  assert.equal(order.amountMinor, 60000); assert.equal(order.credits, 120); assert.equal(order.scope.provider, 'stripe');
  const create = stripe.calls.find(c => c.method === 'POST' && c.path === '/v1/checkout/sessions');
  const p = create.body;
  assert.equal(create.key, `skillcheck-core:sc19:${order.id}`);
  assert.equal(p.mode, 'payment'); assert.equal(p.currency, 'pln'); assert.equal(p.locale, 'pl');
  for (const prefix of ['metadata', 'payment_intent_data[metadata]']) {
    assert.equal(p[`${prefix}[app]`], 'skillcheck-core');
    assert.equal(p[`${prefix}[company_id]`], id(1));
    assert.equal(p[`${prefix}[order_id]`], order.id);
    assert.equal(p[`${prefix}[package_code]`], 'PRESELEKCJA');
    assert.equal(p[`${prefix}[packages]`], '2');
    assert.equal(p[`${prefix}[pool_cv]`], '120');
  }
  assert.equal(p['line_items[0][quantity]'], '2');
  assert.equal(p['line_items[0][price_data][unit_amount]'], '30000');
  assert.equal(p['line_items[0][price_data][tax_behavior]'], 'inclusive');
  assert.equal(p.billing_address_collection, 'required');
  // Immediate methods only (no delayed bank transfer): the package is granted solely on completed.
  assert.deepEqual([0, 1, 2, 3].map(i => p[`payment_method_types[${i}]`]), ['card', 'blik', 'p24', 'link']);
  assert.equal(p['payment_method_types[4]'], undefined);
  assert.equal(p['tax_id_collection[enabled]'], 'true');
  assert.equal(p['customer_update[name]'], 'auto'); assert.equal(p['customer_update[address]'], 'auto');
  assert.equal(p.client_reference_id, order.id);
  assert.equal(p['branding_settings[button_color]'], '#204bba');
  assert.equal(p['branding_settings[logo][url]'], `${ORIGIN}/brand/stripe-logo.png`);
  assert.equal(p['branding_settings[icon][url]'], `${ORIGIN}/brand/stripe-icon.png`);
  assert.match(p['custom_text[submit][message]'], /skillcheck\.pl\/regulamin/);
  assert.match(p['custom_text[submit][message]'], /skillcheck\.pl\/polityka-prywatnosci/);
  assert.equal(p.success_url, `${ORIGIN}/dashboard/${id(1)}/billing/checkout?stripe=${order.id}`);
  assert.ok(!('origin_context' in p) && !('integration_identifier' in p));
  assert.ok(!Object.keys(p).some(k => k.startsWith('invoice_creation')), 'no Stripe invoices');
  // Customer: company name, e-mail and NIP from registration; idempotent create; stored.
  const created = stripe.calls.filter(c => c.method === 'POST' && c.path === '/v1/customers');
  assert.equal(created.length, 1);
  assert.equal(created[0].key, `skillcheck-core:customer:test:${id(1)}`);
  assert.equal(created[0].body['tax_id_data[0][type]'], 'eu_vat');
  assert.equal(created[0].body['tax_id_data[0][value]'], 'PL7394002294');
  assert.equal(created[0].body.name, 'Firma Testowa');
  assert.equal(p.customer, st.customers.get(`${id(1)}:test`));
});

test('one Stripe customer per company: stored id is reused, a lost id is found by metadata search', async () => {
  const { st, stripe, service } = harness();
  const first = await service.checkout(buy());
  // Settle the first order so the company may start another purchase.
  const sid = st.orders.get(first.orderId).sessionId; stripe.pay(sid);
  const ev = signed(completed(stripe.sessions.get(sid)));
  await service.notification(ev.raw, ev.header);
  await service.checkout(buy({ requestId: id(11) }));
  assert.equal(stripe.calls.filter(c => c.method === 'POST' && c.path === '/v1/customers').length, 1);
  // The stored mapping is lost: the search by metadata finds the same customer.
  st.customers.clear();
  const done = [...st.orders.values()].find(o => o.status === 'awaiting_payment');
  stripe.pay(done.sessionId); const ev2 = signed(completed(stripe.sessions.get(done.sessionId)));
  await service.notification(ev2.raw, ev2.header);
  await service.checkout(buy({ requestId: id(12) }));
  assert.equal(stripe.calls.filter(c => c.method === 'POST' && c.path === '/v1/customers').length, 1);
  assert.equal(stripe.customers.size, 1);
});

test('a stored customer that Stripe confirms deleted is replaced (new idempotency key); any other mismatch fails closed', async () => {
  const { st, stripe, service } = harness();
  const first = await service.checkout(buy());
  const old = st.customers.get(`${id(1)}:test`);
  stripe.pay(st.orders.get(first.orderId).sessionId);
  const ev = signed(completed(stripe.sessions.get(st.orders.get(first.orderId).sessionId)));
  await service.notification(ev.raw, ev.header);
  stripe.customers.get(old).deleted = true; // e.g. removed in the Stripe dashboard
  const second = await service.checkout(buy({ requestId: id(15) }));
  const fresh = st.customers.get(`${id(1)}:test`);
  assert.notEqual(fresh, old);
  const creates = stripe.calls.filter(c => c.method === 'POST' && c.path === '/v1/customers');
  assert.equal(creates.length, 2);
  assert.equal(creates[1].key, `skillcheck-core:customer:test:${id(1)}:after:${old}`);
  assert.equal(stripe.calls.findLast(c => c.path === '/v1/checkout/sessions' && c.method === 'POST').body.customer, fresh);
  assert.equal(second.amountMinor, 30000);
  // A stored id that exists but is not ours is never overwritten.
  stripe.pay(second.sessionId);
  const ev2 = signed(completed(stripe.sessions.get(second.sessionId)));
  await service.notification(ev2.raw, ev2.header);
  stripe.customers.get(fresh).metadata.company_id = id(9);
  await assert.rejects(service.checkout(buy({ requestId: id(16) })), e => e.code === 'SC19_PAYMENT_RETRY');
  assert.equal(st.customers.get(`${id(1)}:test`), fresh);
});

test('„wkrótce” packages are refused by the server with 409; invalid pools are refused', async () => {
  const { service, stripe } = harness();
  for (const code of ['WERYFIKACJA', 'ASSESSMENT_CENTER'])
    await assert.rejects(service.checkout(buy({ packageCode: code })), e => e instanceof Sc19PaymentError && e.code === 'SC19_PAYMENT_PACKAGE_UNAVAILABLE');
  for (const packages of [0, 21, 1.5, '2']) await assert.rejects(service.checkout(buy({ packages })), e => e.code === 'SC19_PAYMENT_INVALID');
  await assert.rejects(service.checkout(buy({ packageCode: 'FREE' })), e => e.code === 'SC19_PAYMENT_INVALID');
  await assert.rejects(service.checkout(buy({ amountMinor: 1 })), e => e.code === 'SC19_PAYMENT_INVALID');
  assert.equal(stripe.calls.length, 0);
  // Over HTTP the refusal is 409.
  const runtime = { service, authenticate: async () => ({ userId: id(2) }), readOrder: async () => null, listOffers: async () => [],
    appOrigin: ORIGIN, signatureHeader: 'stripe-signature' };
  const response = await createSc19PaymentHttp(runtime).checkout(new Request(`${ORIGIN}/api/billing/checkout`, { method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify(buy({ packageCode: 'WERYFIKACJA' })) }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'SC19_PAYMENT_PACKAGE_UNAVAILABLE');
});

test('same request id with a different package count is a conflict, never a silently different purchase', async () => {
  const { service } = harness();
  await service.checkout(buy({ packages: 2 }));
  await assert.rejects(service.checkout(buy({ packages: 3 })), e => e.code === 'SC19_PAYMENT_REQUEST_CONFLICT');
  await assert.rejects(service.checkout(buy({ packages: 3, requestId: id(13) })), e => e.code === 'SC19_PAYMENT_PURCHASE_PENDING');
  const again = await service.checkout(buy({ packages: 2 }));
  assert.equal(again.amountMinor, 60000);
});

test('a Stripe price with the lookup key must match the code catalog', async () => {
  const { stripe, service } = harness();
  stripe.prices.push({ id: 'price_fake1', unit_amount: 29900, currency: 'pln', type: 'one_time', livemode: false,
    metadata: { app: STRIPE_APP, package_code: 'PRESELEKCJA' } });
  await assert.rejects(service.checkout(buy()), e => e.code === 'SC19_PAYMENT_CHECKOUT_INVALID');
  stripe.prices[0].unit_amount = 30000;
  const ok = await service.checkout(buy({ requestId: id(14) }));
  assert.equal(ok.amountMinor, 30000);
  const create = stripe.calls.find(c => c.path === '/v1/checkout/sessions' && c.method === 'POST');
  assert.equal(create.body['line_items[0][price]'], 'price_fake1');
  assert.equal(stripe.calls.find(c => c.path === '/v1/prices').query['lookup_keys[0]'], 'skillcheck-core:PRESELEKCJA');
});

test('an offer that is not the catalog price never reaches Stripe', async () => {
  const { st, stripe, service } = harness();
  st.offer.amountMinor = 25000;
  await assert.rejects(service.checkout(buy()), e => e.code === 'SC19_PAYMENT_CHECKOUT_INVALID');
  assert.equal(stripe.calls.filter(c => c.path === '/v1/checkout/sessions').length, 0);
});

test('webhook: package granted only after checkout.session.completed, exactly once; hook runs once', async () => {
  const { st, stripe, service } = harness();
  const r = await service.checkout(buy({ packages: 2 }));
  const sid = st.orders.get(r.orderId).sessionId;
  // Only immediate methods are offered, so checkout.session.completed is the paid moment.
  assert.equal(st.credits.get(id(1)) ?? 0, 0);
  stripe.pay(sid);
  const event = completed(stripe.sessions.get(sid));
  const ev = signed(event);
  assert.equal((await service.notification(ev.raw, ev.header)).state, 'applied');
  assert.equal(st.credits.get(id(1)), 120);
  assert.equal(st.orders.get(r.orderId).status, 'paid');
  // Same event again, and a new event id for the same payment: no second grant.
  assert.equal((await service.notification(ev.raw, ev.header)).state, 'already_applied');
  const again = signed({ ...event, id: 'evt_fakeduplicate' });
  assert.equal((await service.notification(again.raw, again.header)).state, 'already_applied');
  assert.equal(st.credits.get(id(1)), 120);
  assert.deepEqual(st.paidHook, [r.orderId]);
});

test('webhook: bad signature is refused (400) before anything is read', async () => {
  const { st, stripe, service } = harness();
  const r = await service.checkout(buy());
  const sid = st.orders.get(r.orderId).sessionId; stripe.pay(sid);
  const ev = signed(completed(stripe.sessions.get(sid)), 'whsec_' + 'd'.repeat(32));
  const before = stripe.calls.length;
  await assert.rejects(service.notification(ev.raw, ev.header), e => e.code === 'SC19_PAYMENT_NOTIFICATION_INVALID');
  assert.equal(stripe.calls.length, before);
  assert.equal(st.credits.get(id(1)) ?? 0, 0);
  const runtime = { service, authenticate: async () => null, readOrder: async () => null, listOffers: async () => [],
    appOrigin: ORIGIN, signatureHeader: 'stripe-signature' };
  const response = await createSc19PaymentHttp(runtime).webhook(new Request(`${ORIGIN}/api/billing/stripe/webhook`,
    { method: 'POST', headers: { 'stripe-signature': ev.header }, body: ev.raw }));
  assert.equal(response.status, 400);
});

test('webhook: the other application on the same account and other event types get 200 with no action', async () => {
  const { st, stripe, service } = harness();
  const runtime = { service, authenticate: async () => null, readOrder: async () => null, listOffers: async () => [],
    appOrigin: ORIGIN, signatureHeader: 'stripe-signature' };
  const http = createSc19PaymentHttp(runtime);
  const send = async event => { const ev = signed(event); return http.webhook(new Request(`${ORIGIN}/api/billing/stripe/webhook`,
    { method: 'POST', headers: { 'stripe-signature': ev.header }, body: ev.raw })); };
  const other = await send({ id: 'evt_fakeother1', type: 'checkout.session.completed', livemode: true,
    data: { object: { id: 'cs_live_fakeother', metadata: { app: 'skillcheck-preselekcja', payment_id: id(99) } } } });
  assert.equal(other.status, 200); assert.deepEqual(await other.json(), { state: 'ignored' });
  for (const type of ['checkout.session.expired', 'checkout.session.async_payment_succeeded', 'payment_intent.succeeded', 'charge.refunded']) {
    const res = await send({ id: 'evt_fake' + type.replace(/[^A-Za-z0-9]/g, ''), type, livemode: false,
      data: { object: { id: 'cs_test_fakeany', metadata: { app: STRIPE_APP, order_id: id(50) } } } });
    assert.equal(res.status, 200, type);
  }
  assert.equal(stripe.calls.length, 0, 'no Stripe API read for ignored events');
  assert.equal(st.grants.size, 0);
});

test('webhook: a live event on a test configuration is refused', async () => {
  const { service } = harness();
  const ev = signed({ id: 'evt_fakelive1', type: 'checkout.session.completed', livemode: true,
    data: { object: { id: 'cs_live_fakesession', metadata: { app: STRIPE_APP, order_id: id(51) } } } });
  await assert.rejects(service.notification(ev.raw, ev.header), e => e.code === 'SC19_PAYMENT_NOTIFICATION_INVALID');
});

test('a forged amount in the delivered body is ignored: payment truth is read from the Stripe API', async () => {
  const { st, stripe, service } = harness();
  const r = await service.checkout(buy({ packages: 2 }));
  const sid = st.orders.get(r.orderId).sessionId; stripe.pay(sid);
  stripe.sessions.get(sid).amount_total = 30000; // Stripe says one package was charged
  const ev = signed(completed(stripe.sessions.get(sid)));
  await assert.rejects(service.notification(ev.raw, ev.header), e => e.code === 'SC19_PAYMENT_ORDER_MISMATCH');
  assert.equal(st.credits.get(id(1)) ?? 0, 0);
});

test('an expired Stripe session is never re-bound (order row is immutable): fail closed, no new session; a live one is reused', async () => {
  const { st, stripe, service } = harness();
  const first = await service.checkout(buy());
  const again = await service.checkout(buy());
  assert.equal(again.sessionId, first.sessionId);
  stripe.sessions.get(first.sessionId).status = 'expired';
  stripe.sessions.get(first.sessionId).url = null;
  await assert.rejects(service.checkout(buy()), e => e.code === 'SC19_PAYMENT_RECONCILIATION_REQUIRED');
  assert.equal(st.orders.get(first.orderId).sessionId, first.sessionId, 'session_id unchanged (trigger sc19_order_immutable)');
  assert.equal(stripe.calls.filter(c => c.method === 'POST' && c.path === '/v1/checkout/sessions').length, 1);
});

test('P24 notifications stay on the P24 runtime; a status read of another provider\'s order does not fail', async () => {
  const route = readFileSync(new URL('../app/api/billing/webhook/route.ts', import.meta.url), 'utf8');
  assert.match(route, /resolveSc19P24Runtime\(request\)\)\.webhook/);
  assert.doesNotMatch(route, /resolveSc19PaymentRuntime|resolveSc19StripeRuntime/);
  const { service } = harness();
  const p24Order = { id: id(70), companyId: id(1), buyerId: id(2), requestId: id(71), offerId: 'preselection-v1', offerRevision: 'revision-v1',
    termsRevision: 'terms-v1', amountMinor: 30000, currency: 'PLN', credits: 60, scope: { provider: 'przelewy24', account: '1', mode: 'test' },
    status: 'awaiting_payment', sessionId: 'p24-session', checkoutUrl: 'https://sandbox.przelewy24.pl/trnRequest/x', paymentId: null, checkoutDeadlineMs: 1 };
  const runtime = { service, authenticate: async () => ({ userId: id(2) }), readOrder: async () => p24Order, listOffers: async () => [],
    appOrigin: ORIGIN, signatureHeader: 'stripe-signature' };
  const res = await createSc19PaymentHttp(runtime).order(new Request(`${ORIGIN}/api/billing/orders/${id(70)}?companyId=${id(1)}`,
    { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' } }), id(70));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'awaiting_payment');
});

test('KTIG control purchase (seller NIP) grants the package like any other; no invoice code exists yet', async () => {
  const { st, stripe, service } = harness();
  st.nip = '7394002294';
  const r = await service.checkout(buy());
  stripe.pay(st.orders.get(r.orderId).sessionId);
  const ev = signed(completed(stripe.sessions.get(st.orders.get(r.orderId).sessionId)));
  assert.equal((await service.notification(ev.raw, ev.header)).state, 'applied');
  assert.equal(st.credits.get(id(1)), 60);
  assert.ok(!stripe.calls.some(c => /invoice/.test(c.path)), 'no Stripe invoice call');
});

test('configuration gate: keys from env only, test keys only on Preview, pinned origin on production', () => {
  const base = { VERCEL: '1', STRIPE_SECRET_KEY: SECRET, STRIPE_WEBHOOK_SECRET: WHSEC };
  const preview = { ...base, VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'integration',
    NEXT_PUBLIC_SUPABASE_URL: 'https://orbyscrupgnupifzlqxp.supabase.co', VERCEL_BRANCH_URL: 'core-git-integration.vercel.app',
    SC19_P24_PREVIEW_DATABASE_URL: 'postgresql://sc19_p24_preview.orbyscrupgnupifzlqxp:pw@aws-1-eu-west-1.pooler.supabase.com:6543/postgres' };
  const p = sc19StripeGate(preview);
  assert.equal(p.ok, true); assert.equal(p.config.mode, 'test'); assert.equal(p.config.appOrigin, 'https://core-git-integration.vercel.app');
  assert.equal(sc19StripeGate({ ...preview, STRIPE_SECRET_KEY: 'sk_live_' + 'a'.repeat(24) }).reason, 'stripe_mode');
  const missing = sc19StripeGate({ ...preview, STRIPE_SECRET_KEY: undefined });
  assert.equal(missing.reason, 'stripe_secret_key'); assert.equal(missing.shape, 'missing');
  const wrongKey = sc19StripeGate({ ...preview, STRIPE_WEBHOOK_SECRET: 'nope-not-a-secret-value' });
  assert.equal(wrongKey.reason, 'stripe_webhook_secret'); assert.ok(!JSON.stringify(wrongKey).includes('nope'));
  const production = { ...base, STRIPE_SECRET_KEY: 'rk_live_' + 'a'.repeat(24), VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main',
    NEXT_PUBLIC_SUPABASE_URL: 'https://wsvjawuikxfzjyivxgsu.supabase.co', NEXT_PUBLIC_SITE_URL: 'https://skillcheck.pl',
    SC19_P24_CHECKOUT_DATABASE_URL: 'postgresql://sc19_p24_checkout.wsvjawuikxfzjyivxgsu:pw@aws-1-eu-west-1.pooler.supabase.com:6543/postgres' };
  const prod = sc19StripeGate(production);
  assert.equal(prod.ok, true); assert.equal(prod.config.mode, 'live'); assert.equal(prod.config.appOrigin, ORIGIN);
  assert.equal(sc19StripeGate(production, 'https://evil.example').reason, 'request_origin');
  assert.equal(sc19StripeGate({ ...production, VERCEL: undefined }).reason, 'not_vercel');
});

test('a live key never opens a checkout (live payments stay closed)', async () => {
  const stripe = fakeStripe();
  const liveKey = 'sk_live_' + 'a'.repeat(24);
  const liveScope = { ...scope, mode: 'live' };
  const provider = createStripeProvider({ secretKey: liveKey, webhookSecret: WHSEC, mode: 'live', appOrigin: ORIGIN, scope: liveScope,
    customers: { find: async () => null, save: async (_c, _m, x) => x }, fetch: stripe.fetch, buyer: async () => ({}) });
  const service = createSc19Payments({ store: { transaction: async () => assert.fail('no store access') }, provider, scope: liveScope,
    checkoutOrigins: [STRIPE_CHECKOUT_ORIGIN], enabled: true, liveApproved: false, authenticate: async () => ({ userId: id(2) }) });
  assert.equal(service.checkoutEnabled, false);
  await assert.rejects(service.checkout(buy()), e => e.code === 'SC19_PAYMENTS_DISABLED');
  assert.equal(stripe.calls.length, 0);
});

test('form encoding and source hygiene: no key in code, no Stripe invoices, P24 adapter untouched', () => {
  assert.equal(stripeForm({ a: { b: [{ c: 1 }] }, d: 'x y' }), 'a%5Bb%5D%5B0%5D%5Bc%5D=1&d=x+y');
  for (const file of ['lib/sc19-stripe-provider.ts', 'lib/sc19-stripe-config.ts', 'lib/sc19-stripe-runtime.ts', 'lib/stripe-catalog.ts',
    'app/api/billing/stripe/webhook/route.ts']) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /(sk|rk)_(live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}/, file);
    assert.doesNotMatch(src, /invoice_creation|\/v1\/invoices/, file);
    assert.doesNotMatch(src, /origin_context|integration_identifier/, file);
  }
  const sql = readFileSync(new URL('../supabase/migrations/20261121110000_r7_stripe_checkout.sql', import.meta.url), 'utf8')
    .replace(/--[^\n]*/g, '').replace(/\$\$[\s\S]*?\$\$/g, '');
  assert.doesNotMatch(sql, /\b(drop|truncate|delete\s+from|update\s+\w|rename|alter\s+column)\b/i);
  assert.match(sql, /mode = 'test' and provider = 'stripe'/);
});
