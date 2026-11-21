/** R7: LIVE Stripe invoices and correction invoices that were NOT issued and need the
 * operator (follow-up from the reviewer PASS on promotion #594). Stripe redelivers a
 * webhook answered with 503 for about 3 days only; after that a failed or stuck
 * document is silent, so the operator Fakturownia page lists it.
 *
 * READ ONLY. Named columns of sc19_stripe.invoices / invoice_corrections (migrations
 * 20261122090000 and 20261122110000), never `select *`, never a buyer's name, NIP,
 * address or e-mail: order id, Stripe payment id, kind, status, error code, attempts
 * and times. No call to Stripe or Fakturownia, no write, no send.
 *
 * Needs review: status 'failed', or 'new' / 'pending' not changed for over an hour
 * (an attempt holds its lease for 2 minutes, so such a row is not in flight).
 */
export const REVIEW_STALE_MS = 3_600_000;
/** Rows read at most (a healthy database has none to show). */
export const REVIEW_READ_LIMIT = 500;

export type InvoiceReviewItem = Readonly<{
  kind: 'invoice' | 'correction'; orderId: string; paymentId: string; status: string;
  /** Cumulative refunded total of a correction, in grosz (null for an invoice). */
  refundedTotalMinor: number | null; errorCode: string | null; attempts: number;
  changedAtMs: number; firstAttemptMs: number | null; lastAttemptMs: number | null;
}>;
export type InvoiceReview =
  | Readonly<{ state: 'not_installed' }>
  | Readonly<{ state: 'ok'; items: InvoiceReviewItem[]; total: number; truncated: boolean }>;

type Query = (sql: string, values: unknown[]) => Promise<Record<string, unknown>[]>;
const ms = (v: unknown) => v === null || v === undefined ? null : new Date(v instanceof Date ? v : String(v)).getTime();

/** True when this row is a document the operator must look at. */
export function needsReview(item: Pick<InvoiceReviewItem, 'status' | 'changedAtMs'>, nowMs: number): boolean {
  if (item.status === 'failed') return true;
  return (item.status === 'new' || item.status === 'pending') && Number.isFinite(item.changedAtMs) && nowMs - item.changedAtMs > REVIEW_STALE_MS;
}

function itemOf(r: Record<string, unknown>): InvoiceReviewItem {
  return {
    kind: r.kind === 'correction' ? 'correction' : 'invoice', orderId: String(r.order_id), paymentId: String(r.payment_id ?? ''),
    status: String(r.status), refundedTotalMinor: r.refunded_total === null || r.refunded_total === undefined ? null : Number(r.refunded_total),
    errorCode: typeof r.error_code === 'string' ? r.error_code : null, attempts: Number(r.attempts ?? 0),
    changedAtMs: ms(r.changed_at) ?? Number.NaN, firstAttemptMs: ms(r.first_attempt_at), lastAttemptMs: ms(r.last_attempt_at),
  };
}

/** Reads the documents to review on the payment adapter's restricted login. On a
 * database without migration 20261122090000: 'not_installed'. Without migration
 * 20261122110000 the attempt times are null. Errors are thrown to the caller. */
export async function readInvoicesToReview(query: Query, nowMs: number): Promise<InvoiceReview> {
  const tables = await query(`select to_regclass('sc19_stripe.invoices') is not null
    and to_regclass('sc19_stripe.invoice_corrections') is not null as ok`, []);
  if (tables[0]?.ok !== true) return { state: 'not_installed' };
  const window = await query(`select count(*)::int as n from information_schema.columns
    where table_schema='sc19_stripe' and table_name in ('invoices','invoice_corrections')
    and column_name in ('first_attempt_at','last_attempt_at')`, []);
  const dates = Number(window[0]?.n) === 4;
  const times = (t: string) => dates ? `, ${t}.first_attempt_at, ${t}.last_attempt_at` : ', null::timestamptz as first_attempt_at, null::timestamptz as last_attempt_at';
  const rows = await query(`select d.kind, d.order_id, d.payment_id, d.refunded_total, d.status, d.error_code,
      d.attempts, d.changed_at, d.first_attempt_at, d.last_attempt_at from (
      select 'invoice' as kind, i.order_id, i.payment_id, null::integer as refunded_total, i.status, i.error_code,
        i.attempts, i.changed_at${times('i')}
      from sc19_stripe.invoices i
      where i.status='failed' or (i.status in ('new','pending') and i.changed_at < $2::timestamptz)
      union all
      select 'correction' as kind, c.order_id, i.payment_id, c.refunded_total, c.status, c.error_code,
        c.attempts, c.changed_at${times('c')}
      from sc19_stripe.invoice_corrections c join sc19_stripe.invoices i on i.order_id=c.order_id
      where c.status='failed' or (c.status='pending' and c.changed_at < $2::timestamptz)
    ) d order by d.changed_at asc limit $1`, [REVIEW_READ_LIMIT, new Date(nowMs - REVIEW_STALE_MS).toISOString()]);
  const items = rows.map(itemOf).filter(i => needsReview(i, nowMs));
  return { state: 'ok', items, total: items.length, truncated: rows.length >= REVIEW_READ_LIMIT };
}
