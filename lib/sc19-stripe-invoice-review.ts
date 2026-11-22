/** R7: LIVE Stripe invoices and correction invoices that were NOT issued and need the
 * operator (follow-up from the reviewer PASS on promotion #594). Stripe redelivers a
 * webhook answered with 503 for about 3 days only; after that a failed or stuck
 * document is silent, so the operator Fakturownia page lists it.
 *
 * READ ONLY. Named columns of sc19_stripe.invoices / invoice_corrections (migrations
 * 20261122090000 and 20261122110000) and of private.sc19_payment_orders /
 * sc19_payment_grants, never `select *`, never a buyer's name, NIP, address or e-mail
 * in the result: order id, Stripe payment id, kind, status, error code, attempts and
 * times. No call to Stripe or Fakturownia, no write, no send.
 *
 * Needs review: status 'failed', or 'new' / 'pending' not changed for over an hour
 * (an attempt holds its lease for 2 minutes, so such a row is not in flight); a
 * correction only while no ISSUED correction of the same order covers its total
 * (Codex P2 on #597); and kind 'missing': a PAID LIVE Stripe order with no invoice
 * row at all, paid over an hour ago (issueOrderInvoice answered 'retry' before its
 * claim, e.g. no Fakturownia configuration or no buyer data; Codex P2 on #597). The
 * seller's own control purchase is never invoiced, so it is left out: its NIP is
 * compared inside the database through sc19_stripe.invoice_buyer and never returned.
 * Kind 'refund' (Codex P2 on #597): a LIVE refund recorded in sc19_stripe.refunds
 * whose total no correction row covers yet: handleRefund saved it, but the correction
 * never started (e.g. reading the payment from Stripe failed before startCorrection),
 * so invoice_corrections has no row. Listed when the refund was recorded over an hour
 * ago, no ISSUED correction covers its total and no pending or failed correction row
 * for that total or more exists (that row is listed itself or is in flight). Needs an
 * invoice row that is not 'skipped' (no row: the order is listed as 'missing'); the
 * control purchase is left out the same way as for 'missing'.
 * The paid time is the settlement receipt (private.sc19_payment_grants.created_at),
 * or the order's created_at when there is no receipt (the orders table has no paid
 * or updated time; created_at is never later than the payment).
 */
import { SELLER_NIP } from './sc19-stripe-invoices.ts';

export const REVIEW_STALE_MS = 3_600_000;
/** Rows read at most (a healthy database has none to show). */
export const REVIEW_READ_LIMIT = 500;

export type InvoiceReviewItem = Readonly<{
  /** 'missing': a paid LIVE order with no invoice row (status 'missing', attempts 0).
   * 'refund': a recorded LIVE refund with no correction started (status 'uncorrected', attempts 0). */
  kind: 'invoice' | 'correction' | 'missing' | 'refund'; orderId: string; paymentId: string; status: string;
  /** Cumulative refunded total of a correction or refund, in grosz (null for an invoice). */
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
  return ['new', 'pending', 'missing', 'uncorrected'].includes(item.status) && Number.isFinite(item.changedAtMs) && nowMs - item.changedAtMs > REVIEW_STALE_MS;
}

function itemOf(r: Record<string, unknown>): InvoiceReviewItem {
  return {
    kind: r.kind === 'correction' || r.kind === 'missing' || r.kind === 'refund' ? r.kind : 'invoice', orderId: String(r.order_id), paymentId: String(r.payment_id ?? ''),
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
      where (c.status='failed' or (c.status='pending' and c.changed_at < $2::timestamptz))
        and not exists (select 1 from sc19_stripe.invoice_corrections x where x.order_id=c.order_id
          and x.status='issued' and x.refunded_total >= c.refunded_total)
      union all
      select 'missing' as kind, m.order_id, m.payment_id, null::integer as refunded_total, 'missing' as status,
        null::text as error_code, 0 as attempts, m.changed_at,
        null::timestamptz as first_attempt_at, null::timestamptz as last_attempt_at
      from (select o.id as order_id, o.payment_id,
          coalesce((select g.created_at from private.sc19_payment_grants g where g.order_id=o.id), o.created_at) as changed_at
        from private.sc19_payment_orders o
        where o.provider='stripe' and o.account='ktig-consulting' and o.mode='live' and o.status='paid'
          and not exists (select 1 from sc19_stripe.invoices n where n.order_id=o.id)
          and not exists (select 1 from sc19_stripe.invoice_buyer(o.id) b where b.nip = $3::text)) m
      where m.changed_at < $2::timestamptz
      union all
      select 'refund' as kind, r.order_id, r.payment_id, r.refunded_total, 'uncorrected' as status,
        null::text as error_code, 0 as attempts, r.updated_at as changed_at,
        null::timestamptz as first_attempt_at, null::timestamptz as last_attempt_at
      from sc19_stripe.refunds r join private.sc19_payment_orders o on o.id=r.order_id
      where o.provider='stripe' and o.account='ktig-consulting' and o.mode='live' and r.updated_at < $2::timestamptz
        and exists (select 1 from sc19_stripe.invoices v where v.order_id=r.order_id and v.status<>'skipped')
        and not exists (select 1 from sc19_stripe.invoice_corrections y where y.order_id=r.order_id
          and y.refunded_total >= r.refunded_total and y.status in ('issued','pending','failed'))
        and not exists (select 1 from sc19_stripe.invoice_buyer(r.order_id) b where b.nip = $3::text)
    ) d order by d.changed_at asc limit $1`, [REVIEW_READ_LIMIT, new Date(nowMs - REVIEW_STALE_MS).toISOString(), SELLER_NIP]);
  const items = rows.map(itemOf).filter(i => needsReview(i, nowMs));
  return { state: 'ok', items, total: items.length, truncated: rows.length >= REVIEW_READ_LIMIT };
}
