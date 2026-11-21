// R7 live: real Stripe payments, Fakturownia VAT invoice per payment, correction
// invoice per refund, the one-off Stripe setup endpoint. Offline: Stripe and
// Fakturownia are fakes behind injected fetch functions, stores are in memory. No
// network, no database, no real key or token (all keys below are synthetic).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createSc19Payments } from '../lib/sc19-payments.ts';
import { createSc19PaymentHttp } from '../lib/sc19-payment-http.ts';
import { createStripeProvider, STRIPE_CHECKOUT_ORIGIN } from '../lib/sc19-stripe-provider.ts';
import { sc19StripeGate } from '../lib/sc19-stripe-config.ts';
import { STRIPE_PACKAGE_OFFERS, stripeLivePackageExtension, stripePackageExtension } from '../lib/sc19-stripe-packages.ts';
import { createFakturowniaClient } from '../lib/fakturownia-client.ts';
import { SELLER_NIP, afterStripePayment, fakturowniaPaymentType, handleRefund, invoiceItemName, issueOrderInvoice, paymentMethodLabel, stripeLiveApproved, stripeRefundEvent } from '../lib/sc19-stripe-invoices.ts';

import { STRIPE_OPS_TOKEN_SHA256, STRIPE_WEBHOOK_URL, stripeOpsAuthorized, stripeOpsGate, stripeOpsSetup, stripeOpsStatus } from '../lib/stripe-ops.ts';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LIVE = 'sk_live_' + 'a'.repeat(24);
const WHSEC = 'whsec_' + 'b'.repeat(32);
const ORIGIN = 'https://skillcheck.pl';
const liveScope = { provider: 'stripe', account: 'ktig-consulting', mode: 'live' };
const BUYER_NIP = '5260250274';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const signed = (event, secret = WHSEC) => {
  const t = Math.floor(Date.now() / 1000); const raw = new TextEncoder().encode(JSON.stringify(event));
  return { raw, header: `t=${t},v1=${createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex')}` };
};
const paidOrder = (extra = {}) => ({ id: id(7), companyId: id(1), buyerId: id(2), requestId: id(10), offerId: 'preselection-v1',
  offerRevision: 'r1', termsRevision: 't1', amountMinor: 60000, currency: 'PLN', credits: 120, scope: liveScope, status: 'paid',
  sessionId: 'cs_live_fakesession1', checkoutUrl: null, paymentId: 'pi_fakeintent1', checkoutDeadlineMs: Date.now(), ...extra });

/** Stripe for one paid live order: session + PaymentIntent with its latest charge. */
function fakeStripe(order, opts = {}) {
  const s = { calls: [], refunded: 0, method: opts.method ?? { type: 'blik' }, app: opts.app ?? 'skillcheck-core' };
  s.fetch = async (url, init) => {
    const u = new URL(url); s.calls.push(`${init.method} ${u.pathname}`);
    assert.equal(init.headers.Authorization, `Bearer ${LIVE}`);
    if (u.pathname === `/v1/checkout/sessions/${order.sessionId}`)
      return json({ id: order.sessionId, livemode: true, payment_status: 'paid', payment_intent: order.paymentId,
        metadata: { app: 'skillcheck-core', order_id: order.id },
        customer_details: { email: 'faktury@example.test', address: { line1: 'ul. Testowa 1', line2: 'lok. 2', postal_code: '00-001', city: 'Warszawa' } } });
    if (u.pathname === `/v1/payment_intents/${order.paymentId}`) {
      assert.equal(u.searchParams.get('expand[0]'), 'latest_charge');
      return json({ id: order.paymentId, livemode: true, status: 'succeeded', currency: 'pln', amount_received: opts.amountReceived ?? order.amountMinor,
        metadata: { app: s.app, order_id: order.id },
        latest_charge: { id: 'ch_fake1', created: 1_795_000_000, amount_refunded: s.refunded, payment_method_details: s.method } });
    }
    return json({ error: { code: 'resource_missing' } }, 404);
  };
  return s;
}
const provider = (stripe, order) => createStripeProvider({ secretKey: LIVE, webhookSecret: WHSEC, mode: 'live', appOrigin: ORIGIN,
  scope: liveScope, fetch: stripe.fetch, async buyer() { throw Error('not used'); },
  customers: { async find() { return null; }, async save() { return 'cus_x'; }, async replace() { return 'cus_x'; } } });

/** Fakturownia: documents by oid, unique; optional failures. */
function fakeFakturownia() {
  const f = { docs: [], posts: [], fail: 0, loseResponse: false, seq: 100 };
  f.fetch = async (url, init) => {
    const u = new URL(url);
    if (init.method === 'POST') {
      const { invoice } = JSON.parse(init.body); f.posts.push(invoice);
      if (f.fail > 0) { f.fail--; return json({}, 503); }
      if (f.docs.some(d => d.oid === invoice.oid)) return json({ code: 'error', message: 'oid' }, 422);
      const doc = { id: ++f.seq, kind: invoice.kind, status: 'paid', number: `FV ${f.seq}/2026`, oid: invoice.oid,
        price_gross: invoice.positions[0].total_price_gross, paid: invoice.paid, currency: 'PLN', issue_date: '2026-11-22' };
      f.docs.push(doc);
      if (f.loseResponse) { f.loseResponse = false; throw new TypeError('fetch failed'); }
      return json(doc);
    }
    if (u.pathname === '/invoices.json') return json(f.docs);
    return json({}, 404);
  };
  f.client = createFakturowniaClient({ account: 'ktig', token: 'synthetic-token-123' }, f.fetch);
  return f;
}
/** Mirrors sc19_stripe.invoices / refunds / invoice_corrections (migration 20261122090000). */
function memoryStore(order, nip = BUYER_NIP) {
  const m = { invoices: new Map(), refunds: new Map(), corrections: new Map(), now: 0 };
  m.store = {
    async installed() { return true; },
    async buyer(orderId) { return orderId === order.id ? { name: 'Firma Kupująca sp. z o.o.', nip } : null; },
    async claim(o, nowMs, leaseMs) {
      const row = m.invoices.get(o.id) ?? { status: 'new', attempts: 0, lease: 0 };
      m.invoices.set(o.id, row);
      if (row.status === 'issued' || row.status === 'skipped') return row.status;
      if (row.status === 'pending' && row.lease >= nowMs) return 'busy';
      Object.assign(row, { status: 'pending', attempts: row.attempts + 1, lease: nowMs + leaseMs });
      return row.attempts;
    },
    async skip(orderId, code) { Object.assign(m.invoices.get(orderId), { status: 'skipped', code }); },
    async issued(orderId, inv, method) { Object.assign(m.invoices.get(orderId), { status: 'issued', fakturowniaId: inv.id, method }); },
    async failed(orderId, code) { const r = m.invoices.get(orderId); if (r.status === 'pending') Object.assign(r, { status: 'failed', code }); },
    async invoice(orderId) { const r = m.invoices.get(orderId); return r ? { status: r.status, fakturowniaId: r.fakturowniaId ?? null } : null; },
    async orderByPayment(pi) { return pi === order.paymentId ? structuredClone(order) : null; },
    async recordRefund(o, total) { const r = m.refunds.get(o.id) ?? { total: 0, lease: 0 }; r.total = Math.max(r.total, total); m.refunds.set(o.id, r); return r.total; },
    async leaseCorrection(orderId, nowMs, leaseMs) { const r = m.refunds.get(orderId); if (r.lease >= nowMs) return 'busy'; r.lease = nowMs + leaseMs; return r.total; },
    async releaseCorrection(orderId) { m.refunds.get(orderId).lease = 0; },
    async corrections(orderId) { return [...m.corrections.values()].filter(c => c.orderId === orderId).map(c => ({ refundedTotal: c.total, status: c.status })); },
    async startCorrection(orderId, total) {
      const k = `${orderId}:${total}`; const r = m.corrections.get(k) ?? { orderId, total, status: 'pending', attempts: 0 };
      m.corrections.set(k, r); if (r.status === 'issued') return 'issued'; r.status = 'pending'; return ++r.attempts;
    },
    async correctionIssued(orderId, total, inv) { Object.assign(m.corrections.get(`${orderId}:${total}`), { status: 'issued', fakturowniaId: inv.id }); },
    async correctionFailed(orderId, total, code) { Object.assign(m.corrections.get(`${orderId}:${total}`), { status: 'failed', code }); },
  };
  return m;
}
function setup(opts = {}) {
  const order = paidOrder(opts.order);
  const stripe = fakeStripe(order, opts);
  const fakt = fakeFakturownia();
  const mem = memoryStore(order, opts.nip);
  const p = provider(stripe, order);
  const deps = { fakturownia: opts.noFakturownia ? null : fakt.client, store: mem.store, paymentFacts: o => p.paymentFacts(o), now: () => 1_795_000_100_000 };
  return { order, stripe, fakt, mem, p, deps };
}

test('live gate: production + live key + Fakturownia only; Preview refuses a live key; live sells PRESELEKCJA only', async () => {
  assert.equal(stripeLiveApproved({ mode: 'live', deployment: 'production' }, true), true);
  assert.equal(stripeLiveApproved({ mode: 'live', deployment: 'production' }, false), false, 'no sale without invoices');
  assert.equal(stripeLiveApproved({ mode: 'live', deployment: 'preview' }, true), false);
  assert.equal(stripeLiveApproved({ mode: 'test', deployment: 'production' }, true), false);
  const preview = sc19StripeGate({ VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'integration', STRIPE_SECRET_KEY: LIVE,
    STRIPE_WEBHOOK_SECRET: WHSEC, NEXT_PUBLIC_SUPABASE_URL: 'https://orbyscrupgnupifzlqxp.supabase.co' });
  assert.deepEqual([preview.ok, preview.reason], [false, 'stripe_mode']);
  // The orchestration: a live scope opens checkout only with liveApproved AND the sales switch.
  const base = { store: { transaction: async () => null }, provider: {}, authenticate: async () => null, scope: liveScope, checkoutOrigins: [STRIPE_CHECKOUT_ORIGIN] };
  assert.equal(createSc19Payments({ ...base, enabled: true, liveApproved: false }).checkoutEnabled, false);
  assert.equal(createSc19Payments({ ...base, enabled: false, liveApproved: true }).checkoutEnabled, false);
  assert.equal(createSc19Payments({ ...base, enabled: true, liveApproved: true }).checkoutEnabled, true);
  // Live: no WERYFIKACJA / ASSESSMENT CENTER offer, and their offer ids are unknown.
  const client = { async query(sql) { return { rows: /to_regclass/.test(sql) ? [{ ok: true }] : [] }; } };
  const baseTx = { offer: async k => (k === 'preselection-v1' ? { id: k } : null) };
  assert.deepEqual(await stripeLivePackageExtension.offers(client), []);
  assert.equal((await stripePackageExtension.offers(client)).length, 2, 'test mode unchanged');
  const tx = stripeLivePackageExtension.tx(baseTx, client, async () => {});
  for (const o of STRIPE_PACKAGE_OFFERS) assert.equal(await tx.offer(o.id), null, o.id);
  assert.deepEqual(await tx.offer('preselection-v1'), { id: 'preselection-v1' });
  assert.notEqual(await stripePackageExtension.tx(baseTx, client, async () => {}).offer(STRIPE_PACKAGE_OFFERS[0].id), null);
});

test('invoice: one VAT invoice per live payment, buyer from registration and session, method and Stripe id on it; duplicates issue nothing', async () => {
  const { order, fakt, mem, deps } = setup();
  assert.equal(await issueOrderInvoice(order, deps), 'issued');
  assert.equal(await issueOrderInvoice(order, deps), 'already_issued');
  assert.equal(await afterStripePayment(order, deps), undefined);
  assert.equal(fakt.posts.length, 1);
  const inv = fakt.posts[0];
  assert.equal(inv.kind, 'vat'); assert.equal(inv.oid, `core:${order.id}`); assert.equal(inv.oid_unique, 'yes');
  assert.equal(inv.status, 'paid'); assert.equal(inv.paid, '600.00'); assert.equal(inv.payment_type, 'BLIK');
  assert.equal(inv.buyer_name, 'Firma Kupująca sp. z o.o.'); assert.equal(inv.buyer_tax_no, BUYER_NIP);
  assert.equal(inv.buyer_street, 'ul. Testowa 1 lok. 2'); assert.equal(inv.buyer_post_code, '00-001'); assert.equal(inv.buyer_city, 'Warszawa');
  assert.equal(inv.buyer_email, 'faktury@example.test');
  assert.deepEqual(inv.positions, [{ name: invoiceItemName(order), quantity: 2, quantity_unit: 'szt.', tax: 23, total_price_gross: '600.00' }]);
  assert.match(invoiceItemName(order), /PRESELEKCJA — pakiet 60 analiz CV \(2 pakiety, pula 120 analiz CV\)/);
  assert.match(inv.description, /Stripe \(BLIK\)\. ID płatności Stripe: pi_fakeintent1\./);
  assert.deepEqual(inv.calculating_strategy, { position: 'keep_gross', sum: 'keep_gross', invoice_form_price_kind: 'gross' });
  assert.equal(mem.invoices.get(order.id).status, 'issued'); assert.equal(mem.invoices.get(order.id).method, 'blik');
});

test('invoice: payment method from the Stripe charge (card, Apple Pay / Google Pay wallet, BLIK, P24, Link)', async () => {
  assert.equal(fakturowniaPaymentType('card'), 'card'); assert.equal(fakturowniaPaymentType('apple_pay'), 'card');
  assert.equal(fakturowniaPaymentType('google_pay'), 'card'); assert.equal(fakturowniaPaymentType('link'), 'card');
  assert.equal(fakturowniaPaymentType('blik'), 'BLIK'); assert.equal(fakturowniaPaymentType('p24'), 'Przelewy24');
  assert.equal(fakturowniaPaymentType(null), 'card'); assert.equal(fakturowniaPaymentType('klarna'), 'Stripe');
  assert.equal(paymentMethodLabel('apple_pay'), 'Apple Pay'); assert.equal(paymentMethodLabel(null), 'płatność online');
  for (const [method, type, label] of [[{ type: 'card', card: { wallet: { type: 'apple_pay' } } }, 'card', 'Apple Pay'],
    [{ type: 'card', card: { wallet: { type: 'google_pay' } } }, 'card', 'Google Pay'], [{ type: 'card', card: {} }, 'card', 'karta'],
    [{ type: 'p24' }, 'Przelewy24', 'Przelewy24'], [{ type: 'link' }, 'card', 'Link']]) {
    const { order, fakt, deps } = setup({ method });
    assert.equal(await issueOrderInvoice(order, deps), 'issued');
    assert.equal(fakt.posts[0].payment_type, type); assert.match(fakt.posts[0].description, new RegExp(`\\(${label}\\)`));
  }
});

test('invoice: a lost Fakturownia response is recovered by oid, never a second document; a failure asks Stripe to redeliver', async () => {
  const lost = setup();
  lost.fakt.loseResponse = true;
  assert.equal(await issueOrderInvoice(lost.order, lost.deps), 'retry');
  assert.equal(lost.mem.invoices.get(lost.order.id).status, 'failed');
  assert.equal(await issueOrderInvoice(lost.order, lost.deps), 'issued');
  assert.equal(lost.fakt.docs.length, 1, 'the retry found the first document by oid');
  assert.equal(lost.mem.invoices.get(lost.order.id).fakturowniaId, lost.fakt.docs[0].id);
  const down = setup();
  down.fakt.fail = 1;
  assert.equal(await afterStripePayment(down.order, down.deps), 'retry');
  assert.equal(down.mem.invoices.get(down.order.id).code, 'FAKTUROWNIA_UNAVAILABLE');
  assert.equal(await afterStripePayment(down.order, down.deps), undefined);
  assert.equal(down.fakt.docs.length, 1);
  // A claim held by another attempt (lease) is not doubled.
  const busy = setup();
  await busy.mem.store.claim(busy.order, busy.deps.now(), 60_000);
  assert.equal(await issueOrderInvoice(busy.order, busy.deps), 'retry');
  assert.equal(busy.fakt.posts.length, 0);
});

test('invoice: only live, paid PRESELEKCJA Stripe payments; test payments, other packages and a missing Fakturownia get nothing', async () => {
  for (const extra of [{ scope: { ...liveScope, mode: 'test' } }, { status: 'awaiting_payment' }, { packageCode: 'WERYFIKACJA', credits: 60, amountMinor: 61500 }]) {
    const { order, fakt, deps } = setup({ order: extra });
    assert.equal(await issueOrderInvoice(order, deps), 'not_applicable', JSON.stringify(extra));
    assert.equal(fakt.posts.length, 0);
  }
  const off = setup({ noFakturownia: true });
  assert.equal(await issueOrderInvoice(off.order, off.deps), 'disabled');
  assert.equal(off.mem.invoices.size, 0);
  // Stripe disagrees with the order (amount): no document.
  const wrong = setup({ amountReceived: 1 });
  assert.equal(await issueOrderInvoice(wrong.order, wrong.deps), 'retry');
  assert.equal(wrong.fakt.posts.length, 0);
});

test('KTIG control purchase (seller NIP): package stays, no invoice and no correction', async () => {
  const { order, fakt, mem, deps } = setup({ nip: SELLER_NIP });
  assert.equal(SELLER_NIP, '7394002294');
  assert.equal(await issueOrderInvoice(order, deps), 'skipped');
  assert.equal(await issueOrderInvoice(order, deps), 'skipped');
  assert.equal(mem.invoices.get(order.id).status, 'skipped');
  assert.equal(await handleRefund({ paymentIntentId: order.paymentId, orderId: order.id, refundedTotal: order.amountMinor }, deps), 'skipped');
  assert.equal(fakt.posts.length, 0);
  assert.equal(mem.refunds.get(order.id).total, order.amountMinor, 'the refund itself is still recorded');
});

test('refund: partial then full refund get one correction each; duplicates and an older event issue nothing', async () => {
  const { order, fakt, mem, deps } = setup();
  const refund = total => handleRefund({ paymentIntentId: order.paymentId, orderId: order.id, refundedTotal: total }, deps);
  // The original invoice is issued first when it is still missing.
  assert.equal(await refund(20000), 'issued');
  assert.deepEqual(fakt.posts.map(p => p.kind), ['vat', 'correction']);
  const partial = fakt.posts[1];
  assert.equal(partial.oid, `core-korekta:${order.id}:20000`); assert.equal(partial.invoice_id, fakt.docs[0].id);
  assert.equal(partial.correction_reason, 'Częściowy zwrot płatności');
  assert.equal(partial.positions[0].total_price_gross, '-200.00');
  assert.equal(partial.positions[0].correction_before_attributes.total_price_gross, '600.00');
  assert.equal(partial.positions[0].correction_after_attributes.total_price_gross, '400.00');
  assert.equal(partial.payment_type, 'BLIK');
  assert.equal(await refund(20000), 'already_issued');
  assert.equal(await refund(60000), 'issued');
  const full = fakt.posts[2];
  assert.equal(full.correction_reason, 'Zwrot całej płatności');
  assert.equal(full.positions[0].correction_before_attributes.total_price_gross, '400.00');
  assert.equal(full.positions[0].correction_after_attributes.total_price_gross, '0.00');
  assert.equal(full.positions[0].correction_after_attributes.quantity, 0);
  assert.equal(full.positions[0].total_price_gross, '-400.00');
  // A late, older event (20000) after the full refund: nothing new.
  assert.equal(await refund(20000), 'already_issued');
  assert.equal(await refund(60000), 'already_issued');
  assert.equal(fakt.posts.length, 3);
  assert.equal(mem.refunds.get(order.id).total, 60000);
  // Out of range or unknown payment: ignored.
  assert.equal(await refund(60001), 'ignored');
  assert.equal(await handleRefund({ paymentIntentId: 'pi_fakeother9', orderId: order.id, refundedTotal: 100 }, deps), 'ignored');
  assert.equal(await handleRefund({ paymentIntentId: order.paymentId, orderId: id(99), refundedTotal: 100 }, deps), 'ignored');
});

test('refund: a later, larger refund supersedes one not yet corrected (one document, no overlap)', async () => {
  const { order, fakt, deps } = setup();
  assert.equal(await issueOrderInvoice(order, deps), 'issued');
  fakt.fail = 1;
  const refund = total => handleRefund({ paymentIntentId: order.paymentId, orderId: order.id, refundedTotal: total }, deps);
  assert.equal(await refund(10000), 'retry');
  assert.equal(await refund(30000), 'issued');
  const corrections = fakt.docs.filter(d => d.kind === 'correction');
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].oid, `core-korekta:${order.id}:30000`);
  assert.equal(await refund(10000), 'already_issued', 'the redelivered smaller refund adds nothing');
});

test('webhook charge.refunded: signed, re-read from the API; other application and other mode ignored; failures ask for redelivery', async () => {
  const { order, stripe, fakt, deps, p } = setup();
  const event = (extra = {}) => ({ id: 'evt_fakerefund1', type: 'charge.refunded', livemode: true,
    data: { object: { id: 'ch_fake1', payment_intent: order.paymentId, amount_refunded: 99999, metadata: {} } }, ...extra });
  const run = ev => stripeRefundEvent(() => p.verifyRefund(ev.raw, ev.header), deps);
  // The amount comes from the API (latest_charge.amount_refunded), not from the body.
  stripe.refunded = 15000;
  assert.deepEqual(await run(signed(event())), { state: 'refund_issued' });
  assert.equal(fakt.docs.filter(d => d.kind === 'correction')[0].oid, `core-korekta:${order.id}:15000`);
  assert.deepEqual(await run(signed(event())), { state: 'refund_already_issued' });
  // Bad signature: refused before any read.
  const before = stripe.calls.length;
  await assert.rejects(run(signed(event(), 'whsec_' + 'c'.repeat(32))), e => e.code === 'SC19_PAYMENT_NOTIFICATION_INVALID');
  assert.equal(stripe.calls.length, before);
  // Another event type: not handled here (null → the settlement path).
  assert.equal(await run(signed({ ...event(), type: 'checkout.session.completed' })), null);
  // The other application on the same account: by charge metadata (no API read) or by the PaymentIntent.
  assert.deepEqual(await run(signed(event({ data: { object: { id: 'ch_x', payment_intent: order.paymentId, metadata: { app: 'skillcheck-preselekcja' } } } }))), { state: 'ignored' });
  assert.equal(stripe.calls.length, before);
  stripe.app = 'skillcheck-preselekcja';
  assert.deepEqual(await run(signed(event())), { state: 'ignored' });
  stripe.app = 'skillcheck-core';
  assert.deepEqual(await run(signed(event({ livemode: false }))), { state: 'ignored' });
  // Fakturownia down: 503 so Stripe redelivers; then the correction is issued once.
  stripe.refunded = 60000; fakt.fail = 1;
  await assert.rejects(run(signed(event())), e => e.code === 'SC19_PAYMENT_RETRY');
  assert.deepEqual(await run(signed(event())), { state: 'refund_issued' });
  assert.equal(fakt.docs.filter(d => d.kind === 'correction').length, 2);
  // Through the HTTP layer: 200 for handled/ignored, 503 for retry, 400 for a bad signature.
  const runtime = { service: { notification: async () => ({ state: 'ignored' }) }, authenticate: async () => null, readOrder: async () => null,
    listOffers: async () => [], appOrigin: ORIGIN, signatureHeader: 'stripe-signature', events: (raw, sig) => stripeRefundEvent(() => p.verifyRefund(raw, sig), deps) };
  const http = createSc19PaymentHttp(runtime);
  const send = ev => http.webhook(new Request(`${ORIGIN}/api/billing/stripe/webhook`, { method: 'POST', headers: { 'stripe-signature': ev.header }, body: ev.raw }));
  assert.equal((await send(signed(event()))).status, 200);
  assert.equal((await send(signed(event(), 'whsec_' + 'c'.repeat(32)))).status, 400);
  stripe.app = 'skillcheck-preselekcja';
  const other = await send(signed(event()));
  assert.equal(other.status, 200); assert.deepEqual(await other.json(), { state: 'ignored' });
});

test('orchestration: an invoice that is not issued yet answers 503 after the grant; the redelivery retries it; the grant is never undone', async () => {
  const st = { order: { ...paidOrder({ status: 'awaiting_payment', paymentId: null }) }, grants: 0, hook: [] };
  const store = { async transaction(fn) { return fn({
    async order() { return structuredClone(st.order); },
    async grantOnce() { st.grants++; return st.grants > 1 ? st.order.id : null; },
    async saveOrder(o) { st.order = structuredClone(o); },
  }); } };
  let answer = 'retry';
  const providerFake = { async verifyAndRetrieve() { return { eventId: 'evt_fake1', orderId: st.order.id, sessionId: st.order.sessionId,
    paymentId: 'pi_fakeintent1', scope: liveScope, amountMinor: 60000, currency: 'PLN', status: 'paid' }; } };
  const service = createSc19Payments({ store, provider: providerFake, scope: liveScope, checkoutOrigins: [STRIPE_CHECKOUT_ORIGIN],
    enabled: true, liveApproved: true, authenticate: async () => null,
    onPaid: async o => { st.hook.push(['paid', o.status]); return answer; },
    onPaidAgain: async o => { st.hook.push(['again', o.status]); return answer; } });
  const raw = new TextEncoder().encode('{}');
  await assert.rejects(service.notification(raw, 'sig'), e => e.code === 'SC19_PAYMENT_RETRY');
  assert.equal(st.order.status, 'paid'); assert.equal(st.grants, 1);
  answer = undefined;
  assert.equal((await service.notification(raw, 'sig')).state, 'already_applied');
  assert.deepEqual(st.hook, [['paid', 'paid'], ['again', 'paid']]);
  assert.equal(st.order.status, 'paid');
});

test('Fakturownia client: correction and invoice payloads are validated before any request', async () => {
  const f = fakeFakturownia();
  const buyer = { name: 'Firma', nip: BUYER_NIP, street: 'ul. A 1', postCode: '00-001', city: 'Warszawa', email: 'a@example.test' };
  const base = { oid: `core:${id(7)}`, grossMinor: 30000, itemName: 'X', quantity: 1, paymentType: 'card', paymentLabel: 'karta',
    issueDate: '2026-11-22', paidDate: '2026-11-22', paymentReference: 'pi_fakeintent1', buyer };
  for (const bad of [{ oid: 'sc19:x' }, { grossMinor: 0 }, { quantity: 21 }, { paymentType: 'cash' }, { paymentReference: 'evt_1' }, { buyer: { ...buyer, nip: '12' } }])
    await assert.rejects(f.client.createStripeInvoice({ ...base, ...bad }), e => e.code === 'FAKTUROWNIA_REQUEST_REJECTED', JSON.stringify(bad));
  const corr = { oid: `core-korekta:${id(7)}:100`, originalId: 5, itemName: 'X', quantity: 1, beforeGrossMinor: 30000, afterGrossMinor: 29900,
    issueDate: '2026-11-22', paymentType: 'card', paymentReference: 'pi_fakeintent1', reason: 'r', buyer };
  for (const bad of [{ afterGrossMinor: 30000 }, { afterGrossMinor: -1 }, { originalId: 0 }, { oid: `core:${id(7)}` }])
    await assert.rejects(f.client.createCorrection({ ...corr, ...bad }), e => e.code === 'FAKTUROWNIA_REQUEST_REJECTED', JSON.stringify(bad));
  assert.equal(f.posts.length, 0);
});

// ---------------------------------------------------------------- Stripe setup endpoint
function fakeStripeOps() {
  const s = { products: [], prices: [], endpoints: [{ id: 'we_other', url: 'https://skillcheck.com.pl/api/stripe/webhook',
    enabled_events: ['checkout.session.completed'], status: 'enabled', metadata: { app: 'skillcheck-preselekcja' } }], calls: [], keys: new Map(), seq: 0 };
  s.fetch = async (url, init) => {
    const u = new URL(url); const body = Object.fromEntries(new URLSearchParams(init.body ?? ''));
    const key = init.headers['Idempotency-Key']; s.calls.push({ method: init.method, path: u.pathname, body, key });
    assert.equal(init.headers['Stripe-Version'], '2026-10-28.endive');
    if (key && s.keys.has(key)) return json(s.keys.get(key));
    const remember = o => { if (key) s.keys.set(key, o); return json(o); };
    const metadata = Object.fromEntries(Object.entries(body).filter(([k]) => k.startsWith('metadata[')).map(([k, v]) => [k.slice(9, -1), v]));
    if (init.method === 'GET' && u.pathname === '/v1/prices')
      return json({ data: s.prices.filter(p => p.lookup_key === u.searchParams.get('lookup_keys[0]')) });
    if (init.method === 'GET' && u.pathname === '/v1/products/search') {
      const code = /package_code'\]:'([A-Z_]+)'/.exec(u.searchParams.get('query'))[1];
      return json({ data: s.products.filter(p => p.metadata.package_code === code) });
    }
    if (init.method === 'POST' && u.pathname === '/v1/products') {
      const p = { id: `prod_fake${++s.seq}`, name: body.name, description: body.description, metadata }; s.products.push(p); return remember(p);
    }
    if (init.method === 'POST' && u.pathname === '/v1/prices') {
      const p = { id: `price_fake${++s.seq}`, product: body.product, unit_amount: Number(body.unit_amount), currency: body.currency, type: 'one_time',
        tax_behavior: body.tax_behavior, lookup_key: body.lookup_key, livemode: true, active: true, metadata }; s.prices.push(p); return remember(p);
    }
    if (init.method === 'GET' && u.pathname === '/v1/webhook_endpoints') return json({ data: s.endpoints.map(e => ({ ...e, secret: undefined })) });
    if (init.method === 'POST' && u.pathname === '/v1/webhook_endpoints') {
      const events = Object.entries(body).filter(([k]) => k.startsWith('enabled_events[')).map(([, v]) => v);
      const e = { id: `we_fake${++s.seq}`, url: body.url, enabled_events: events, status: 'enabled', api_version: body.api_version, metadata };
      s.endpoints.push(e); return remember({ ...e, secret: 'whsec_' + 'z'.repeat(32) });
    }
    let m;
    if (init.method === 'POST' && (m = /^\/v1\/webhook_endpoints\/(we_[A-Za-z0-9]+)$/.exec(u.pathname))) {
      const e = s.endpoints.find(x => x.id === m[1]);
      e.enabled_events = Object.entries(body).filter(([k]) => k.startsWith('enabled_events[')).map(([, v]) => v); Object.assign(e.metadata, metadata);
      return json(e);
    }
    return json({ error: { code: 'unexpected_call' } }, 500);
  };
  return s;
}

test('stripe-ops token: only the SHA-256 is in the code; constant-time check; no token value in the repository', () => {
  assert.match(STRIPE_OPS_TOKEN_SHA256, /^[0-9a-f]{64}$/);
  const token = 'f'.repeat(64);
  assert.equal(stripeOpsAuthorized(token, createHash('sha256').update(token).digest('hex')), true);
  assert.equal(stripeOpsAuthorized('e'.repeat(64), createHash('sha256').update(token).digest('hex')), false);
  for (const bad of [null, '', 'f'.repeat(63), 'F'.repeat(64), STRIPE_OPS_TOKEN_SHA256 + 'x']) assert.equal(stripeOpsAuthorized(bad), false);
  // The stored hash itself is not a valid token for itself.
  assert.equal(stripeOpsAuthorized(STRIPE_OPS_TOKEN_SHA256), false);
  const route = readFileSync(new URL('../app/api/internal/stripe-ops/route.ts', import.meta.url), 'utf8');
  assert.match(route, /stripeOpsAuthorized\(request\.headers\.get\(STRIPE_OPS_HEADER\)\)/);
  assert.ok(route.indexOf('stripeOpsAuthorized') < route.indexOf('request.json'), 'token checked before the body is read');
});

test('stripe-ops gate: setup only on the production deployment; status never returns a value', async () => {
  const prod = { VERCEL: '1', VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main', NEXT_PUBLIC_SITE_URL: 'https://skillcheck.pl', STRIPE_SECRET_KEY: LIVE };
  assert.deepEqual(stripeOpsGate(prod), { ok: true, key: LIVE, mode: 'live', production: true });
  assert.equal(stripeOpsGate({ ...prod, VERCEL_ENV: 'preview' }).production, false);
  assert.equal(stripeOpsGate({ ...prod, STRIPE_SECRET_KEY: 'pk_live_' + 'a'.repeat(24) }).ok, false);
  assert.equal(stripeOpsGate({ ...prod, VERCEL: undefined }).ok, false);
  const s = fakeStripeOps();
  const fetchAll = async (url, init) => (String(url).includes('fakturownia.pl') ? json([{ id: 1, name: 'KTIG' }]) : s.fetch(url, init));
  const env = { ...prod, STRIPE_WEBHOOK_SECRET: WHSEC, FAKTUROWNIA_ACCOUNT: 'ktig', FAKTUROWNIA_API_TOKEN: 'synthetic-token-123', SC19_PACKAGES_ENABLED: 'true' };
  const status = await stripeOpsStatus(env, fetchAll);
  const text = JSON.stringify(status);
  for (const secret of [LIVE, WHSEC, 'synthetic-token-123']) assert.equal(text.includes(secret), false);
  assert.deepEqual(status.env, { STRIPE_SECRET_KEY: true, STRIPE_WEBHOOK_SECRET: true, FAKTUROWNIA_ACCOUNT: true, FAKTUROWNIA_API_TOKEN: true,
    SC19_P24_CHECKOUT_DATABASE_URL: false, SC19_PACKAGES_ENABLED: true });
  assert.equal(status.stripeMode, 'live'); assert.deepEqual(status.fakturownia, { ok: true, departments: 1 });
  assert.deepEqual(status.stripe, { ok: true, prices: { PRESELEKCJA: 'missing', WERYFIKACJA: 'missing', ASSESSMENT_CENTER: 'missing' }, webhook: 'missing' });
  assert.equal(s.calls.filter(c => c.method === 'POST').length, 0, 'status is read only');
});

test('stripe-ops setup: idempotent products, prices from the price list, webhook created once with the secret returned only then', async () => {
  const s = fakeStripeOps();
  const first = await stripeOpsSetup(LIVE, 'live', s.fetch);
  assert.deepEqual(first.products.map(p => [p.code, p.product, p.price]),
    [['PRESELEKCJA', 'created', 'created'], ['WERYFIKACJA', 'created', 'created'], ['ASSESSMENT_CENTER', 'created', 'created']]);
  assert.deepEqual(s.prices.map(p => [p.lookup_key, p.unit_amount, p.tax_behavior, p.currency, p.metadata.app, p.metadata.package_code]), [
    ['skillcheck-core:PRESELEKCJA', 30000, 'inclusive', 'pln', 'skillcheck-core', 'PRESELEKCJA'],
    ['skillcheck-core:WERYFIKACJA', 61500, 'inclusive', 'pln', 'skillcheck-core', 'WERYFIKACJA'],
    ['skillcheck-core:ASSESSMENT_CENTER', 149900, 'inclusive', 'pln', 'skillcheck-core', 'ASSESSMENT_CENTER']]);
  const doc = readFileSync(new URL('../docs/cennik-2026-11-02.md', import.meta.url), 'utf8');
  for (const [name, minor] of [['PRESELEKCJA', 30000], ['WERYFIKACJA', 61500], ['ASSESSMENT CENTER', 149900]]) {
    const m = new RegExp(`^\\| ${name} \\| ([0-9 ]+) zł \\|`, 'm').exec(doc);
    assert.equal(Number(m[1].replace(/ /g, '')) * 100, minor, name);
  }
  assert.deepEqual(s.products.map(p => p.metadata.availability), ['available', 'wkrotce', 'wkrotce']);
  assert.match(s.products[1].description, /wkrótce/);
  assert.equal(first.webhook.state, 'created'); assert.match(first.webhook.secret, /^whsec_/);
  const ours = s.endpoints.find(e => e.url === STRIPE_WEBHOOK_URL);
  assert.equal(STRIPE_WEBHOOK_URL, 'https://skillcheck.pl/api/billing/stripe/webhook');
  assert.deepEqual(ours.enabled_events, ['checkout.session.completed', 'checkout.session.expired', 'charge.refunded']);
  assert.equal(ours.api_version, '2026-10-28.endive'); assert.equal(ours.metadata.app, 'skillcheck-core');
  // Second run: nothing new, and no secret.
  const posts = s.calls.filter(c => c.method === 'POST').length;
  const second = await stripeOpsSetup(LIVE, 'live', s.fetch);
  assert.deepEqual(second.products.map(p => [p.product, p.price]), [['exists', 'exists'], ['exists', 'exists'], ['exists', 'exists']]);
  assert.deepEqual(second.webhook, { state: 'exists', id: ours.id });
  assert.equal(JSON.stringify(second).includes('whsec_'), false);
  assert.equal(s.calls.filter(c => c.method === 'POST').length, posts);
  // The other application's endpoint is never touched; nothing is ever deleted.
  assert.deepEqual(s.endpoints[0].enabled_events, ['checkout.session.completed']);
  assert.equal(s.calls.some(c => c.method === 'DELETE' || c.path.includes('we_other')), false);
  // An existing endpoint missing an event is updated in place, without a secret.
  ours.enabled_events = ['checkout.session.completed'];
  const third = await stripeOpsSetup(LIVE, 'live', s.fetch);
  assert.deepEqual(third.webhook, { state: 'updated', id: ours.id });
  assert.deepEqual([...ours.enabled_events].sort(), ['charge.refunded', 'checkout.session.completed', 'checkout.session.expired']);
  // A price that differs from the catalog is reported, never changed.
  s.prices[0].unit_amount = 29900;
  assert.equal((await stripeOpsSetup(LIVE, 'live', s.fetch)).products[0].price, 'mismatch');
  assert.equal(s.prices.length, 3);
});
