// R7: operator list of LIVE Stripe invoices / corrections that were not issued.
// Offline: the database is an in-memory fake answering the three reads. No network,
// no real database, no Stripe or Fakturownia call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REVIEW_STALE_MS, needsReview, readInvoicesToReview } from '../lib/sc19-stripe-invoice-review.ts';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = ms => new Date(ms).toISOString();

/** A fake database: `installed` = migration 20261122090000, `dates` = 20261122110000. */
function fakeDb({ installed = true, dates = true, invoices = [], corrections = [] } = {}) {
  const sqls = [];
  const query = async (sql, values) => {
    sqls.push(sql);
    if (sql.includes('to_regclass')) return [{ ok: installed }];
    if (sql.includes('information_schema.columns')) return [{ n: installed && dates ? 4 : 0 }];
    assert.ok(installed, 'no data read on a database without the tables');
    assert.equal(sql.includes('first_attempt_at, i.last_attempt_at') || sql.includes('c.first_attempt_at'), dates);
    const [limit, staleBefore] = values;
    const cut = Date.parse(staleBefore);
    const keep = (r, open) => r.status === 'failed' || (open.includes(r.status) && Date.parse(r.changed_at) < cut);
    const time = r => dates ? { first_attempt_at: r.first_attempt_at ?? null, last_attempt_at: r.last_attempt_at ?? null }
      : { first_attempt_at: null, last_attempt_at: null };
    const rows = [
      ...invoices.filter(r => keep(r, ['new', 'pending'])).map(r => ({ kind: 'invoice', order_id: r.order_id, payment_id: r.payment_id,
        refunded_total: null, status: r.status, error_code: r.error_code ?? null, attempts: r.attempts ?? 0, changed_at: r.changed_at, ...time(r) })),
      ...corrections.filter(r => keep(r, ['pending'])).map(r => ({ kind: 'correction', order_id: r.order_id,
        payment_id: invoices.find(i => i.order_id === r.order_id)?.payment_id, refunded_total: r.refunded_total, status: r.status,
        error_code: r.error_code ?? null, attempts: r.attempts ?? 0, changed_at: r.changed_at, ...time(r) })),
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
    assert.doesNotMatch(s, /invoice_buyer|company_name|\bnip\b|email|fetch\(/i);
  }
  const page = readFileSync(new URL('../app/operator/fakturownia/page.tsx', import.meta.url), 'utf8');
  // Operator gate before any read, and the required Polish messages.
  assert.ok(page.indexOf('await salesOperator()') < page.indexOf('loadInvoicesToReview()'));
  for (const text of ['Faktury do sprawdzenia: ', 'Brak faktur do sprawdzenia', 'Funkcja faktur na żywo nie jest jeszcze włączona w bazie'])
    assert.ok(page.includes(text), text);
});
