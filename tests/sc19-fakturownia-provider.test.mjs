import test from 'node:test';
import assert from 'node:assert/strict';
import { createSc19Payments } from '../lib/sc19-payments.ts';
import { createFakturowniaClient, formatMinor, parseMinor } from '../lib/fakturownia-client.ts';
import { createFakturowniaPaymentProvider, signPaymentTrigger } from '../lib/sc19-fakturownia-provider.ts';

// Real SC-019 orchestration + real Fakturownia adapter/client against a
// deterministic in-memory Fakturownia API. No network, no real documents.
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SECRET = 'synthetic-trigger-secret-0123456789abcdef';
const ACCOUNT = 'krzysztof-syskaa';
const ORIGIN = `https://${ACCOUNT}.fakturownia.pl`;
const scope = { provider: 'fakturownia', account: ACCOUNT, mode: 'test' };
const buyer = { name: 'FIRMA TESTOWA SP. Z O.O.', nip: '5260250274', street: 'UL. TESTOWA 1', postCode: '00-001', city: 'WARSZAWA', email: 'owner@fixture.invalid' };
const offer = () => ({ id: 'preselection-v1', revision: 'rev-1', plan: 'PRESELEKCJA', active: true, approved: true,
  amountMinor: 36900, currency: 'PLN', credits: 60, termsRevision: 'terms-v1', validUntilMs: Date.now() + 3_600_000 });
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => structuredClone(body) });

function fakeFakturownia() {
  const s = { invoices: [], posts: [], nextId: 1000, failNextCreateAfterStore: false, overrideGross: null, fullPages: false };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    assert.equal(u.origin, ORIGIN);
    if (init.method === 'POST' && u.pathname === '/invoices.json') {
      const body = JSON.parse(init.body);
      assert.equal(body.api_token, 'SyntheticTok3n_value/abc');
      s.posts.push(body.invoice);
      if (body.invoice.oid_unique === 'yes' && s.invoices.some(i => i.oid === body.invoice.oid)) return reply(422, { code: 'error', message: { oid: ['taken'] } });
      const gross = s.overrideGross ?? body.invoice.positions[0].total_price_gross;
      const inv = { id: s.nextId++, kind: body.invoice.kind, status: 'issued', number: `PRO ${s.nextId}`, oid: body.invoice.oid,
        price_gross: gross, paid: '0.00', currency: body.invoice.currency, token: `Tok${s.nextId}abcdefgh`, issue_date: body.invoice.issue_date };
      s.invoices.push(inv);
      if (s.failNextCreateAfterStore) { s.failNextCreateAfterStore = false; return reply(504, {}); }
      return reply(201, inv);
    }
    if (init.method === 'GET' && u.pathname === '/invoices.json') {
      assert.equal(u.searchParams.get('kind'), 'proforma');
      if (s.fullPages) return reply(200, Array.from({ length: 100 }, (_, k) => ({ id: 5000 + k, kind: 'proforma', status: 'issued', oid: `other-${k}` })));
      const page = Number(u.searchParams.get('page'));
      return reply(200, page === 1 ? s.invoices.filter(i => i.kind === 'proforma') : []);
    }
    const m = /^\/invoices\/(\d+)\.json$/.exec(u.pathname);
    if (init.method === 'GET' && m) {
      const inv = s.invoices.find(i => i.id === Number(m[1]));
      return inv ? reply(200, inv) : reply(404, {});
    }
    return reply(404, {});
  };
  return { s, fetchImpl };
}

function memoryStore() {
  const st = { orders: new Map(), requests: new Map(), grants: new Map(), credits: new Map() };
  let tail = Promise.resolve();
  return { st, store: { async transaction(fn) {
    let release; const wait = tail; tail = new Promise(r => { release = r; }); await wait;
    const before = structuredClone(st);
    const tx = {
      async companyAccess(c, u) { return c === id(1) && u === id(2) ? { owner: true, verified: true } : { owner: false, verified: false }; },
      async offer(k) { return k === 'preselection-v1' ? offer() : null; },
      async orderByRequest(c, r) { return structuredClone(st.orders.get(st.requests.get(`${c}:${r}`)) ?? null); },
      async unresolvedOrder(c) { return structuredClone([...st.orders.values()].find(o => o.companyId === c && o.status === 'awaiting_payment') ?? null); },
      async bindRequest(c, r, o) { st.requests.set(`${c}:${r}`, o); },
      async order(k) { return structuredClone(st.orders.get(k) ?? null); },
      async insertOrder(o) { st.orders.set(o.id, structuredClone(o)); },
      async saveOrder(o) { st.orders.set(o.id, structuredClone(o)); },
      async grantOnce(key, o) { if (st.grants.has(key)) return st.grants.get(key); st.grants.set(key, o.id);
        st.credits.set(o.companyId, (st.credits.get(o.companyId) ?? 0) + o.credits); return null; },
    };
    try { return await fn(tx); } catch (e) { Object.assign(st, before); throw e; } finally { release(); }
  } } };
}

function harness({ now } = {}) {
  const api = fakeFakturownia();
  const client = createFakturowniaClient({ account: ACCOUNT, token: 'SyntheticTok3n_value/abc' }, api.fetchImpl);
  const clock = { t: Date.now() };
  const provider = createFakturowniaPaymentProvider({ client, scope, triggerSecret: SECRET,
    buyer: async () => buyer, itemName: o => `SkillCheck PRESELEKCJA — ${o.credits} analiz CV`, now: now ?? (() => clock.t) });
  const { st, store } = memoryStore();
  const service = createSc19Payments({ store, provider, authenticate: async () => ({ userId: id(2) }), scope,
    checkoutOrigins: [ORIGIN], enabled: true, liveApproved: false });
  const checkout = (rid = id(10)) => service.checkout({ companyId: id(1), offerId: 'preselection-v1', requestId: rid, termsRevision: 'terms-v1' });
  const trigger = (invoiceId, orderId, at = clock.t) => { const t = signPaymentTrigger(SECRET, invoiceId, orderId, at); return service.notification(t.body, t.signature); };
  return { api, st, service, checkout, trigger, clock, provider };
}

test('money helpers are exact', () => {
  assert.equal(formatMinor(36900), '369.00'); assert.equal(formatMinor(5), '0.05'); assert.equal(formatMinor(123456), '1234.56');
  assert.equal(parseMinor('369.00'), 36900); assert.equal(parseMinor('369,5'), 36950); assert.equal(parseMinor('369'), 36900);
  for (const bad of ['', '3 69', '-1.00', '1.234', '1e3', 'abc']) assert.equal(parseMinor(bad), null, bad);
});

test('checkout issues exactly one gross-exact proforma and returns its public page', async () => {
  const h = harness();
  const out = await h.checkout();
  assert.equal(h.api.s.posts.length, 1);
  const sent = h.api.s.posts[0];
  assert.equal(sent.kind, 'proforma');
  assert.equal(sent.oid, `sc19:${out.orderId}`);
  assert.equal(sent.oid_unique, 'yes');
  assert.deepEqual(sent.calculating_strategy, { position: 'keep_gross', sum: 'keep_gross', invoice_form_price_kind: 'gross' });
  assert.deepEqual(sent.positions, [{ name: 'SkillCheck PRESELEKCJA — 60 analiz CV', quantity: 1, quantity_unit: 'usł.', tax: 23, total_price_gross: '369.00' }]);
  assert.equal(sent.buyer_tax_no, buyer.nip); assert.equal(sent.buyer_email, buyer.email); assert.equal(sent.currency, 'PLN');
  assert.ok(out.url.startsWith(`${ORIGIN}/invoice/`));
  assert.equal(out.amountMinor, 36900);
  assert.equal(out.sessionId, `fv-${h.api.s.invoices[0].id}`);
  // Same request again: SC-019 returns the stored session; no second document.
  const again = await h.checkout();
  assert.equal(again.url, out.url);
  assert.equal(h.api.s.invoices.length, 1);
});

test('lost create response is recovered by oid, never by issuing a second proforma', async () => {
  const h = harness();
  h.api.s.failNextCreateAfterStore = true;
  await assert.rejects(h.checkout());
  assert.equal(h.api.s.invoices.length, 1);
  const out = await h.checkout();
  assert.equal(h.api.s.invoices.length, 1, 'duplicate oid refused by Fakturownia');
  assert.equal(h.api.s.posts.length, 2);
  assert.equal(out.sessionId, `fv-${h.api.s.invoices[0].id}`);
});

test('a proforma whose gross differs from the order is never exposed', async () => {
  const h = harness();
  h.api.s.overrideGross = '1.00';
  await assert.rejects(h.checkout(), e => /MISMATCH|CHECKOUT_INVALID/.test(e.code));
});

test('payment is granted once, only after a fresh API read shows the proforma fully paid', async () => {
  const h = harness();
  const out = await h.checkout();
  const inv = h.api.s.invoices[0];
  assert.deepEqual(await h.trigger(inv.id, out.orderId), { state: 'not_paid' });
  inv.status = 'partial'; inv.paid = '100.00';
  assert.deepEqual(await h.trigger(inv.id, out.orderId), { state: 'not_paid' });
  inv.status = 'paid'; inv.paid = '369.00';
  assert.deepEqual(await h.trigger(inv.id, out.orderId), { state: 'applied', orderId: out.orderId });
  assert.equal(h.st.credits.get(id(1)), 60);
  assert.deepEqual(await h.trigger(inv.id, out.orderId), { state: 'already_applied', orderId: out.orderId });
  assert.equal(h.st.credits.get(id(1)), 60, 'replayed trigger grants nothing');
  assert.equal(h.st.orders.get(out.orderId).status, 'paid');
});

test('"paid" status with a short payment amount is not treated as paid', async () => {
  const h = harness();
  const out = await h.checkout();
  const inv = h.api.s.invoices[0];
  inv.status = 'paid'; inv.paid = '368.99';
  assert.deepEqual(await h.trigger(inv.id, out.orderId), { state: 'not_paid' });
  assert.equal(h.st.credits.get(id(1)), undefined);
});

test('forged, tampered, expired or cross-order triggers grant nothing', async () => {
  const h = harness();
  const out = await h.checkout();
  const inv = h.api.s.invoices[0];
  inv.status = 'paid'; inv.paid = '369.00';
  const good = signPaymentTrigger(SECRET, inv.id, out.orderId, h.clock.t);
  await assert.rejects(h.service.notification(good.body, '0'.repeat(64)), e => e.code === 'FAKTUROWNIA_TRIGGER_UNAUTHENTICATED');
  const forged = signPaymentTrigger('another-secret-of-sufficient-length-000', inv.id, out.orderId, h.clock.t);
  await assert.rejects(h.service.notification(forged.body, forged.signature), e => e.code === 'FAKTUROWNIA_TRIGGER_UNAUTHENTICATED');
  const tampered = new Uint8Array(good.body); tampered[tampered.length - 2] ^= 1;
  await assert.rejects(h.service.notification(tampered, good.signature), e => e.code === 'FAKTUROWNIA_TRIGGER_UNAUTHENTICATED');
  await assert.rejects(h.trigger(inv.id, out.orderId, h.clock.t - 11 * 60_000), e => e.code === 'FAKTUROWNIA_TRIGGER_EXPIRED');
  // A real, paid proforma of a DIFFERENT order cannot pay this one.
  h.api.s.invoices.push({ ...inv, id: 9999, oid: `sc19:${id(77)}` });
  await assert.rejects(h.trigger(9999, out.orderId), e => e.code === 'FAKTUROWNIA_PROFORMA_MISMATCH');
  assert.equal(h.st.credits.get(id(1)), undefined);
});

test('lookup refuses to confirm absence when the listing is not exhausted', async () => {
  const h = harness();
  h.api.s.fullPages = true;
  const order = { id: id(55), checkoutDeadlineMs: Date.now() };
  await assert.rejects(h.provider.lookupCheckout(order, `sc19:${id(55)}`), e => e.code === 'FAKTUROWNIA_LOOKUP_INCOMPLETE');
});

test('provider refuses weak configuration and foreign scope', () => {
  const api = fakeFakturownia();
  const client = createFakturowniaClient({ account: ACCOUNT, token: 'SyntheticTok3n_value/abc' }, api.fetchImpl);
  const base = { client, scope, triggerSecret: SECRET, buyer: async () => buyer, itemName: () => 'x' };
  assert.throws(() => createFakturowniaPaymentProvider({ ...base, triggerSecret: 'short' }), e => e.code === 'FAKTUROWNIA_PROVIDER_CONFIG_INVALID');
  assert.throws(() => createFakturowniaPaymentProvider({ ...base, scope: { ...scope, provider: 'stripe' } }), e => e.code === 'FAKTUROWNIA_PROVIDER_CONFIG_INVALID');
  // Declared merchant must be the account the client actually queries.
  for (const account of ['different-merchant', 'KRZYSZTOF-SYSKAA', 'evil.com/x', ''])
    assert.throws(() => createFakturowniaPaymentProvider({ ...base, scope: { ...scope, account } }), e => e.code === 'FAKTUROWNIA_PROVIDER_CONFIG_INVALID', account);
  assert.doesNotThrow(() => createFakturowniaPaymentProvider(base));
  assert.throws(() => signPaymentTrigger(SECRET, 1, 'not-a-uuid'), e => e.code === 'FAKTUROWNIA_TRIGGER_INVALID');
});
