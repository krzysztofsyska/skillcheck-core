import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSc19Payments } from '../lib/sc19-payments.ts';
import { createPrzelewy24Provider, przelewy24NotificationSignature, przelewy24Sign, sessionIdFor } from '../lib/sc19-przelewy24-provider.ts';
import { createFakturowniaClient } from '../lib/fakturownia-client.ts';

// Real SC-019 orchestration + real Przelewy24 adapter against a deterministic
// in-memory Przelewy24 sandbox. No network, no real money, synthetic keys only.
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MERCHANT = 123456;
const CRC = 'synthetic-crc-key-0123';
const API_KEY = 'synthetic-api-key-0123456789';
const ORIGIN = 'https://sandbox.przelewy24.pl';
const scope = { provider: 'przelewy24', account: String(MERCHANT), mode: 'test' };
const offer = () => ({ id: 'preselection-v1', revision: 'rev-1', plan: 'PRESELEKCJA', active: true, approved: true,
  amountMinor: 36900, currency: 'PLN', credits: 60, termsRevision: 'terms-v1', validUntilMs: Date.now() + 3_600_000 });
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => structuredClone(body) });

function fakeP24() {
  const s = { tx: new Map(), registers: [], verifies: [], nextOrder: 900001, dropRegisterResponse: false };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    assert.equal(u.origin, ORIGIN);
    assert.equal(init.headers.authorization, 'Basic ' + Buffer.from(`${MERCHANT}:${API_KEY}`).toString('base64'));
    if (init.method === 'POST' && u.pathname === '/api/v1/transaction/register') {
      const b = JSON.parse(init.body);
      s.registers.push(b);
      const sign = createHash('sha384').update(JSON.stringify({ sessionId: b.sessionId, merchantId: MERCHANT, amount: b.amount, currency: b.currency, crc: CRC })).digest('hex');
      if (b.sign !== sign) return reply(400, { error: 'Incorrect sign', code: 400 });
      if (s.tx.has(b.sessionId)) return reply(400, { error: 'sessionId already used', code: 400 });
      s.tx.set(b.sessionId, { sessionId: b.sessionId, orderId: s.nextOrder++, amount: b.amount, currency: 'PLN', status: 0 });
      if (s.dropRegisterResponse) { s.dropRegisterResponse = false; return reply(504, null); }
      return reply(200, { data: { token: `TOKEN-${b.sessionId.slice(5, 13)}` }, responseCode: 0 });
    }
    if (init.method === 'PUT' && u.pathname === '/api/v1/transaction/verify') {
      const b = JSON.parse(init.body);
      s.verifies.push(b);
      const t = s.tx.get(b.sessionId);
      const sign = createHash('sha384').update(JSON.stringify({ sessionId: b.sessionId, orderId: b.orderId, amount: b.amount, currency: 'PLN', crc: CRC })).digest('hex');
      if (!t || b.sign !== sign || t.orderId !== b.orderId || t.amount !== b.amount || t.status === 0) return reply(400, { error: 'verify failed', code: 400 });
      if (t.status === 1) t.status = 2;
      return reply(200, { data: { status: 'success' }, responseCode: 0 });
    }
    const m = /^\/api\/v1\/transaction\/by\/sessionId\/(.+)$/.exec(u.pathname);
    if (init.method === 'GET' && m) {
      const t = s.tx.get(decodeURIComponent(m[1]));
      return t ? reply(200, { data: { ...t } }) : reply(404, { error: 'not found', code: 404 });
    }
    return reply(404, {});
  };
  /** Customer paid on the hosted page: Przelewy24 marks it paid-awaiting-verify and notifies. */
  const pay = (sessionId, { amount, crc = CRC, extra = {} } = {}) => {
    const t = s.tx.get(sessionId);
    t.status = 1;
    const n = { merchantId: MERCHANT, posId: MERCHANT, sessionId, amount: amount ?? t.amount, originAmount: amount ?? t.amount,
      currency: 'PLN', orderId: t.orderId, methodId: 154, statement: 'p24-A1-B2-C3' };
    n.sign = createHash('sha384').update(JSON.stringify({ ...n, crc })).digest('hex');
    return new TextEncoder().encode(JSON.stringify({ ...n, ...extra }));
  };
  return { s, fetchImpl, pay };
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

const config = { merchantId: MERCHANT, apiKey: API_KEY, crc: CRC, mode: 'test' };
function harness() {
  const api = fakeP24();
  const provider = createPrzelewy24Provider({ config, scope, urlStatus: 'https://skillcheck.pl/api/billing/przelewy24/notify',
    urlReturn: o => `https://skillcheck.pl/dashboard/${o.companyId}/billing?order=${o.id}`,
    email: async () => 'owner@fixture.invalid', description: o => `SkillCheck PRESELEKCJA — ${o.credits} analiz CV` }, api.fetchImpl);
  const { st, store } = memoryStore();
  const service = createSc19Payments({ store, provider, authenticate: async () => ({ userId: id(2) }), scope,
    checkoutOrigins: [ORIGIN], enabled: true, liveApproved: false });
  const checkout = (rid = id(10)) => service.checkout({ companyId: id(1), offerId: 'preselection-v1', requestId: rid, termsRevision: 'terms-v1' });
  const notify = raw => service.notification(raw, przelewy24NotificationSignature(raw));
  return { api, st, service, checkout, notify, provider };
}

test('signature is sha384 of compact JSON in the documented field order', () => {
  const expected = createHash('sha384').update('{"sessionId":"s","merchantId":1,"amount":100,"currency":"PLN","crc":"k"}').digest('hex');
  assert.equal(przelewy24Sign({ sessionId: 's', merchantId: 1, amount: 100, currency: 'PLN', crc: 'k' }), expected);
});

test('checkout registers exactly one signed transaction and returns the sandbox payment page', async () => {
  const h = harness();
  const out = await h.checkout();
  assert.equal(h.api.s.registers.length, 1);
  const r = h.api.s.registers[0];
  assert.equal(r.sessionId, sessionIdFor(out.orderId));
  assert.equal(r.amount, 36900); assert.equal(r.currency, 'PLN'); assert.equal(r.merchantId, MERCHANT); assert.equal(r.posId, MERCHANT);
  assert.equal(r.urlStatus, 'https://skillcheck.pl/api/billing/przelewy24/notify');
  assert.ok(r.urlReturn.startsWith('https://skillcheck.pl/dashboard/'));
  assert.equal(r.email, 'owner@fixture.invalid');
  assert.ok(out.url.startsWith(`${ORIGIN}/trnRequest/`));
  assert.equal(out.amountMinor, 36900);
  const again = await h.checkout();
  assert.equal(again.url, out.url);
  assert.equal(h.api.s.registers.length, 1, 'retry reuses the stored session; no second charge');
});

test('a lost register response never leads to a second registration', async () => {
  const h = harness();
  h.api.s.dropRegisterResponse = true;
  await assert.rejects(h.checkout(), e => e.code === 'P24_SESSION_EXISTS');
  await assert.rejects(h.checkout(), e => e.code === 'P24_SESSION_EXISTS');
  assert.equal(h.api.s.tx.size, 1);
  assert.equal(h.api.s.registers.length, 2, 'second attempt was refused by Przelewy24 (duplicate sessionId)');
  assert.equal(h.st.credits.get(id(1)), undefined);
});

test('a verified, settled payment grants the order credits exactly once', async () => {
  const h = harness();
  const out = await h.checkout();
  const raw = h.api.pay(sessionIdFor(out.orderId));
  assert.deepEqual(await h.notify(raw), { state: 'applied', orderId: out.orderId });
  assert.equal(h.api.s.verifies.length, 1);
  assert.equal(h.st.credits.get(id(1)), 60);
  // Przelewy24 repeats notifications: still exactly one grant.
  const again = await h.notify(raw);
  assert.notEqual(again.state, 'applied_twice');
  assert.equal(h.st.credits.get(id(1)), 60);
});

test('notifications signed with a wrong CRC, for another merchant, or with extra fields are refused', async () => {
  const h = harness();
  const out = await h.checkout();
  const sid = sessionIdFor(out.orderId);
  await assert.rejects(h.notify(h.api.pay(sid, { crc: 'attacker-crc-0000' })), e => e.code === 'P24_NOTIFICATION_UNAUTHENTICATED');
  await assert.rejects(h.notify(h.api.pay(sid, { extra: { merchantId: 999 } })), e => e.code === 'P24_SCOPE_MISMATCH');
  await assert.rejects(h.notify(h.api.pay(sid, { extra: { bonus: 1 } })), e => e.code === 'P24_NOTIFICATION_INVALID');
  assert.equal(h.api.s.verifies.length, 0, 'nothing confirmed with Przelewy24 for forged input');
  assert.equal(h.st.credits.get(id(1)), undefined);
});

test('a forged notification body cannot claim payment the provider does not report', async () => {
  const h = harness();
  const out = await h.checkout();
  const sid = sessionIdFor(out.orderId);
  // Correctly signed but the transaction was never paid (status 0): verify fails, fresh read says unpaid.
  const t = h.api.s.tx.get(sid);
  const n = { merchantId: MERCHANT, posId: MERCHANT, sessionId: sid, amount: 36900, originAmount: 36900, currency: 'PLN', orderId: t.orderId, methodId: 154, statement: 'x' };
  n.sign = przelewy24Sign({ ...n, crc: CRC });
  assert.deepEqual(await h.notify(new TextEncoder().encode(JSON.stringify(n))), { state: 'not_paid' });
  assert.equal(h.st.credits.get(id(1)), undefined);
});

test('an underpaid amount never grants the order', async () => {
  const h = harness();
  const out = await h.checkout();
  const sid = sessionIdFor(out.orderId);
  h.api.s.tx.get(sid).amount = 100; // provider reports 1.00 PLN settled
  await assert.rejects(h.notify(h.api.pay(sid)));
  assert.equal(h.st.credits.get(id(1)), undefined);
});

test('configuration must name the exact merchant and environment', () => {
  const mk = (cfg, sc) => () => createPrzelewy24Provider({ config: cfg, scope: sc, urlStatus: 'https://x.invalid/n', urlReturn: () => 'https://x.invalid',
    email: async () => 'a@b.c', description: () => 'd' }, async () => { throw new Error('no network'); });
  assert.throws(mk(config, { ...scope, account: '1' }), e => e.code === 'P24_CONFIG_INVALID');
  assert.throws(mk(config, { ...scope, mode: 'live' }), e => e.code === 'P24_CONFIG_INVALID');
  assert.throws(mk({ ...config, crc: '' }, scope), e => e.code === 'P24_CONFIG_INVALID');
  assert.throws(() => createPrzelewy24Provider({ config, scope, urlStatus: 'http://insecure.invalid', urlReturn: () => '', email: async () => '', description: () => '' }),
    e => e.code === 'P24_CONFIG_INVALID');
});

test('paid VAT invoice is issued once, gross-exact and marked paid', async () => {
  const posts = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (posts.some(p => p.oid === body.invoice.oid)) return reply(422, { code: 'error' });
    posts.push(body.invoice);
    return reply(201, { id: 77, kind: 'vat', status: 'paid', oid: body.invoice.oid, price_gross: body.invoice.positions[0].total_price_gross,
      paid: body.invoice.paid, currency: 'PLN', number: 'FV 1/10/2026' });
  };
  const client = createFakturowniaClient({ account: 'krzysztof-syskaa', token: 'SyntheticTok3n_value/abc' }, fetchImpl);
  const input = { oid: `sc19-paid:${id(5)}`, grossMinor: 36900, itemName: 'SkillCheck PRESELEKCJA — 60 analiz CV', issueDate: '2026-10-26',
    paymentReference: 'przelewy24:900001',
    buyer: { name: 'FIRMA TESTOWA SP. Z O.O.', nip: '5260250274', street: 'UL. TESTOWA 1', postCode: '00-001', city: 'WARSZAWA', email: 'owner@fixture.invalid' } };
  const inv = await client.createPaidInvoice(input);
  assert.equal(inv.kind, 'vat'); assert.equal(inv.status, 'paid');
  assert.equal(posts[0].status, 'paid'); assert.equal(posts[0].paid, '369.00'); assert.equal(posts[0].oid_unique, 'yes');
  assert.equal(posts[0].positions[0].total_price_gross, '369.00'); assert.equal(posts[0].buyer_tax_no, '5260250274');
  await assert.rejects(client.createPaidInvoice(input), e => e.code === 'FAKTUROWNIA_REQUEST_REJECTED');
  assert.equal(posts.length, 1);
  await assert.rejects(client.createPaidInvoice({ ...input, oid: 'free-text' }), e => e.code === 'FAKTUROWNIA_REQUEST_REJECTED');
});
