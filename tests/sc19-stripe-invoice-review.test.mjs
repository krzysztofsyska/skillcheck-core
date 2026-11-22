// R7: operator list of LIVE Stripe invoices / corrections that were not issued.
// Offline: the database is an in-memory fake answering the three reads. No network,
// no real database, no Stripe or Fakturownia call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REVIEW_STALE_MS, needsReview, readInvoicesToReview } from '../lib/sc19-stripe-invoice-review.ts';
import { SELLER_NIP } from '../lib/sc19-stripe-invoices.ts';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = ms => new Date(ms).toISOString();

/** A fake database: `installed` = migration 20261122090000, `dates` = 20261122110000.
 * `orders` = private.sc19_payment_orders rows, `grants` = { order_id: receipt time },
 * `buyers` = { order_id: nip } (what sc19_stripe.invoice_buyer would return),
 * `refunds` = sc19_stripe.refunds rows. */
function fakeDb({ installed = true, dates = true, invoices = [], corrections = [], orders = [], grants = {}, buyers = {}, refunds = [] } = {}) {
  const sqls = [];
  const query = async (sql, values) => {
    sqls.push(sql);
    if (sql.includes('to_regclass')) return [{ ok: installed }];
    if (sql.includes('information_schema.columns')) return [{ n: installed && dates ? 4 : 0 }];
    assert.ok(installed, 'no data read on a database without the tables');
    assert.equal(sql.includes('first_attempt_at, i.last_attempt_at') || sql.includes('c.first_attempt_at'), dates);
    // The fake answers only the query it models: the clauses it honours must be in the SQL.
    const flat = sql.replace(/\s+/g, ' ');
    for (const clause of [
      "not exists (select 1 from sc19_stripe.invoice_corrections x where x.order_id=c.order_id and x.status='issued' and x.refunded_total >= c.refunded_total)",
      "where o.provider='stripe' and o.account='ktig-consulting' and o.mode='live' and o.status='paid'",
      'not exists (select 1 from sc19_stripe.invoices n where n.order_id=o.id)',
      'not exists (select 1 from sc19_stripe.invoice_buyer(o.id) b where b.nip = $3::text)',
      'coalesce((select g.created_at from private.sc19_payment_grants g where g.order_id=o.id), o.created_at) as changed_at',
      'where m.changed_at < $2::timestamptz',
      "from sc19_stripe.refunds r join private.sc19_payment_orders o on o.id=r.order_id where o.provider='stripe' and o.account='ktig-consulting' and o.mode='live' and r.updated_at < $2::timestamptz",
      "and exists (select 1 from sc19_stripe.invoices v where v.order_id=r.order_id and v.status<>'skipped')",
      "and not exists (select 1 from sc19_stripe.invoice_corrections y where y.order_id=r.order_id and y.refunded_total >= r.refunded_total and y.status in ('issued','pending','failed'))",
      'and not exists (select 1 from sc19_stripe.invoice_buyer(r.order_id) b where b.nip = $3::text)',
    ]) assert.ok(flat.includes(clause), clause);
    const [limit, staleBefore, sellerNip] = values;
    assert.equal(sellerNip, SELLER_NIP);
    const cut = Date.parse(staleBefore);
    const keep = (r, open) => r.status === 'failed' || (open.includes(r.status) && Date.parse(r.changed_at) < cut);
    const time = r => dates ? { first_attempt_at: r.first_attempt_at ?? null, last_attempt_at: r.last_attempt_at ?? null }
      : { first_attempt_at: null, last_attempt_at: null };
    const rows = [
      ...invoices.filter(r => keep(r, ['new', 'pending'])).map(r => ({ kind: 'invoice', order_id: r.order_id, payment_id: r.payment_id,
        refunded_total: null, status: r.status, error_code: r.error_code ?? null, attempts: r.attempts ?? 0, changed_at: r.changed_at, ...time(r) })),
      ...corrections.filter(r => keep(r, ['pending']) && !corrections.some(x => x.order_id === r.order_id
        && x.status === 'issued' && x.refunded_total >= r.refunded_total)).map(r => ({ kind: 'correction', order_id: r.order_id,
        payment_id: invoices.find(i => i.order_id === r.order_id)?.payment_id, refunded_total: r.refunded_total, status: r.status,
        error_code: r.error_code ?? null, attempts: r.attempts ?? 0, changed_at: r.changed_at, ...time(r) })),
      ...orders.filter(o => o.provider === 'stripe' && o.account === 'ktig-consulting' && o.mode === 'live' && o.status === 'paid'
        && !invoices.some(i => i.order_id === o.id) && buyers[o.id] !== sellerNip)
        .map(o => ({ kind: 'missing', order_id: o.id, payment_id: o.payment_id, refunded_total: null, status: 'missing', error_code: null,
          attempts: 0, changed_at: grants[o.id] ?? o.created_at, first_attempt_at: null, last_attempt_at: null }))
        .filter(r => Date.parse(r.changed_at) < cut),
      ...refunds.filter(r => {
        const o = orders.find(x => x.id === r.order_id);
        return o && o.provider === 'stripe' && o.account === 'ktig-consulting' && o.mode === 'live' && Date.parse(r.updated_at) < cut
          && invoices.some(i => i.order_id === r.order_id && i.status !== 'skipped')
          && !corrections.some(y => y.order_id === r.order_id && y.refunded_total >= r.refunded_total && ['issued', 'pending', 'failed'].includes(y.status))
          && buyers[r.order_id] !== sellerNip;
      }).map(r => ({ kind: 'refund', order_id: r.order_id, payment_id: r.payment_id, refunded_total: r.refunded_total, status: 'uncorrected',
        error_code: null, attempts: 0, changed_at: r.updated_at, first_attempt_at: null, last_attempt_at: null })),
    ].sort((a, b) => Date.parse(a.changed_at) - Date.parse(b.changed_at));
    return rows.slice(0, limit);
  };
  return { query, sqls };
}

const invoice = (n, status, ageMs, extra = {}) => ({ order_id: id(n), payment_id: `pi_fakeintent${n}`, status,
  changed_at: at(NOW - ageMs), ...extra });

test('failed listed, issued and skipped not listed, stale pending/new listed, fresh pending not listed', async () => {
  const db = fakeDb({
    invoices: [
      invoice(1, 'failed', 60_000, { error_code: 'FAKTUROWNIA_TIMEOUT', attempts: 3,
        first_attempt_at: at(NOW - 3 * REVIEW_STALE_MS), last_attempt_at: at(NOW - 60_000) }),
      invoice(2, 'issued', 5 * REVIEW_STALE_MS),
      invoice(3, 'pending', 2 * REVIEW_STALE_MS, { attempts: 1 }),
      invoice(4, 'pending', 5 * 60_000, { attempts: 1 }),
      invoice(5, 'new', 2 * REVIEW_STALE_MS),
      invoice(6, 'skipped', 9 * REVIEW_STALE_MS, { error_code: 'SELLER_CONTROL_PURCHASE' }),
    ],
    corrections: [
      { order_id: id(2), refunded_total: 30000, status: 'failed', error_code: 'INVOICE_NOT_ISSUED', attempts: 2, changed_at: at(NOW - 120_000) },
      { order_id: id(2), refunded_total: 10000, status: 'issued', changed_at: at(NOW - 9 * REVIEW_STALE_MS) },
      { order_id: id(1), refunded_total: 5000, status: 'pending', changed_at: at(NOW - 60_000) },
    ],
  });
  const review = await readInvoicesToReview(db.query, NOW);
  assert.equal(review.state, 'ok');
  assert.equal(review.truncated, false);
  const listed = review.items.map(i => `${i.kind}:${i.orderId.slice(-1)}:${i.status}`);
  assert.deepEqual(listed.sort(), ['correction:2:failed', 'invoice:1:failed', 'invoice:3:pending', 'invoice:5:new'].sort());
  assert.equal(review.total, 4);
  const failed = review.items.find(i => i.kind === 'invoice' && i.orderId === id(1));
  assert.deepEqual({ ...failed }, { kind: 'invoice', orderId: id(1), paymentId: 'pi_fakeintent1', status: 'failed', refundedTotalMinor: null,
    errorCode: 'FAKTUROWNIA_TIMEOUT', attempts: 3, changedAtMs: NOW - 60_000, firstAttemptMs: NOW - 3 * REVIEW_STALE_MS, lastAttemptMs: NOW - 60_000 });
  const correction = review.items.find(i => i.kind === 'correction');
  assert.equal(correction.paymentId, 'pi_fakeintent2');
  assert.equal(correction.refundedTotalMinor, 30000);
  assert.equal(correction.errorCode, 'INVOICE_NOT_ISSUED');
  // Oldest first.
  assert.deepEqual(review.items.map(i => i.changedAtMs), [...review.items.map(i => i.changedAtMs)].sort((a, b) => a - b));
});

const order = (n, ageMs, extra = {}) => ({ id: id(n), payment_id: `pi_fakeintent${n}`, provider: 'stripe', account: 'ktig-consulting',
  mode: 'live', status: 'paid', created_at: at(NOW - ageMs), ...extra });

test('a paid LIVE order with no invoice row is listed as missing; control purchase, invoiced, fresh and TEST orders are not', async () => {
  const db = fakeDb({
    invoices: [invoice(13, 'issued', 5 * REVIEW_STALE_MS), invoice(14, 'failed', 60_000, { attempts: 2 })],
    orders: [
      order(11, 3 * REVIEW_STALE_MS),                       // listed: paid 3 h ago (receipt), no invoice row
      order(12, 3 * REVIEW_STALE_MS),                       // seller's own control purchase: never invoiced
      order(13, 6 * REVIEW_STALE_MS),                       // has an issued invoice row
      order(14, 6 * REVIEW_STALE_MS),                       // has a failed invoice row: listed once, as the invoice
      order(15, 2 * REVIEW_STALE_MS),                       // order created 2 h ago, but paid 10 minutes ago
      order(16, 9 * REVIEW_STALE_MS, { mode: 'test' }),     // TEST
      order(17, 9 * REVIEW_STALE_MS, { status: 'awaiting_payment', payment_id: null }),
      order(18, 4 * REVIEW_STALE_MS),                       // no receipt row: the order time is used; no buyer row
    ],
    grants: { [id(11)]: at(NOW - 2 * REVIEW_STALE_MS), [id(15)]: at(NOW - 600_000) },
    buyers: { [id(11)]: '1234563218', [id(12)]: SELLER_NIP, [id(13)]: '1234563218', [id(14)]: '1234563218', [id(15)]: '1234563218' },
  });
  const review = await readInvoicesToReview(db.query, NOW);
  const listed = review.items.map(i => `${i.kind}:${i.orderId.slice(-2)}:${i.status}`);
  assert.deepEqual(listed, ['missing:18:missing', 'missing:11:missing', 'invoice:14:failed']);
  const missing = review.items.find(i => i.orderId === id(11));
  assert.deepEqual({ ...missing }, { kind: 'missing', orderId: id(11), paymentId: 'pi_fakeintent11', status: 'missing', refundedTotalMinor: null,
    errorCode: null, attempts: 0, changedAtMs: NOW - 2 * REVIEW_STALE_MS, firstAttemptMs: null, lastAttemptMs: null });
  assert.equal(needsReview({ status: 'missing', changedAtMs: NOW - 60_000 }, NOW), false);
});

test('a failed correction covered by an issued correction of the same order is not listed; a larger one still is', async () => {
  const db = fakeDb({
    invoices: [invoice(21, 'issued', 9 * REVIEW_STALE_MS), invoice(22, 'issued', 9 * REVIEW_STALE_MS)],
    corrections: [
      { order_id: id(21), refunded_total: 10000, status: 'failed', error_code: 'FAKTUROWNIA_TIMEOUT', attempts: 1, changed_at: at(NOW - 2 * REVIEW_STALE_MS) },
      { order_id: id(21), refunded_total: 20000, status: 'pending', attempts: 1, changed_at: at(NOW - 3 * REVIEW_STALE_MS) },
      { order_id: id(21), refunded_total: 25000, status: 'issued', changed_at: at(NOW - REVIEW_STALE_MS) },
      { order_id: id(22), refunded_total: 30000, status: 'failed', error_code: 'FAKTUROWNIA_TIMEOUT', attempts: 2, changed_at: at(NOW - 60_000) },
      { order_id: id(22), refunded_total: 15000, status: 'issued', changed_at: at(NOW - 5 * REVIEW_STALE_MS) },
    ],
  });
  const review = await readInvoicesToReview(db.query, NOW);
  assert.deepEqual(review.items.map(i => `${i.kind}:${i.orderId.slice(-2)}:${i.refundedTotalMinor}`), ['correction:22:30000']);
});

test('a LIVE refund with no correction started is listed; covered, in-flight, control, fresh and TEST refunds are not', async () => {
  const refund = (n, total, ageMs) => ({ order_id: id(n), payment_id: `pi_fakeintent${n}`, refunded_total: total, updated_at: at(NOW - ageMs) });
  const db = fakeDb({
    invoices: [31, 32, 33, 34, 35, 36, 37].map(n => invoice(n, 'issued', 9 * REVIEW_STALE_MS)).concat([invoice(38, 'skipped', 9 * REVIEW_STALE_MS)]),
    orders: [31, 32, 33, 34, 35, 36, 38, 39].map(n => order(n, 9 * REVIEW_STALE_MS)).concat([order(37, 9 * REVIEW_STALE_MS, { mode: 'test' })]),
    grants: Object.fromEntries([31, 32, 33, 34, 35, 36, 37, 38, 39].map(n => [id(n), at(NOW - 8 * REVIEW_STALE_MS)])),
    buyers: Object.fromEntries([31, 32, 33, 34, 35, 36, 37, 38, 39].map(n => [id(n), n === 33 ? SELLER_NIP : '1234563218'])),
    corrections: [
      { order_id: id(32), refunded_total: 20000, status: 'issued', changed_at: at(NOW - 3 * REVIEW_STALE_MS) },
      { order_id: id(35), refunded_total: 20000, status: 'failed', error_code: 'FAKTUROWNIA_TIMEOUT', attempts: 1, changed_at: at(NOW - 2 * REVIEW_STALE_MS) },
      { order_id: id(36), refunded_total: 5000, status: 'issued', changed_at: at(NOW - 5 * REVIEW_STALE_MS) },
    ],
    refunds: [
      refund(31, 10000, 2 * REVIEW_STALE_MS),   // listed: Stripe read failed, no correction row
      refund(32, 20000, 4 * REVIEW_STALE_MS),   // covered by the issued correction
      refund(33, 10000, 4 * REVIEW_STALE_MS),   // seller's control purchase
      refund(34, 10000, 10 * 60_000),           // fresh: the attempt may still be running
      refund(35, 20000, 4 * REVIEW_STALE_MS),   // its failed correction row is listed instead (no double listing)
      refund(36, 15000, 3 * REVIEW_STALE_MS),   // listed: an issued correction covers only 5000
      refund(37, 10000, 4 * REVIEW_STALE_MS),   // TEST order
      refund(38, 10000, 4 * REVIEW_STALE_MS),   // invoice skipped
      refund(39, 10000, 4 * REVIEW_STALE_MS),   // no invoice row: listed as 'missing' only
    ],
  });
  const review = await readInvoicesToReview(db.query, NOW);
  assert.deepEqual(review.items.map(i => `${i.kind}:${i.orderId.slice(-2)}:${i.status}`),
    ['missing:39:missing', 'refund:36:uncorrected', 'correction:35:failed', 'refund:31:uncorrected']);
  const listed = review.items.find(i => i.orderId === id(31));
  assert.deepEqual({ ...listed }, { kind: 'refund', orderId: id(31), paymentId: 'pi_fakeintent31', status: 'uncorrected', refundedTotalMinor: 10000,
    errorCode: null, attempts: 0, changedAtMs: NOW - 2 * REVIEW_STALE_MS, firstAttemptMs: null, lastAttemptMs: null });
  assert.equal(needsReview({ status: 'uncorrected', changedAtMs: NOW - 60_000 }, NOW), false);
  assert.equal(needsReview({ status: 'uncorrected', changedAtMs: NOW - REVIEW_STALE_MS - 1 }, NOW), true);
});

test('the JS check agrees with the SQL filter (a row the database returns is still re-checked)', () => {
  assert.equal(needsReview({ status: 'failed', changedAtMs: NOW }, NOW), true);
  assert.equal(needsReview({ status: 'pending', changedAtMs: NOW - REVIEW_STALE_MS - 1 }, NOW), true);
  assert.equal(needsReview({ status: 'new', changedAtMs: NOW - REVIEW_STALE_MS - 1 }, NOW), true);
  assert.equal(needsReview({ status: 'pending', changedAtMs: NOW - 60_000 }, NOW), false);
  assert.equal(needsReview({ status: 'pending', changedAtMs: Number.NaN }, NOW), false);
  assert.equal(needsReview({ status: 'issued', changedAtMs: NOW - 9 * REVIEW_STALE_MS }, NOW), false);
  assert.equal(needsReview({ status: 'skipped', changedAtMs: NOW - 9 * REVIEW_STALE_MS }, NOW), false);
});

test('empty: nothing to review', async () => {
  const review = await readInvoicesToReview(fakeDb({ invoices: [invoice(2, 'issued', REVIEW_STALE_MS * 3)] }).query, NOW);
  assert.deepEqual(review, { state: 'ok', items: [], total: 0, truncated: false });
});

test('pre-migration: without the invoice tables nothing is read and the page says the feature is off', async () => {
  const db = fakeDb({ installed: false });
  assert.deepEqual(await readInvoicesToReview(db.query, NOW), { state: 'not_installed' });
  assert.equal(db.sqls.length, 1);
});

test('without the attempt-time migration the list still works with unknown attempt times', async () => {
  const db = fakeDb({ dates: false, invoices: [invoice(1, 'failed', 60_000, { first_attempt_at: at(NOW - 1) })] });
  const review = await readInvoicesToReview(db.query, NOW);
  assert.equal(review.total, 1);
  assert.equal(review.items[0].firstAttemptMs, null);
  assert.equal(review.items[0].lastAttemptMs, null);
});

test('reads named columns only: no select *, no buyer data, no writes, no network', () => {
  const code = f => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const src = code('../lib/sc19-stripe-invoice-review.ts');
  const runtime = code('../lib/sc19-stripe-invoice-review-runtime.ts');
  for (const s of [src, runtime]) {
    assert.doesNotMatch(s, /select\s+\*/i);
    assert.doesNotMatch(s, /\b(insert|update|delete)\s+(into\s+)?sc19_stripe/i);
    assert.doesNotMatch(s, /company_name|email|fetch\(/i);
  }
  // The buyer's NIP is only compared inside the database, never selected into the result.
  assert.doesNotMatch(runtime, /invoice_buyer|\bnip\b/i);
  const buyerUses = src.match(/[^\n]*(invoice_buyer|\bnip\b)[^\n]*/gi) ?? [];
  assert.deepEqual(buyerUses.map(l => l.trim()),
    ['and not exists (select 1 from sc19_stripe.invoice_buyer(o.id) b where b.nip = $3::text)) m',
      'and not exists (select 1 from sc19_stripe.invoice_buyer(r.order_id) b where b.nip = $3::text)']);
  const page = readFileSync(new URL('../app/operator/fakturownia/page.tsx', import.meta.url), 'utf8');
  // Operator gate before any read, and the required Polish messages.
  assert.ok(page.indexOf('await salesOperator()') < page.indexOf('loadInvoicesToReview()'));
  for (const text of ['Faktury do sprawdzenia: ', 'Brak faktur do sprawdzenia', 'Funkcja faktur na żywo nie jest jeszcze włączona w bazie',
    'Opłacone zamówienie bez faktury', 'Zwrot bez korekty', 'korekta nie została rozpoczęta — najpierw ponów zdarzenie w Stripe',
    'Najpierw wyślij zdarzenie ponownie z Stripe (Dashboard → Webhooks → zdarzenie → Resend)',
    'Dokument ręcznie w Fakturowni wystawiaj dopiero wtedy', 'gdy Stripe nadal ponawia zdarzenie', 'może zdublować fakturę lub korektę'])
    assert.ok(page.includes(text), text);
  // Old instruction to issue documents by hand straight away must not come back.
  assert.doesNotMatch(page, /wystaw\s+(ją\s+|go\s+|dokument\s+|fakturę\s+|korektę\s+)?ręcznie/i);
  assert.ok(!page.includes('wystaw ją ręcznie'));
});
