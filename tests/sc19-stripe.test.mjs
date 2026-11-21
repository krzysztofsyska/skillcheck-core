// R7: Stripe Checkout on the SC-019 payment orchestration. Offline: Stripe is a
// fake behind an injected fetch, the store is an in-memory transactional fake. No
// network, no database, no real key (keys below are synthetic test-mode strings).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createSc19Payments, Sc19PaymentError } from '../lib/sc19-payments.ts';
import { createSc19PaymentHttp } from '../lib/sc19-payment-http.ts';
import { createStripeProvider, stripeModeOf, verifyStripeSignature, stripeForm, STRIPE_CHECKOUT_ORIGIN } from '../lib/sc19-stripe-provider.ts';
import { STRIPE_APP, STRIPE_CATALOG, checkCvCount, packagesForPool, stripeQuote } from '../lib/stripe-catalog.ts';
import { sc19StripeGate } from '../lib/sc19-stripe-config.ts';
import { STRIPE_PACKAGE_OFFERS } from '../lib/sc19-stripe-packages.ts';

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
    assert.equal(init.headers['Stripe-Version'], '2026-10-28.endive');
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
        url: `${STRIPE_CHECKOUT_ORIGIN}/c/pay/${sid}#fidkdWxOYHwnPyd1blpxYHZxWjA0`, status: 'open', payment_status: 'unpaid', payment_intent: null, params: body };
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
    entitlements: new Map(), customers: new Map(), paidHook: [], nip: '7394002294', closures: [] };
  let tail = Promise.resolve();
  const store = { async transaction(fn) {
    let release; const wait = tail; tail = new Promise(r => { release = r; }); await wait;
    const before = structuredClone({ orders: st.orders, requests: st.requests, grants: st.grants, credits: st.credits, entitlements: st.entitlements });
    const tx = {
      async companyAccess(c, u) { return c === id(1) && u === id(2) ? { owner: true, verified: true } : { owner: false, verified: false }; },
      async offer(k) { return k === st.offer.id ? structuredClone(st.offer) : structuredClone(STRIPE_PACKAGE_OFFERS.find(o => o.id === k) ?? null); },
      async orderByRequest(c, r) { return structuredClone(st.orders.get(st.requests.get(`${c}:${r}`)) ?? null); },
      async unresolvedOrder(c) { return structuredClone([...st.orders.values()].find(o => o.companyId === c && o.status === 'awaiting_payment') ?? null); },
      async bindRequest(c, r, o) { const k = `${c}:${r}`; if (st.requests.has(k)) throw Error('unique'); st.requests.set(k, o); },
      async order(k) { return structuredClone(st.orders.get(k) ?? null); },
      async insertOrder(o) { st.orders.set(o.id, structuredClone(o)); },
      async saveOrder(o) { st.orders.set(o.id, structuredClone(o)); },
      async grantOnce(key, o) {
        if (st.grants.has(key)) return st.grants.get(key);
        st.grants.set(key, o.id); st.credits.set(o.companyId, (st.credits.get(o.companyId) ?? 0) + o.credits);
        // Mirrors sc19_stripe.grant_package(): a non-PRESELEKCJA package also adds its entitlement.
        if (o.packageCode) { const e = `${o.companyId}:package:${o.packageCode}`; st.entitlements.set(e, (st.entitlements.get(e) ?? 0) + 1); }
        return null;
      },
      // Mirrors sc19_stripe.close_expired_order() (migration 20261121180000); absent = pre-migration database.
      ...(opts.noClose ? {} : { async closeExpired(o, sid) {
        const cur = st.orders.get(o.id);
        if (cur.status === 'expired' && cur.sessionId === sid) return 'already_closed';
        if (cur.status !== 'awaiting_payment' || cur.sessionId !== sid || [...st.grants.values()].includes(o.id))
          throw new Sc19PaymentError('SC19_PAYMENT_RECONCILIATION_REQUIRED');
        st.orders.set(o.id, { ...cur, status: 'expired' }); st.closures.push(o.id);
        return 'closed';
      } }),
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
  const service = createSc19Payments({ store, provider, scope, checkoutOrigins: [STRIPE_CHECKOUT_ORIGIN], enabled: true, liveApproved: false, cvPoolEnabled: opts.cvPoolEnabled === true,
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

test('catalog equals docs/cennik-2026-11-02.md; WERYFIKACJA and ASSESSMENT CENTER on sale as one whole package', () => {
  const doc = readFileSync(new URL('../docs/cennik-2026-11-02.md', import.meta.url), 'utf8');
  const row = name => { const m = new RegExp(`^\\| ${name} \\| ([0-9 ]+) zł \\| ([0-9]+) \\|`, 'm').exec(doc); return [Number(m[1].replace(/ /g, '')) * 100, Number(m[2])]; };
  assert.deepEqual(row('PRESELEKCJA'), [STRIPE_CATALOG.PRESELEKCJA.grossMinor, STRIPE_CATALOG.PRESELEKCJA.cvCredits]);
  assert.deepEqual(row('WERYFIKACJA'), [STRIPE_CATALOG.WERYFIKACJA.grossMinor, STRIPE_CATALOG.WERYFIKACJA.cvCredits]);
  assert.deepEqual(row('ASSESSMENT CENTER'), [STRIPE_CATALOG.ASSESSMENT_CENTER.grossMinor, STRIPE_CATALOG.ASSESSMENT_CENTER.cvCredits]);
  assert.equal(STRIPE_CATALOG.PRESELEKCJA.available, true);
  assert.equal(STRIPE_CATALOG.WERYFIKACJA.available, true);
  assert.equal(STRIPE_CATALOG.ASSESSMENT_CENTER.available, true);
  assert.equal(STRIPE_CATALOG.WERYFIKACJA.maxPackages, 1);
  assert.equal(STRIPE_CATALOG.ASSESSMENT_CENTER.maxPackages, 1);
  // The package offers carry the catalog price, and the migration pins the same amounts.
  for (const o of STRIPE_PACKAGE_OFFERS) {
    assert.equal(o.amountMinor, STRIPE_CATALOG[o.plan].grossMinor, o.id);
    assert.equal(o.credits, STRIPE_CATALOG[o.plan].cvCredits, o.id);
    assert.doesNotMatch(o.termsText, /voicebot|\bbot|rozmow/i, 'no voicebot in package copy');
  }
  assert.deepEqual(STRIPE_PACKAGE_OFFERS.map(o => o.plan), ['WERYFIKACJA', 'ASSESSMENT_CENTER']);
  const pinned = readFileSync(new URL('../supabase/migrations/20261121150000_r7_stripe_packages.sql', import.meta.url), 'utf8');
  assert.match(pinned, new RegExp(`package_code='WERYFIKACJA' and amount_minor=${STRIPE_CATALOG.WERYFIKACJA.grossMinor} and credits=${STRIPE_CATALOG.WERYFIKACJA.cvCredits}`));
  assert.match(pinned, new RegExp(`package_code='ASSESSMENT_CENTER' and amount_minor=${STRIPE_CATALOG.ASSESSMENT_CENTER.grossMinor} and credits=${STRIPE_CATALOG.ASSESSMENT_CENTER.cvCredits}`));
  assert.equal(STRIPE_APP, 'skillcheck-core');
});

test('pool slider (co 5) becomes whole PRESELEKCJA packages of 60 CV', () => {
  assert.equal(packagesForPool(5), 1); assert.equal(packagesForPool(60), 1); assert.equal(packagesForPool(65), 2);
  assert.equal(packagesForPool(120), 2); assert.equal(packagesForPool(125), 3); assert.equal(packagesForPool(1200), 20);
  for (const bad of [0, 3, 62, 1205, -60, 60.5, '60', null]) assert.equal(packagesForPool(bad), null, String(bad));
  assert.deepEqual(stripeQuote('PRESELEKCJA', 2), { code: 'PRESELEKCJA', packages: 2, grossMinor: 60000, cvCredits: 120 });
  assert.equal(stripeQuote('PRESELEKCJA', 0), null); assert.equal(stripeQuote('FREE', 1), null);
  assert.deepEqual(stripeQuote('ASSESSMENT_CENTER', 1), { code: 'ASSESSMENT_CENTER', packages: 1, grossMinor: 149900, cvCredits: 50 });
  assert.equal(stripeQuote('WERYFIKACJA', 2), null, 'no multiplied WERYFIKACJA: the overage rule prices a larger pool');
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
  assert.match(result.url, /^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_[A-Za-z0-9_]+#fidkdWxOYHwnPyd1blpxYHZxWjA0$/);
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
  assert.deepEqual([0, 1, 2, 3].map(i => p[`allowed_payment_method_types[${i}]`]), ['card', 'blik', 'p24', 'link']);
  assert.equal(p['allowed_payment_method_types[4]'], undefined);
  assert.ok(!Object.keys(p).some(k => k.startsWith('payment_method_types')));
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

const packageBuy = (code, extra = {}) => {
  const o = STRIPE_PACKAGE_OFFERS.find(x => x.plan === code);
  return buy({ offerId: o.id, termsRevision: o.termsRevision, packageCode: code, ...extra });
};

test('invalid pools, more than one WERYFIKACJA / AC package and package mismatches are refused before Stripe', async () => {
  const { service, stripe } = harness();
  for (const packages of [0, 21, 1.5, '2']) await assert.rejects(service.checkout(buy({ packages })), e => e.code === 'SC19_PAYMENT_INVALID');
  await assert.rejects(service.checkout(buy({ packageCode: 'FREE' })), e => e.code === 'SC19_PAYMENT_INVALID');
  await assert.rejects(service.checkout(buy({ amountMinor: 1 })), e => e.code === 'SC19_PAYMENT_INVALID');
  // One whole package only for WERYFIKACJA and ASSESSMENT CENTER.
  for (const code of ['WERYFIKACJA', 'ASSESSMENT_CENTER'])
    await assert.rejects(service.checkout(packageBuy(code, { packages: 2 })), e => e.code === 'SC19_PAYMENT_INVALID', code);
  // The named package must be the offer's package, both ways; an unnamed request buys PRESELEKCJA only.
  await assert.rejects(service.checkout(buy({ packageCode: 'WERYFIKACJA' })), e => e.code === 'SC19_PAYMENT_INVALID');
  await assert.rejects(service.checkout(packageBuy('ASSESSMENT_CENTER', { packageCode: 'PRESELEKCJA' })), e => e.code === 'SC19_PAYMENT_INVALID');
  const { packageCode, ...unnamed } = packageBuy('WERYFIKACJA'); void packageCode;
  await assert.rejects(service.checkout(unnamed), e => e.code === 'SC19_PAYMENT_INVALID');
  assert.equal(stripe.calls.length, 0);
  // Over HTTP an invalid package is 400.
  const runtime = { service, authenticate: async () => ({ userId: id(2) }), readOrder: async () => null, listOffers: async () => [],
    appOrigin: ORIGIN, signatureHeader: 'stripe-signature' };
  const response = await createSc19PaymentHttp(runtime).checkout(new Request(`${ORIGIN}/api/billing/checkout`, { method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify(packageBuy('WERYFIKACJA', { packages: 2 })) }));
  assert.equal(response.status, 400);
});

test('R5 W2b: checkCvCount allows only slider values (co 5, catalog bounds) and turns them into whole packages', () => {
  const ok = (code, cv, packages = null) => checkCvCount(code, cv, packages);
  assert.deepEqual(ok('PRESELEKCJA', 5), { ok: true, packages: 1 });
  assert.deepEqual(ok('PRESELEKCJA', 60), { ok: true, packages: 1 });
  assert.deepEqual(ok('PRESELEKCJA', 65), { ok: true, packages: 2 });
  assert.deepEqual(ok('PRESELEKCJA', 120, 2), { ok: true, packages: 2 });
  assert.deepEqual(ok('PRESELEKCJA', 1200), { ok: true, packages: 20 });
  assert.deepEqual(ok('WERYFIKACJA', 60), { ok: true, packages: 1 });
  assert.deepEqual(ok('ASSESSMENT_CENTER', 50, 1), { ok: true, packages: 1 });
  const refused = [
    ['PRESELEKCJA', 0, /Najmniejsza pula CV to 5/], ['PRESELEKCJA', 62, /co 5\. 62 nie jest dozwoloną wartością/],
    ['PRESELEKCJA', 1205, /Największa pula CV w jednym zakupie to 1200/], ['PRESELEKCJA', 60.5, /liczbą całkowitą/],
    ['PRESELEKCJA', '60', /liczbą całkowitą/], ['PRESELEKCJA', -5, /liczbą całkowitą/], ['PRESELEKCJA', null, /liczbą całkowitą/],
    ['PRESELEKCJA', Number.MAX_SAFE_INTEGER + 1, /liczbą całkowitą/],
    ['WERYFIKACJA', 65, /WERYFIKACJA ma pulę 60 CV/], ['WERYFIKACJA', 55, /WERYFIKACJA ma pulę 60 CV/],
    ['ASSESSMENT_CENTER', 60, /ASSESSMENT CENTER ma pulę 50 CV/],
  ];
  for (const [code, cv, message] of refused) {
    const r = ok(code, cv);
    assert.equal(r.ok, false, `${code} ${cv}`);
    assert.match(r.message, message, `${code} ${cv}`);
  }
  assert.match(ok('PRESELEKCJA', 120, 3).message, /Liczba CV \(120\) nie zgadza się z liczbą pakietów \(3\)/);
  assert.equal(ok('WERYFIKACJA', 60, 2).ok, false);
});

test('R5 W2b: checkout with cvCount — server derives packages, refuses non-slider values with a Polish message, flag off keeps the old shape', async () => {
  // Flag off (default): the field does not exist, exactly as before W2b.
  {
    const { service, stripe } = harness();
    await assert.rejects(service.checkout(buy({ cvCount: 120 })), e => e.code === 'SC19_PAYMENT_INVALID');
    assert.equal(stripe.calls.length, 0);
  }
  const { service, stripe, st } = harness({ cvPoolEnabled: true });
  for (const [extra, message] of [
    [{ cvCount: 62 }, /co 5/], [{ cvCount: 1205 }, /1200/], [{ cvCount: '120' }, /całkowitą/],
    [{ cvCount: 120, packages: 3 }, /nie zgadza się/],
  ]) await assert.rejects(service.checkout(buy(extra)), e => e.code === 'SC19_PAYMENT_CV_COUNT_INVALID' && message.test(e.userMessage),
    JSON.stringify(extra));
  for (const [code, cvCount] of [['WERYFIKACJA', 65], ['ASSESSMENT_CENTER', 60]])
    await assert.rejects(service.checkout(packageBuy(code, { cvCount })), e => e.code === 'SC19_PAYMENT_CV_COUNT_INVALID', code);
  // A client price is never a field; adding one is still invalid.
  await assert.rejects(service.checkout(buy({ cvCount: 120, amountMinor: 1 })), e => e.code === 'SC19_PAYMENT_INVALID');
  assert.equal(stripe.calls.length, 0);
  assert.equal(st.orders.size, 0);
  // Over HTTP: 400 with the code and the Polish message, nothing else.
  const runtime = { service, authenticate: async () => ({ userId: id(2) }), readOrder: async () => null, listOffers: async () => [],
    appOrigin: ORIGIN, signatureHeader: 'stripe-signature' };
  const response = await createSc19PaymentHttp(runtime).checkout(new Request(`${ORIGIN}/api/billing/checkout`, { method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify(buy({ cvCount: 62 })) }));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['error', 'message']);
  assert.equal(body.error, 'SC19_PAYMENT_CV_COUNT_INVALID');
  assert.match(body.message, /^Liczbę CV wybiera się co 5\./);
  // A valid pool: 65 CV = 2 whole packages at the server price, never more.
  const r = await service.checkout(buy({ cvCount: 65 }));
  const order = st.orders.get(r.orderId);
  assert.equal(order.credits, 120);
  assert.equal(order.amountMinor, 60000);
  // The same request with the same pool, or with the equal package count, is the same purchase.
  const again = await service.checkout(buy({ cvCount: 120 }));
  assert.equal(again.orderId, r.orderId);
  const same = await service.checkout(buy({ packages: 2 }));
  assert.equal(same.orderId, r.orderId);
  await assert.rejects(service.checkout(buy({ cvCount: 180 })), e => e.code === 'SC19_PAYMENT_REQUEST_CONFLICT');
});

test('R5 W2b: the Stripe runtime reads the slider flag from env only, default off', () => {
  const runtime = readFileSync(new URL('../lib/sc19-stripe-runtime.ts', import.meta.url), 'utf8');
  assert.match(runtime, /cvPoolEnabled: process\.env\.PRICING_CV_SLIDER_ENABLED === 'true'/);
});

test('WERYFIKACJA: one package at the catalog price, its own metadata and line item', async () => {
  const { st, stripe, service } = harness();
  const result = await service.checkout(packageBuy('WERYFIKACJA'));
  assert.equal(result.amountMinor, 61500);
  const order = st.orders.get(result.orderId);
  assert.equal(order.packageCode, 'WERYFIKACJA'); assert.equal(order.credits, 60); assert.equal(order.amountMinor, 61500);
  const p = stripe.calls.find(c => c.method === 'POST' && c.path === '/v1/checkout/sessions').body;
  for (const prefix of ['metadata', 'payment_intent_data[metadata]']) {
    assert.equal(p[`${prefix}[package_code]`], 'WERYFIKACJA');
    assert.equal(p[`${prefix}[packages]`], '1');
    assert.equal(p[`${prefix}[pool_cv]`], '60');
  }
  assert.equal(p['line_items[0][quantity]'], '1');
  assert.equal(p['line_items[0][price_data][unit_amount]'], '61500');
  assert.equal(p['line_items[0][price_data][product_data][metadata][package_code]'], 'WERYFIKACJA');
  assert.equal(p['payment_intent_data[description]'], 'SkillCheck WERYFIKACJA — 1 × 60 analiz CV');
  assert.equal(stripe.calls.find(c => c.path === '/v1/prices').query['lookup_keys[0]'], 'skillcheck-core:WERYFIKACJA');
  // The same request again returns the same order; a WERYFIKACJA request id reused for AC is a conflict.
  assert.equal((await service.checkout(packageBuy('WERYFIKACJA'))).orderId, result.orderId);
  await assert.rejects(service.checkout(packageBuy('ASSESSMENT_CENTER')), e => e.code === 'SC19_PAYMENT_REQUEST_CONFLICT');
  // A Stripe price under the lookup key must match the catalog for THIS package.
  const other = harness();
  other.stripe.prices.push({ id: 'price_fakew', unit_amount: 30000, currency: 'pln', type: 'one_time', livemode: false,
    metadata: { app: STRIPE_APP, package_code: 'WERYFIKACJA' } });
  await assert.rejects(other.service.checkout(packageBuy('WERYFIKACJA')), e => e.code === 'SC19_PAYMENT_CHECKOUT_INVALID');
});

test('ASSESSMENT CENTER: granted only after checkout.session.completed — 50 CV and the package entitlement the R3 gate reads, once', async () => {
  const { st, stripe, service } = harness();
  const r = await service.checkout(packageBuy('ASSESSMENT_CENTER'));
  assert.equal(r.amountMinor, 149900);
  const sid = st.orders.get(r.orderId).sessionId;
  assert.equal(st.entitlements.get(`${id(1)}:package:ASSESSMENT_CENTER`), undefined);
  // An unpaid package blocks any other purchase until it is settled.
  await assert.rejects(service.checkout(buy({ requestId: id(30) })), e => e.code === 'SC19_PAYMENT_PURCHASE_PENDING');
  stripe.pay(sid);
  const ev = signed(completed(stripe.sessions.get(sid)));
  assert.equal((await service.notification(ev.raw, ev.header)).state, 'applied');
  assert.equal(st.entitlements.get(`${id(1)}:package:ASSESSMENT_CENTER`), 1);
  assert.equal(st.credits.get(id(1)), 50);
  assert.equal((await service.notification(ev.raw, ev.header)).state, 'already_applied');
  assert.equal(st.entitlements.get(`${id(1)}:package:ASSESSMENT_CENTER`), 1);
  assert.deepEqual(st.paidHook, [r.orderId]);
  // Status and offer reads name the package.
  const order = st.orders.get(r.orderId);
  const runtime = { service, authenticate: async () => ({ userId: id(2) }), readOrder: async () => order,
    listOffers: async () => [...STRIPE_PACKAGE_OFFERS], appOrigin: ORIGIN, signatureHeader: 'stripe-signature' };
  const http = createSc19PaymentHttp(runtime);
  const status = await (await http.order(new Request(`${ORIGIN}/api/billing/orders/${r.orderId}?companyId=${id(1)}`), r.orderId)).json();
  assert.equal(status.packageCode, 'ASSESSMENT_CENTER'); assert.equal(status.status, 'paid'); assert.equal(status.credits, 50);
  const offers = await (await http.offers(new Request(`${ORIGIN}/api/billing/offers?companyId=${id(1)}`))).json();
  assert.deepEqual(offers.offers.map(o => [o.packageCode, o.amountMinor]), [['WERYFIKACJA', 61500], ['ASSESSMENT_CENTER', 149900]]);
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
  for (const type of ['checkout.session.async_payment_succeeded', 'payment_intent.succeeded', 'charge.refunded']) {
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

test('pre-migration database: an expired Stripe session is never re-bound: fail closed, no new session; a live one is reused', async () => {
  const { st, stripe, service } = harness({ noClose: true });
  const first = await service.checkout(buy());
  const again = await service.checkout(buy());
  assert.equal(again.sessionId, first.sessionId);
  stripe.sessions.get(first.sessionId).status = 'expired';
  stripe.sessions.get(first.sessionId).url = null;
  await assert.rejects(service.checkout(buy()), e => e.code === 'SC19_PAYMENT_RECONCILIATION_REQUIRED');
  assert.equal(st.orders.get(first.orderId).sessionId, first.sessionId, 'session_id unchanged (trigger sc19_order_immutable)');
  assert.equal(stripe.calls.filter(c => c.method === 'POST' && c.path === '/v1/checkout/sessions').length, 1);
});

test('the Przelewy24 notification route is gone; a status read of a historical P24 order does not fail', async () => {
  assert.equal(existsSync(new URL('../app/api/billing/webhook/route.ts', import.meta.url)), false);
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
    'lib/sc19-stripe-packages.ts',
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
  const packages = readFileSync(new URL('../supabase/migrations/20261121150000_r7_stripe_packages.sql', import.meta.url), 'utf8')
    .replace(/--[^\n]*/g, '').replace(/\$\$[\s\S]*?\$\$/g, '');
  // The ONE drop allowed: the one-unresolved-order index, rebuilt at once under the
  // same name without the retired Przelewy24 provider (Codex P2, PR #566). No data changes.
  const rebuild = /drop index if exists private\.sc19_payment_one_unresolved;\s*create unique index sc19_payment_one_unresolved on private\.sc19_payment_orders\(company_id\)\s*where status='awaiting_payment' and provider<>'przelewy24';/;
  assert.match(packages, rebuild);
  assert.doesNotMatch(packages.replace(rebuild, ''), /\b(drop|truncate|delete\s+from|update\s+\w|rename|alter\s+column)\b/i);
  assert.match(packages, /mode = 'test' and provider = 'stripe'/);
  assert.doesNotMatch(packages, /\bto\s+(anon|authenticated)\b/i);
});

// R7 (issue #367, R7-STRIPE-EXPIRED-SESSION): an expired, unpaid session closes the
// order without any grant, so the company can buy again.
const expire = (stripe, sid) => Object.assign(stripe.sessions.get(sid), { status: 'expired', url: null });
const expiredEvent = (session, extra = {}) => ({ id: 'evt_fakeexp' + Math.random().toString(36).slice(2, 10), type: 'checkout.session.expired',
  livemode: false, data: { object: { id: session.id, metadata: { ...session.metadata } } }, ...extra });
const sessionPosts = stripe => stripe.calls.filter(c => c.method === 'POST' && c.path === '/v1/checkout/sessions').length;

test('PRESELEKCJA: an expired unpaid session closes the order without credits; a new purchase works and grants once', async () => {
  const { st, stripe, service } = harness();
  const first = await service.checkout(buy());
  expire(stripe, first.sessionId);
  await assert.rejects(service.checkout(buy()), e => e.code === 'SC19_PAYMENT_SESSION_EXPIRED' && /wygasła/.test(e.userMessage));
  assert.equal(st.orders.get(first.orderId).status, 'expired');
  assert.equal(st.orders.get(first.orderId).sessionId, first.sessionId, 'the expired session stays recorded');
  assert.deepEqual(st.closures, [first.orderId]);
  assert.equal(st.credits.get(id(1)) ?? 0, 0); assert.equal(st.grants.size, 0);
  // The old request id never reopens the closed order.
  await assert.rejects(service.checkout(buy()), e => e.code === 'SC19_PAYMENT_SESSION_EXPIRED');
  assert.equal(sessionPosts(stripe), 1);
  // A new request id is a new purchase with its own session.
  const second = await service.checkout(buy({ requestId: id(11) }));
  assert.notEqual(second.orderId, first.orderId); assert.notEqual(second.sessionId, first.sessionId);
  stripe.pay(second.sessionId);
  const ev = signed(completed(stripe.sessions.get(second.sessionId)));
  assert.equal((await service.notification(ev.raw, ev.header)).state, 'applied');
  assert.equal((await service.notification(ev.raw, ev.header)).state, 'already_applied');
  assert.equal(st.credits.get(id(1)), 60);
  assert.equal(st.orders.get(first.orderId).status, 'expired');
});

test('WERYFIKACJA and ASSESSMENT CENTER: an expired session closes the package order; nothing granted; buying again works', async () => {
  for (const code of ['WERYFIKACJA', 'ASSESSMENT_CENTER']) {
    const { st, stripe, service } = harness();
    const o = STRIPE_PACKAGE_OFFERS.find(x => x.plan === code);
    const req = n => ({ companyId: id(1), offerId: o.id, termsRevision: o.termsRevision, requestId: id(n), packageCode: code });
    const first = await service.checkout(req(20));
    expire(stripe, first.sessionId);
    await assert.rejects(service.checkout(req(20)), e => e.code === 'SC19_PAYMENT_SESSION_EXPIRED', code);
    assert.equal(st.orders.get(first.orderId).status, 'expired', code);
    assert.equal(st.entitlements.size, 0, code); assert.equal(st.credits.get(id(1)) ?? 0, 0, code);
    const second = await service.checkout(req(21));
    stripe.pay(second.sessionId);
    const ev = signed(completed(stripe.sessions.get(second.sessionId)));
    assert.equal((await service.notification(ev.raw, ev.header)).state, 'applied', code);
    assert.equal(st.entitlements.get(`${id(1)}:package:${code}`), 1, code);
    assert.equal(st.credits.get(id(1)), STRIPE_CATALOG[code].cvCredits, code);
  }
});

test('a live (open) or paid session is never closed', async () => {
  const { st, stripe, service } = harness();
  const first = await service.checkout(buy());
  // Open: the same link comes back, nothing closed.
  assert.equal((await service.checkout(buy())).url, first.url);
  assert.equal(st.orders.get(first.orderId).status, 'awaiting_payment');
  // Stripe says "expired" for a session that is in fact paid: never closed.
  Object.assign(stripe.sessions.get(first.sessionId), { status: 'expired', payment_status: 'paid' });
  assert.equal((await service.checkout(buy())).sessionId, first.sessionId);
  // An expired event for an open session (API re-read says open): no action.
  Object.assign(stripe.sessions.get(first.sessionId), { status: 'open', payment_status: 'unpaid' });
  const ev = signed(expiredEvent(stripe.sessions.get(first.sessionId)));
  assert.equal((await service.notification(ev.raw, ev.header)).state, 'ignored');
  assert.equal(st.orders.get(first.orderId).status, 'awaiting_payment');
  // Paid order: an expired event (even if the API said so) does not touch it.
  stripe.pay(first.sessionId);
  const paid = signed(completed(stripe.sessions.get(first.sessionId)));
  assert.equal((await service.notification(paid.raw, paid.header)).state, 'applied');
  Object.assign(stripe.sessions.get(first.sessionId), { status: 'expired', payment_status: 'unpaid' });
  const late = signed(expiredEvent(stripe.sessions.get(first.sessionId)));
  assert.equal((await service.notification(late.raw, late.header)).state, 'ignored');
  assert.equal(st.orders.get(first.orderId).status, 'paid'); assert.equal(st.credits.get(id(1)), 60);
  assert.deepEqual(st.closures, []);
});

test('webhook checkout.session.expired closes the order once; a late completed event for it grants nothing', async () => {
  const { st, stripe, service } = harness();
  const runtime = { service, authenticate: async () => null, readOrder: async () => null, listOffers: async () => [],
    appOrigin: ORIGIN, signatureHeader: 'stripe-signature' };
  const http = createSc19PaymentHttp(runtime);
  const send = async event => { const ev = signed(event); return http.webhook(new Request(`${ORIGIN}/api/billing/stripe/webhook`,
    { method: 'POST', headers: { 'stripe-signature': ev.header }, body: ev.raw })); };
  const first = await service.checkout(buy());
  expire(stripe, first.sessionId);
  const res = await send(expiredEvent(stripe.sessions.get(first.sessionId)));
  assert.equal(res.status, 200); assert.deepEqual(await res.json(), { state: 'closed' });
  assert.deepEqual(await (await send(expiredEvent(stripe.sessions.get(first.sessionId)))).json(), { state: 'already_closed' });
  assert.equal(st.orders.get(first.orderId).status, 'expired');
  // Forged/late "completed" for the closed order: the API read is what counts; even
  // if Stripe claimed it paid, the closed order never grants (refund / review).
  Object.assign(stripe.sessions.get(first.sessionId), { status: 'complete', payment_status: 'paid', payment_intent: 'pi_fakelate1' });
  const late = await send(completed(stripe.sessions.get(first.sessionId)));
  assert.notEqual(late.status, 200);
  assert.equal((await late.json()).error, 'SC19_PAYMENT_ORDER_CLOSED_REVIEW');
  assert.equal(st.credits.get(id(1)) ?? 0, 0); assert.equal(st.grants.size, 0); assert.deepEqual(st.paidHook, []);
  // The buyer's next click with the old request id: told to start again; a new one buys.
  await assert.rejects(service.checkout(buy()), e => e.code === 'SC19_PAYMENT_SESSION_EXPIRED');
  assert.notEqual((await service.checkout(buy({ requestId: id(12) }))).orderId, first.orderId);
});

test('an expired event for an unknown order or another bound session is acknowledged with no action', async () => {
  const { st, stripe, service } = harness();
  const first = await service.checkout(buy());
  const other = { ...stripe.sessions.get(first.sessionId), id: 'cs_test_fakeothersession', status: 'expired', url: null };
  stripe.sessions.set(other.id, other);
  const ev = signed(expiredEvent(other));
  assert.equal((await service.notification(ev.raw, ev.header)).state, 'ignored');
  assert.equal(st.orders.get(first.orderId).status, 'awaiting_payment');
  const unknown = { ...other, id: 'cs_test_fakeunknownorder', metadata: { ...other.metadata, order_id: id(77) }, client_reference_id: id(77) };
  stripe.sessions.set(unknown.id, unknown);
  const ev2 = signed(expiredEvent(unknown));
  assert.equal((await service.notification(ev2.raw, ev2.header)).state, 'ignored');
  assert.deepEqual(st.closures, []);
});
