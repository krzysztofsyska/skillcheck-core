import test from 'node:test';
import assert from 'node:assert/strict';
import { createSc19Payments, Sc19PaymentError } from '../lib/sc19-payments.ts';

// Transactional FAKE only. These tests do not assert PostgreSQL isolation or
// provider connectivity; those require the production adapters and separate CI.
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { provider: 'synthetic', account: 'merchant-fixture', mode: 'test' };
const request = (extra = {}) => ({ companyId: id(1), offerId: 'preselection-v1', requestId: id(10), termsRevision: 'terms-v1', ...extra });
const knownOffer = () => ({ id: 'preselection-v1', revision: 'revision-v1', plan: 'PRESELEKCJA', active: true,
  approved: true, amountMinor: 12345, currency: 'PLN', credits: 12, termsRevision: 'terms-v1', validUntilMs: Date.now() + 3_600_000 });
function harness(config = {}) {
  const state = { user: id(2), access: { owner: true, verified: true }, offer: knownOffer(),
    orders: new Map(), grants: new Map(), credits: new Map(), providerSessions: new Map(),
    createCalls: [], lookupCalls: [], payment: null, authenticated: true, failSave: false, failProvider: false,
    failLookup: false, reads: 0, verifications: 0, url: 'https://pay.fixture.invalid/session',
    sessionScope: scope, sessionAmountMinor: null, sessionCurrency: 'PLN', sessionPaymentKind: 'one_time' };
  let tail = Promise.resolve();
  const store = { async transaction(fn) {
    let release;
    const wait = tail;
    tail = new Promise(resolve => { release = resolve; });
    await wait;
    const before = structuredClone({ orders: state.orders, grants: state.grants, credits: state.credits });
    const tx = {
      async companyAccess(company, user) {
        state.reads++;
        return company === id(1) && user === id(2) ? { ...state.access } : { owner: false, verified: false };
      },
      async offer(key) { return key === state.offer?.id ? structuredClone(state.offer) : null; },
      async orderByRequest(company, rid) { return structuredClone([...state.orders.values()].find(o => o.companyId === company && o.requestId === rid) ?? null); },
      async order(key) { return structuredClone(state.orders.get(key) ?? null); },
      async insertOrder(order) {
        if ([...state.orders.values()].some(o => o.companyId === order.companyId && o.requestId === order.requestId)) throw Error('unique request');
        state.orders.set(order.id, structuredClone(order));
      },
      async saveOrder(order) {
        if (state.failSave) throw Error('simulated database write failure');
        state.orders.set(order.id, structuredClone(order));
      },
      async grantOnce(key, order) {
        const previous = state.grants.get(key);
        if (previous) return previous;
        state.grants.set(key, order.id);
        state.credits.set(order.companyId, (state.credits.get(order.companyId) ?? 0) + order.credits);
        return null;
      },
    };
    try { return await fn(tx); }
    catch (error) { Object.assign(state, before); throw error; }
    finally { release(); }
  } };
  const provider = {
    async createCheckout(order, key) {
      state.createCalls.push({ order: structuredClone(order), key });
      let session = state.providerSessions.get(key);
      if (!session) {
        session = { orderId: order.id, sessionId: `checkout-${order.id}`, url: state.url, scope: { ...state.sessionScope },
          amountMinor: state.sessionAmountMinor ?? order.amountMinor, currency: state.sessionCurrency,
          paymentKind: state.sessionPaymentKind };
        state.providerSessions.set(key, session);
      }
      if (state.failProvider) throw Error('timeout after provider accepted');
      return structuredClone(session);
    },
    async lookupCheckout(order, key) {
      state.lookupCalls.push({ orderId: order.id, key });
      if (state.failLookup) throw Error('provider lookup is uncertain');
      return structuredClone(state.providerSessions.get(key) ?? null);
    },
    async verifyAndRetrieve(bytes, signature) {
      state.verifications++;
      assert.ok(bytes instanceof Uint8Array);
      if (!state.authenticated || signature !== 'synthetic-verified-notification') throw Error('invalid provider signature');
      return structuredClone(state.payment);
    },
  };
  const serviceDeps = { store, provider, authenticate: async () => state.user ? { userId: state.user } : null,
    scope, checkoutOrigins: ['https://pay.fixture.invalid'], enabled: true, liveApproved: false, ...config };
  const service = createSc19Payments(serviceDeps);
  const notify = () => service.notification(new Uint8Array([123, 125]), 'synthetic-verified-notification');
  const paid = async (changes = {}) => {
    const hosted = await service.checkout(request());
    state.payment = { eventId: 'event-1', orderId: hosted.orderId, sessionId: hosted.sessionId, paymentId: 'payment-1',
      scope: { ...scope }, amountMinor: 12345, currency: 'PLN', status: 'paid', ...changes };
    return hosted;
  };
  return { state, service, notify, paid, recreate: overrides => createSc19Payments({ ...serviceDeps, ...overrides }) };
}
const rejects = (promise, code) => assert.rejects(promise, e => e instanceof Sc19PaymentError && e.code === code);

test('checkout persists server-priced order before calling provider and grants no credits', async () => {
  const h = harness();
  const hosted = await h.service.checkout(request());
  const order = h.state.orders.get(hosted.orderId);
  assert.equal(order.amountMinor, 12345); assert.equal(order.credits, 12);
  assert.equal(order.offerRevision, 'revision-v1'); assert.equal(order.status, 'awaiting_payment');
  assert.equal(order.sessionId, hosted.sessionId); assert.equal(h.state.grants.size, 0);
  assert.equal(h.state.createCalls[0].key, `sc19:${order.id}`);
});

test('client cannot supply amount, credits, buyer, provider, or payment status', async () => {
  for (const extra of [{ amountMinor: 1 }, { credits: 999 }, { buyerId: id(2) }, { scope }, { paid: true }, { currency: 'EUR' }]) {
    const h = harness();
    await rejects(h.service.checkout(request(extra)), 'SC19_PAYMENT_INVALID');
    assert.equal(h.state.orders.size, 0); assert.equal(h.state.createCalls.length, 0);
  }
});

test('unauthenticated, cross-tenant, non-owner and unverified company cannot pay', async () => {
  for (const setup of [s => { s.user = null; }, s => { s.user = id(5); }, s => { s.access.owner = false; }, s => { s.access.verified = false; }]) {
    const h = harness(); setup(h.state);
    await rejects(h.service.checkout(request()), 'SC19_PAYMENT_FORBIDDEN');
    assert.equal(h.state.orders.size, 0); assert.equal(h.state.createCalls.length, 0);
  }
  await rejects(harness().service.checkout(request({ companyId: id(9) })), 'SC19_PAYMENT_FORBIDDEN');
});

test('disabled and unapproved LIVE stop NEW checkout before auth, DB and provider', async () => {
  for (const config of [{ enabled: false }, { scope: { ...scope, mode: 'live' } }, { scope: { ...scope, account: '' } }]) {
    const h = harness(config);
    await rejects(h.service.checkout(request()), 'SC19_PAYMENTS_DISABLED');
    assert.equal(h.state.reads, 0); assert.equal(h.state.verifications, 0); assert.equal(h.state.createCalls.length, 0);
  }
  const invalid = harness({ scope: { ...scope, account: '' } });
  await rejects(invalid.notify(), 'SC19_PAYMENTS_DISABLED');
  assert.equal(invalid.state.verifications, 0);
});

test('FREE, unapproved, inactive, expired, fractional and mismatched terms offers are refused', async () => {
  for (const update of [{ plan: 'FREE' }, { approved: false }, { active: false }, { validUntilMs: 1 },
    { amountMinor: 0 }, { amountMinor: 2.5 }, { amountMinor: 100_000_001 }, { currency: 'EUR' },
    { credits: 0 }, { credits: 1.5 }, { credits: 100001 }, { termsRevision: 'terms-v2' }]) {
    const h = harness(); Object.assign(h.state.offer, update);
    await rejects(h.service.checkout(request()), 'SC19_PAYMENT_OFFER_UNAVAILABLE');
    assert.equal(h.state.createCalls.length, 0);
  }
});

test('checkout retry preserves original price and terms even after catalog changes', async () => {
  const h = harness(); const first = await h.service.checkout(request());
  Object.assign(h.state.offer, { amountMinor: 777, credits: 1, revision: 'revision-v2' });
  assert.deepEqual(await h.service.checkout(request()), first);
  assert.equal(h.state.createCalls.length, 1); assert.equal(h.state.orders.get(first.orderId).credits, 12);
  await rejects(h.service.checkout(request({ termsRevision: 'terms-v2' })), 'SC19_PAYMENT_REQUEST_CONFLICT');
});

test('concurrent checkout reuses one durable order and provider idempotency key', async () => {
  const h = harness();
  const results = await Promise.all(Array.from({ length: 8 }, () => h.service.checkout(request())));
  assert.equal(h.state.orders.size, 1); assert.equal(h.state.providerSessions.size, 1);
  assert.equal(new Set(results.map(r => r.sessionId)).size, 1);
  assert.equal(new Set(h.state.createCalls.map(c => c.key)).size, 1);
});

test('provider timeout leaves retryable durable order and does not allocate a new payment key', async () => {
  const h = harness(); h.state.failProvider = true;
  await assert.rejects(h.service.checkout(request()), /timeout/);
  assert.equal(h.state.orders.size, 1); assert.equal(h.state.grants.size, 0);
  h.state.failProvider = false;
  const hosted = await h.service.checkout(request());
  assert.equal(h.state.providerSessions.size, 1); assert.equal(h.state.createCalls.length, 2);
  assert.equal(h.state.createCalls[0].key, h.state.createCalls[1].key);
  assert.equal(h.state.orders.get(hosted.orderId).sessionId, hosted.sessionId);
});

test('expired unbound order retrieves original checkout with no second payment', async () => {
  const h = harness(); h.state.failProvider = true;
  await assert.rejects(h.service.checkout(request()), /timeout/);
  const [order] = h.state.orders.values(); h.state.orders.set(order.id, { ...order, checkoutDeadlineMs: 1 });
  h.state.failProvider = false;
  const hosted = await h.service.checkout(request());
  assert.equal(hosted.sessionId, `checkout-${order.id}`);
  assert.equal(h.state.orders.get(order.id).sessionId, hosted.sessionId);
  assert.equal(h.state.lookupCalls.length, 1);
  assert.equal(h.state.createCalls.length, 1);
});

test('absent or ambiguous lookup after deadline cannot start another payment', async () => {
  const h = harness(); h.state.failProvider = true;
  await assert.rejects(h.service.checkout(request()), /timeout/);
  const [order] = h.state.orders.values(); h.state.orders.set(order.id, { ...order, checkoutDeadlineMs: 1 });
  h.state.providerSessions.clear(); h.state.failProvider = false;
  await rejects(h.service.checkout(request()), 'SC19_PAYMENT_RECONCILIATION_REQUIRED');
  h.state.failLookup = true;
  await assert.rejects(h.service.checkout(request()), /provider lookup is uncertain/);
  assert.equal(h.state.createCalls.length, 1);
  assert.equal(h.state.grants.size, 0);
});

test('checkout URL must match exact approved HTTPS origin, no credentials or fragment', async () => {
  for (const url of ['http://pay.fixture.invalid/x', 'https://pay.fixture.invalid.evil.test/x',
    'https://user:pass@pay.fixture.invalid/x', 'https://pay.fixture.invalid/x#token', 'javascript:alert(1)']) {
    const h = harness(); h.state.url = url;
    await rejects(h.service.checkout(request()), 'SC19_PAYMENT_CHECKOUT_INVALID');
    assert.equal([...h.state.orders.values()][0].sessionId, null);
  }
});

test('provider merchant/test-live mismatch cannot bind checkout', async () => {
  for (const update of [{ mode: 'live' }, { account: 'different-merchant' }, { provider: 'different-provider' }]) {
    const h = harness(); h.state.sessionScope = { ...scope, ...update };
    await rejects(h.service.checkout(request()), 'SC19_PAYMENT_CHECKOUT_INVALID');
  }
});

test('verified paid notification grants snapshotted credits exactly once', async () => {
  const h = harness(); await h.paid(); h.state.offer.credits = 99;
  assert.equal((await h.notify()).state, 'applied');
  assert.equal(h.state.credits.get(id(1)), 12); assert.equal(h.state.grants.size, 1);
  assert.equal((await h.notify()).state, 'already_applied');
  h.state.payment.eventId = 'event-2';
  assert.equal((await h.notify()).state, 'already_applied'); assert.equal(h.state.credits.get(id(1)), 12);
});

test('concurrent duplicate events grant once in transactional fake', async () => {
  const h = harness(); await h.paid();
  const result = await Promise.all(Array.from({ length: 10 }, () => h.notify()));
  assert.equal(result.filter(r => r.state === 'applied').length, 1);
  assert.equal(h.state.credits.get(id(1)), 12); assert.equal(h.state.grants.size, 1);
});

test('pending and failed outcomes do not grant or undo a paid order', async () => {
  const h = harness(); await h.paid({ status: 'pending' });
  assert.equal((await h.notify()).state, 'not_paid'); assert.equal(h.state.grants.size, 0);
  h.state.payment.status = 'failed'; assert.equal((await h.notify()).state, 'not_paid');
  h.state.payment.status = 'paid'; await h.notify();
  h.state.payment.status = 'failed'; await h.notify(); assert.equal(h.state.credits.get(id(1)), 12);
  assert.equal([...h.state.orders.values()][0].status, 'paid');
});

test('invalid signature never reaches grant and no browser success parameter is accepted', async () => {
  const h = harness(); await h.paid(); h.state.authenticated = false;
  await assert.rejects(h.notify(), /invalid provider signature/); assert.equal(h.state.grants.size, 0);
  await rejects(h.service.notification(new Uint8Array(), ''), 'SC19_PAYMENT_NOTIFICATION_INVALID');
  await rejects(h.service.notification(new Uint8Array(262145), 'signed'), 'SC19_PAYMENT_NOTIFICATION_INVALID');
  await rejects(h.service.checkout(request({ success: true })), 'SC19_PAYMENT_INVALID');
});

test('amount, currency, session, merchant and mode tampering cannot grant', async () => {
  for (const change of [{ amountMinor: 1 }, { amountMinor: 12344 }, { amountMinor: 12346 }, { amountMinor: 12345.1 },
    { currency: 'EUR' }, { sessionId: 'checkout-foreign' }, { scope: { ...scope, mode: 'live' } },
    { scope: { ...scope, account: 'other-merchant' } }, { scope: { ...scope, provider: 'other-provider' } }]) {
    const h = harness(); await h.paid(change);
    await assert.rejects(h.notify(), e => e instanceof Sc19PaymentError);
    assert.equal(h.state.grants.size, 0); assert.equal(h.state.credits.size, 0);
  }
});

test('unknown order or early event before session binding is retryable, never acknowledged as processed', async () => {
  const h = harness(); const hosted = await h.paid();
  h.state.payment.orderId = id(99); await rejects(h.notify(), 'SC19_PAYMENT_ORDER_MISSING');
  h.state.payment.orderId = hosted.orderId;
  const original = h.state.orders.get(hosted.orderId);
  h.state.orders.set(hosted.orderId, { ...original, sessionId: null });
  h.state.providerSessions.clear(); // No provider-confirmed checkout to reconcile.
  await rejects(h.notify(), 'SC19_PAYMENT_SESSION_NOT_BOUND'); assert.equal(h.state.grants.size, 0);
  h.state.orders.set(hosted.orderId, original); assert.equal((await h.notify()).state, 'applied');
});

test('transaction write failure rolls back grant, credit increment and paid state together', async () => {
  const h = harness(); await h.paid(); h.state.failSave = true;
  await assert.rejects(h.notify(), /simulated database/);
  assert.equal(h.state.grants.size, 0); assert.equal(h.state.credits.size, 0);
  assert.equal([...h.state.orders.values()][0].status, 'awaiting_payment');
  h.state.failSave = false; assert.equal((await h.notify()).state, 'applied'); assert.equal(h.state.credits.get(id(1)), 12);
});

test('one payment cannot fulfill a second order, even with another event ID and session', async () => {
  const h = harness(); await h.paid(); await h.notify();
  const second = await h.service.checkout(request({ requestId: id(11) }));
  Object.assign(h.state.payment, { orderId: second.orderId, sessionId: second.sessionId, eventId: 'event-second' });
  await rejects(h.notify(), 'SC19_PAYMENT_REUSED'); assert.equal(h.state.credits.get(id(1)), 12);
  assert.equal(h.state.orders.get(second.orderId).status, 'awaiting_payment');
});

test('second actual payment for an already-paid order requires review, not another grant', async () => {
  const h = harness(); await h.paid(); await h.notify();
  h.state.payment.paymentId = 'payment-other';
  await rejects(h.notify(), 'SC19_PAYMENT_DOUBLE_PAYMENT_REVIEW'); assert.equal(h.state.credits.get(id(1)), 12);
});

test('already-paid order retry cannot create a new payment', async () => {
  const h = harness(); const hosted = await h.paid(); await h.notify();
  assert.deepEqual(await h.service.checkout(request()), { orderId: hosted.orderId, paid: true });
  assert.equal(h.state.createCalls.length, 1);
});

test('merchant scope mismatch in stored order fails closed', async () => {
  const h = harness(); const hosted = await h.paid();
  const order = h.state.orders.get(hosted.orderId);
  h.state.orders.set(order.id, { ...order, scope: { ...scope, account: 'another-account' } });
  await rejects(h.notify(), 'SC19_PAYMENT_SCOPE_MISMATCH'); assert.equal(h.state.grants.size, 0);
});

test('canonical checkout economics must match exactly before URL exposure', async () => {
  for (const update of [{ sessionAmountMinor: 12344 }, { sessionAmountMinor: 12346 },
    { sessionCurrency: 'EUR' }, { sessionPaymentKind: 'subscription' }]) {
    const h = harness(); Object.assign(h.state, update);
    await rejects(h.service.checkout(request()), 'SC19_PAYMENT_CHECKOUT_INVALID');
    const [order] = h.state.orders.values();
    assert.equal(order.sessionId, null); assert.equal(h.state.grants.size, 0);
  }
});

test('recovered provider checkout cannot alter snapshotted economics', async () => {
  const h = harness(); h.state.sessionPaymentKind = 'subscription'; h.state.failProvider = true;
  await assert.rejects(h.service.checkout(request()), /timeout/);
  const [order] = h.state.orders.values(); h.state.orders.set(order.id, { ...order, checkoutDeadlineMs: 1 });
  h.state.failProvider = false;
  await rejects(h.service.checkout(request()), 'SC19_PAYMENT_CHECKOUT_INVALID');
  assert.equal(h.state.lookupCalls.length, 1); assert.equal(h.state.createCalls.length, 1);
  assert.equal(h.state.grants.size, 0);
});

test('signed paid webhook reconciles original checkout after a lost provider response', async () => {
  const h = harness(); h.state.failProvider = true;
  await assert.rejects(h.service.checkout(request()), /timeout/);
  const [order] = h.state.orders.values();
  const hosted = [...h.state.providerSessions.values()][0];
  h.state.payment = { eventId: 'event-recovered', orderId: order.id, sessionId: hosted.sessionId,
    paymentId: 'payment-recovered', scope: { ...scope }, amountMinor: 12345,
    currency: 'PLN', status: 'paid' };
  assert.equal((await h.notify()).state, 'applied');
  assert.equal(h.state.orders.get(order.id).sessionId, hosted.sessionId);
  assert.equal(h.state.credits.get(id(1)), 12);
  assert.equal((await h.notify()).state, 'already_applied');
  assert.equal(h.state.createCalls.length, 1);
});

test('lost-response webhook rejects economically invalid original checkout', async () => {
  const h = harness(); h.state.sessionAmountMinor = 12346; h.state.failProvider = true;
  await assert.rejects(h.service.checkout(request()), /timeout/);
  const [order] = h.state.orders.values();
  const hosted = [...h.state.providerSessions.values()][0];
  h.state.payment = { eventId: 'event-invalid', orderId: order.id, sessionId: hosted.sessionId,
    paymentId: 'payment-invalid', scope: { ...scope }, amountMinor: 12346,
    currency: 'PLN', status: 'paid' };
  await rejects(h.notify(), 'SC19_PAYMENT_CHECKOUT_INVALID');
  assert.equal(h.state.grants.size, 0); assert.equal(h.state.credits.size, 0);
});

test('disabled checkout still fulfills an existing signed provider payment', async () => {
  const h = harness(); await h.paid();
  const disabled = h.recreate({ enabled: false });
  await rejects(disabled.checkout(request({ requestId: id(11) })), 'SC19_PAYMENTS_DISABLED');
  const raw = new Uint8Array([123, 125]);
  assert.equal((await disabled.notification(raw, 'synthetic-verified-notification')).state, 'applied');
  assert.equal(h.state.credits.get(id(1)), 12);
  assert.equal((await disabled.notification(raw, 'synthetic-verified-notification')).state, 'already_applied');
});

test('revoked LIVE checkout approval cannot strand an existing payment', async () => {
  const liveScope = { ...scope, mode: 'live' };
  const h = harness({ scope: liveScope, liveApproved: true });
  h.state.sessionScope = liveScope;
  const hosted = await h.service.checkout(request());
  h.state.payment = { eventId: 'event-live', orderId: hosted.orderId, sessionId: hosted.sessionId,
    paymentId: 'payment-live', scope: liveScope, amountMinor: 12345, currency: 'PLN', status: 'paid' };
  const revoked = h.recreate({ liveApproved: false });
  await rejects(revoked.checkout(request({ requestId: id(11) })), 'SC19_PAYMENTS_DISABLED');
  assert.equal((await revoked.notification(new Uint8Array([123, 125]), 'synthetic-verified-notification')).state, 'applied');
  assert.equal(h.state.credits.get(id(1)), 12);
});

test('cross-session second payment needs refund review, never additional credits', async () => {
  const h = harness(); await h.paid(); await h.notify();
  Object.assign(h.state.payment, { paymentId: 'payment-foreign', sessionId: 'checkout-foreign', eventId: 'event-foreign' });
  await rejects(h.notify(), 'SC19_PAYMENT_DOUBLE_PAYMENT_REVIEW');
  assert.equal(h.state.credits.get(id(1)), 12); assert.equal(h.state.grants.size, 1);
  h.state.payment.paymentId = 'payment-1';
  await rejects(h.notify(), 'SC19_PAYMENT_ORDER_MISMATCH');
});
