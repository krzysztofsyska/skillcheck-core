// R7: Fakturownia VAT invoice after a confirmed LIVE Stripe payment
// (lib/sc19-stripe-invoice.ts). Offline: Fakturownia is a fake behind an injected
// fetch and the invoice record is an in-memory fake with the same rules as
// sc19_stripe.claim_vat_invoice / finish_vat_invoice. No network, no database, no
// real key (the token below is a synthetic string).
import test from 'node:test';
import assert from 'node:assert/strict';
import { issueStripeVatInvoice, invoiceItemName, vatInvoiceStore, warsawDate } from '../lib/sc19-stripe-invoice.ts';

const ORDER_ID = '00000000-0000-4000-8000-0000000000a1';
const TOKEN = 'tok_' + 'c'.repeat(20);
const ENV = { FAKTUROWNIA_ACCOUNT: 'ktig', FAKTUROWNIA_API_TOKEN: TOKEN };
const NIP = '7394002294';
const COMPANY = 'Firma Testowa sp. z o.o.';
const ADDRESS = { street: 'ul. Testowa 1', postCode: '00-001', city: 'Warszawa', country: 'PL' };
const NOW = Date.parse('2026-11-21T23:30:00Z'); // 22.11 in Warsaw

const order = (extra = {}) => ({
  id: ORDER_ID, companyId: '00000000-0000-4000-8000-000000000001', buyerId: '00000000-0000-4000-8000-000000000002',
  requestId: '00000000-0000-4000-8000-000000000010', offerId: 'preselection-v1', offerRevision: 'r1', termsRevision: 't1',
  amountMinor: 60000, currency: 'PLN', credits: 120, scope: { provider: 'stripe', account: 'ktig-consulting', mode: 'live' },
  status: 'paid', sessionId: 'cs_live_abcdefgh', checkoutUrl: null, paymentId: 'pi_abcdefgh12', checkoutDeadlineMs: NOW,
  ...extra });

/** Same rules as the SQL functions: one claim per order; only 'failed' is claimable again. */
function memoryStore({ eligible = true, nip = NIP, companyName = COMPANY, broken = false, amountMinor = 60000 } = {}) {
  const rows = new Map(); const finished = [];
  return { rows, finished, claims: [], async claim(id, companyId) {
    this.claims.push([id, companyId]);
    if (broken) throw new Error('relation does not exist');
    await Promise.resolve();
    if (!eligible) return { outcome: 'not_eligible' };
    const row = rows.get(id);
    if (!row) rows.set(id, { status: 'issuing', attempts: 1 });
    else if (row.status === 'failed') Object.assign(row, { status: 'issuing', attempts: row.attempts + 1, code: null });
    else return { outcome: row.status };
    return { outcome: 'claimed', companyName, nip, amountMinor };
  }, async finish(id, result) {
    const row = rows.get(id);
    assert.equal(row.status, 'issuing', 'finish only on a claimed row');
    finished.push(result);
    Object.assign(row, result.status === 'issued' ? { status: 'issued', invoiceId: result.invoiceId } : { status: result.status, code: result.code });
  } };
}

/** Fakturownia fake: honours oid_unique like the real API (422 on a repeated oid). */
function fakeFakturownia(respond) {
  const f = { calls: [], oids: new Set() };
  f.fetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    f.calls.push({ url, method: init.method, body });
    const custom = respond?.(f.calls.length, body);
    if (custom) return custom;
    const inv = body.invoice;
    if (inv.oid_unique === 'yes' && f.oids.has(inv.oid)) return { ok: false, status: 422, json: async () => ({ code: 'error' }) };
    f.oids.add(inv.oid);
    return { ok: true, status: 201, json: async () => ({ id: 1000 + f.oids.size, kind: inv.kind, status: 'paid',
      number: `FV ${f.oids.size}/11/2026`, oid: inv.oid, price_gross: inv.positions[0].total_price_gross, paid: inv.paid, currency: 'PLN' }) };
  };
  return f;
}

function deps(over = {}) {
  const logs = [];
  const store = over.store ?? memoryStore();
  const fak = over.fak ?? fakeFakturownia();
  const addressCalls = [];
  return { logs, store, fak, addressCalls, d: { env: over.env ?? ENV, fetch: fak.fetch, store, nowMs: () => NOW,
    billingAddress: over.billingAddress ?? (async o => { addressCalls.push(o.id); return ADDRESS; }),
    log: (level, code, orderId) => logs.push([level, code, orderId]) } };
}

const noBuyerData = logs => {
  const text = JSON.stringify(logs);
  for (const secret of [NIP, COMPANY, 'Testowa', '00-001', 'Warszawa', TOKEN, 'fakturownia.pl'])
    assert.ok(!text.includes(secret), `log must not contain ${secret}`);
};

test('live paid order → exactly one VAT invoice with the order amount, company name, NIP and address; nothing else', async () => {
  const { d, fak, store, logs } = deps();
  const r = await issueStripeVatInvoice(order(), d);
  assert.equal(r.state, 'issued');
  assert.equal(fak.calls.length, 1);
  const { url, method, body } = fak.calls[0];
  assert.equal(method, 'POST');
  assert.equal(url, 'https://ktig.fakturownia.pl/invoices.json', 'token never in the URL of a POST');
  const inv = body.invoice;
  assert.equal(inv.kind, 'vat');
  assert.equal(inv.oid, `sc19-paid:${ORDER_ID}`);
  assert.equal(inv.oid_unique, 'yes');
  assert.equal(inv.status, 'paid');
  assert.equal(inv.paid, '600.00');
  assert.equal(inv.positions.length, 1);
  assert.equal(inv.positions[0].total_price_gross, '600.00', 'amount from the order snapshot');
  assert.equal(inv.positions[0].tax, 23);
  assert.equal(inv.positions[0].name, 'SkillCheck PRESELEKCJA — 120 analiz CV');
  assert.equal(inv.buyer_name, COMPANY);
  assert.equal(inv.buyer_tax_no, NIP);
  assert.deepEqual([inv.buyer_street, inv.buyer_post_code, inv.buyer_city, inv.buyer_country], ['ul. Testowa 1', '00-001', 'Warszawa', 'PL']);
  assert.equal(inv.buyer_email, '', 'no e-mail: nothing is sent to the buyer from here');
  assert.equal(inv.issue_date, '2026-11-22', 'Warsaw calendar date');
  assert.equal(inv.sell_date, '2026-11-22');
  assert.match(inv.description, /pi_abcdefgh12/);
  // Only the documented invoice fields; no phone, person name or other personal data.
  assert.deepEqual(Object.keys(inv).filter(k => k.startsWith('buyer_')).sort(),
    ['buyer_city', 'buyer_company', 'buyer_country', 'buyer_email', 'buyer_name', 'buyer_post_code', 'buyer_street', 'buyer_tax_no']);
  assert.deepEqual(store.finished, [{ status: 'issued', invoiceId: 1001, invoiceNumber: 'FV 1/11/2026' }]);
  assert.deepEqual(logs, [['info', 'SC19_INVOICE_ISSUED', ORDER_ID]]);
  assert.deepEqual(store.claims, [[ORDER_ID, order().companyId]], 'claimed for the order and its company');
});

test('the order copy must carry the stored amount snapshot, otherwise no call', async () => {
  const { d, fak } = deps({ store: memoryStore({ amountMinor: 30000 }) });
  assert.deepEqual(await issueStripeVatInvoice(order(), d), { state: 'failed', code: 'SC19_INVOICE_AMOUNT_MISMATCH' });
  assert.equal(fak.calls.length, 0);
});

test('test-mode, unpaid or foreign orders → no claim, no Fakturownia call, no log', async () => {
  for (const o of [order({ scope: { provider: 'stripe', account: 'ktig-consulting', mode: 'test' } }),
    order({ status: 'awaiting_payment', paymentId: null }), order({ status: 'expired' }),
    order({ scope: { provider: 'przelewy24', account: 'ktig-consulting', mode: 'live' } }),
    order({ scope: { provider: 'stripe', account: 'other', mode: 'live' } })]) {
    const { d, fak, store, logs, addressCalls } = deps();
    assert.equal((await issueStripeVatInvoice(o, d)).state, 'skipped');
    assert.equal(fak.calls.length, 0); assert.equal(store.rows.size, 0); assert.deepEqual(logs, []); assert.deepEqual(addressCalls, []);
  }
});

test('missing or invalid Fakturownia configuration → no call; recorded as failed with a code, no personal data logged', async () => {
  for (const [env, code] of [[{}, 'FAKTUROWNIA_NOT_CONFIGURED'], [{ FAKTUROWNIA_ACCOUNT: 'ktig' }, 'FAKTUROWNIA_CONFIG_INVALID'],
    [{ FAKTUROWNIA_ACCOUNT: 'bad host!', FAKTUROWNIA_API_TOKEN: TOKEN }, 'FAKTUROWNIA_CONFIG_INVALID']]) {
    const { d, fak, store, logs } = deps({ env });
    const r = await issueStripeVatInvoice(order(), d);
    assert.deepEqual(r, { state: 'failed', code });
    assert.equal(fak.calls.length, 0);
    assert.equal(store.rows.get(ORDER_ID).status, 'failed');
    assert.deepEqual(logs, [['error', code, ORDER_ID]]);
    noBuyerData(logs);
  }
});

test('webhook retry and concurrent deliveries → one claim, one Fakturownia call, one invoice', async () => {
  const { d, fak, store } = deps();
  const results = await Promise.all([issueStripeVatInvoice(order(), d), issueStripeVatInvoice(order(), d), issueStripeVatInvoice(order(), d)]);
  assert.deepEqual(results.map(r => r.state).sort(), ['issued', 'not_claimed', 'not_claimed']);
  assert.deepEqual(await issueStripeVatInvoice(order(), d), { state: 'not_claimed', code: 'issued' });
  assert.equal(fak.calls.length, 1);
  assert.equal(store.finished.length, 1);
});

test('an outcome that may have created an invoice (timeout, 5xx, 422, bad answer) is "check" and never retried automatically', async () => {
  const cases = [
    [() => { throw new TypeError(`fetch failed https://ktig.fakturownia.pl/invoices.json?api_token=${TOKEN}`); }, 'FAKTUROWNIA_UNAVAILABLE'],
    [() => ({ ok: false, status: 502, json: async () => ({}) }), 'FAKTUROWNIA_UNAVAILABLE'],
    [() => ({ ok: false, status: 422, json: async () => ({}) }), 'FAKTUROWNIA_REQUEST_REJECTED'],
    [() => ({ ok: true, status: 201, json: async () => ({ id: 5, kind: 'vat', status: 'paid', oid: 'sc19-paid:other', price_gross: '600.00' }) }), 'FAKTUROWNIA_RESPONSE_INVALID'],
  ];
  for (const [respond, code] of cases) {
    const fak = fakeFakturownia(respond);
    const { d, store, logs } = deps({ fak });
    assert.deepEqual(await issueStripeVatInvoice(order(), d), { state: 'check', code });
    assert.equal(store.rows.get(ORDER_ID).status, 'check');
    assert.deepEqual(await issueStripeVatInvoice(order(), d), { state: 'not_claimed', code: 'check' });
    assert.equal(fak.calls.length, 1, code);
    noBuyerData(logs);
  }
});

test('an outcome that certainly created nothing (401, 429) is "failed" and a later claim issues exactly one invoice', async () => {
  let first = true;
  const fak = fakeFakturownia(() => { if (first) { first = false; return { ok: false, status: 429, json: async () => ({}) }; } return null; });
  const { d, store } = deps({ fak });
  assert.deepEqual(await issueStripeVatInvoice(order(), d), { state: 'failed', code: 'FAKTUROWNIA_RATE_LIMITED' });
  assert.equal((await issueStripeVatInvoice(order(), d)).state, 'issued');
  assert.equal((await issueStripeVatInvoice(order(), d)).state, 'not_claimed');
  assert.equal(store.rows.get(ORDER_ID).attempts, 2);
  assert.equal(fak.oids.size, 1, 'one invoice');
});

test('oid_unique: a repeated call for the same order is refused by Fakturownia, never a second document', async () => {
  const fak = fakeFakturownia();
  // Two independent records (e.g. a lost finish): the third layer, oid_unique, still holds.
  assert.equal((await issueStripeVatInvoice(order(), deps({ fak }).d)).state, 'issued');
  assert.deepEqual(await issueStripeVatInvoice(order(), deps({ fak }).d), { state: 'check', code: 'FAKTUROWNIA_REQUEST_REJECTED' });
  assert.equal(fak.oids.size, 1);
});

test('no invoice record (pre-migration database or database down) → no Fakturownia call', async () => {
  const { d, fak, logs } = deps({ store: memoryStore({ broken: true }) });
  assert.deepEqual(await issueStripeVatInvoice(order(), d), { state: 'store_unavailable' });
  assert.equal(fak.calls.length, 0);
  assert.deepEqual(logs, [['error', 'SC19_INVOICE_STORE_UNAVAILABLE', ORDER_ID]]);
});

test('not eligible in the database (not a paid live order) → no call', async () => {
  const { d, fak } = deps({ store: memoryStore({ eligible: false }) });
  assert.deepEqual(await issueStripeVatInvoice(order(), d), { state: 'not_claimed', code: 'not_eligible' });
  assert.equal(fak.calls.length, 0);
});

test('no NIP, no address or a foreign address → failed with a code, no call', async () => {
  const cases = [
    [{ store: memoryStore({ nip: null }) }, 'SC19_INVOICE_NIP_MISSING'],
    [{ billingAddress: async () => { throw new Error('stripe down'); } }, 'SC19_INVOICE_ADDRESS_UNAVAILABLE'],
    [{ billingAddress: async () => ({ ...ADDRESS, country: 'DE' }) }, 'SC19_INVOICE_ADDRESS_FOREIGN'],
  ];
  for (const [over, code] of cases) {
    const { d, fak, logs } = deps(over);
    assert.deepEqual(await issueStripeVatInvoice(order(), d), { state: 'failed', code });
    assert.equal(fak.calls.length, 0);
    noBuyerData(logs);
  }
});

test('a failing record write never throws; the row stays "issuing" (operator checks it)', async () => {
  const store = memoryStore();
  store.finish = async () => { throw new Error('db down'); };
  const { d, logs } = deps({ store });
  assert.equal((await issueStripeVatInvoice(order(), d)).state, 'issued');
  assert.equal(store.rows.get(ORDER_ID).status, 'issuing');
  assert.deepEqual(logs.map(l => l[1]), ['SC19_INVOICE_RECORD_FAILED', 'SC19_INVOICE_ISSUED']);
});

test('item names and dates', () => {
  assert.equal(invoiceItemName({ credits: 60 }), 'SkillCheck PRESELEKCJA — 60 analiz CV');
  assert.equal(invoiceItemName({ packageCode: 'ASSESSMENT_CENTER', credits: 50 }), 'SkillCheck ASSESSMENT CENTER — 50 analiz CV');
  assert.equal(invoiceItemName({ packageCode: 'WERYFIKACJA', credits: 100 }), 'SkillCheck WERYFIKACJA — 100 analiz CV');
  assert.equal(warsawDate(Date.parse('2026-11-21T22:59:59Z')), '2026-11-21');
  assert.equal(warsawDate(Date.parse('2026-11-21T23:00:00Z')), '2026-11-22');
});

test('vatInvoiceStore maps the SQL functions and refuses unknown answers', async () => {
  const calls = [];
  let answer = [{ outcome: 'claimed', company_name: COMPANY, nip: NIP, amount_minor: 60000 }];
  const store = vatInvoiceStore(async (sql, values) => { calls.push([sql, values]); return answer; });
  assert.deepEqual(await store.claim(ORDER_ID, 'c1'), { outcome: 'claimed', companyName: COMPANY, nip: NIP, amountMinor: 60000 });
  assert.deepEqual(calls[0][1], [ORDER_ID, 'c1']);
  answer = [{ outcome: 'issued', company_name: null, nip: null }];
  assert.deepEqual(await store.claim(ORDER_ID), { outcome: 'issued' });
  answer = [{ outcome: 'something' }];
  await assert.rejects(store.claim(ORDER_ID));
  answer = [];
  await assert.rejects(store.claim(ORDER_ID));
  await store.finish(ORDER_ID, { status: 'issued', invoiceId: 7, invoiceNumber: 'FV 1' });
  await store.finish(ORDER_ID, { status: 'check', code: 'FAKTUROWNIA_TIMEOUT' });
  assert.deepEqual(calls.slice(-2).map(c => c[1]), [[ORDER_ID, 'issued', 7, 'FV 1', null], [ORDER_ID, 'check', null, null, 'FAKTUROWNIA_TIMEOUT']]);
  assert.match(calls[0][0], /sc19_stripe\.claim_vat_invoice\(\$1,\$2\)/);
  assert.match(calls.at(-1)[0], /sc19_stripe\.finish_vat_invoice\(\$1,\$2,\$3,\$4,\$5\)/);
});
