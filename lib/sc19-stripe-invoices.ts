/** R7: Fakturownia VAT invoice after a LIVE Stripe payment, correction invoice after
 * a refund (owner decision 20.11.2026, 18:29, point 5, docs/DECYZJE.md).
 *
 * Called from the single post-grant call site (lib/sc19-stripe-runtime.ts,
 * afterStripePayment) and from the charge.refunded webhook. Never grants, never
 * revokes and never changes a package or a CV pool: it only issues documents and
 * records them in sc19_stripe.invoices / invoice_corrections / refunds
 * (migration 20261122090000_r7_stripe_live_invoices.sql).
 *
 * Exactly one VAT invoice per payment: a database claim with a lease (one caller at
 * a time) AND Fakturownia's `oid_unique` (a lost response is recovered by finding the
 * document with the same oid, never by issuing a second one). One correction per
 * cumulative refunded total, in the same way.
 *
 * Retry: an attempt that fails returns 'retry'; the webhook then answers 503 and
 * Stripe redelivers the same event (up to 3 days), which reaches this code again.
 * No new cron, no new workflow.
 *
 * Only LIVE orders get documents: a TEST payment is not a sale. A payment from the
 * seller's own NIP (KTIG Consulting control purchase) gets the package but no
 * invoice and no correction.
 *
 * Logs carry fixed codes only: never a token, a URL, a buyer's name, NIP, address
 * or e-mail, nor a Fakturownia or Stripe response body.
 */
import type { PaymentMode, PaymentOrder } from './sc19-payments.ts';
import { Sc19PaymentError, orderPackage } from './sc19-payments.ts';
import { STRIPE_CATALOG } from './stripe-catalog.ts';
import { FakturowniaError, createFakturowniaClient, parseSignedMinor, readFakturowniaConfig, type FakturowniaClient, type FakturowniaFetch, type FakturowniaInvoice } from './fakturownia-client.ts';

type RefundEvent = Readonly<{ paymentIntentId: string; orderId: string; refundedTotal: number }>;

/** NIP of the seller (KTIG Consulting Sp. z o.o.). A payment from the same company is
 * a control purchase, not a sale: no invoice, no correction (no „KTIG for KTIG” document in KSeF). */
export const SELLER_NIP = '7394002294';
const DAY = 86_400_000;
const LEASE_MS = 120_000;
const warsawDate = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date(ms));

/** Stripe payment method → Fakturownia „sposób płatności”. Apple Pay, Google Pay and Link are card payments in Stripe. */
export function fakturowniaPaymentType(method: string | null): string {
  if (method === 'blik') return 'BLIK';
  if (method === 'p24') return 'Przelewy24';
  if (!method || ['card', 'apple_pay', 'google_pay', 'link'].includes(method)) return 'card';
  return 'Stripe';
}
const METHOD_LABEL: Record<string, string> = { card: 'karta', apple_pay: 'Apple Pay', google_pay: 'Google Pay',
  link: 'Link', blik: 'BLIK', p24: 'Przelewy24' };
export const paymentMethodLabel = (method: string | null) => method ? (METHOD_LABEL[method] ?? 'płatność online') : 'płatność online';

/** Whole packages on the invoice (PRESELEKCJA: credits / 60; a one-package order: 1). */
export function invoicePackages(order: PaymentOrder): number {
  const pkg = STRIPE_CATALOG[orderPackage(order)];
  const n = order.credits / pkg.cvCredits;
  return orderPackage(order) === 'PRESELEKCJA' && Number.isSafeInteger(n) && n >= 1 ? n : 1;
}
/** Invoice position: the package and its CV pool. */
export function invoiceItemName(order: PaymentOrder): string {
  const pkg = STRIPE_CATALOG[orderPackage(order)];
  const n = invoicePackages(order);
  return n > 1 ? `SkillCheck ${pkg.name} — pakiet ${pkg.cvCredits} analiz CV (${n} pakiety, pula ${order.credits} analiz CV)`
    : `SkillCheck ${pkg.name} — pakiet ${order.credits} analiz CV`;
}

/** What Stripe confirms about the payment (read from the API by the provider). */
export type StripePaymentFacts = Readonly<{
  paymentIntentId: string; amountMinor: number; paidAtMs: number; method: string | null;
  email: string; address: Readonly<{ street: string; postCode: string; city: string }>;
}>;
export type InvoiceRowState = 'issued' | 'skipped' | 'busy';
/** When the application tried to issue a document (migration 20261122110000); null =
 * unknown (an older row, or a database without the columns). */
export type AttemptWindow = Readonly<{ firstAttemptMs: number | null; lastAttemptMs: number | null }>;
export type InvoiceStore = Readonly<{
  /** False on a database without migration 20261122090000: then nothing is issued or recorded. */
  installed(): Promise<boolean>;
  /** Company name and NIP from registration, for a PAID LIVE order only. */
  buyer(orderId: string): Promise<{ name: string; nip: string | null } | null>;
  /** Atomic claim of the order's invoice: the attempt number, or why not. */
  claim(order: PaymentOrder, nowMs: number, leaseMs: number): Promise<number | InvoiceRowState>;
  skip(orderId: string, code: string, nowMs: number): Promise<void>;
  issued(orderId: string, invoice: FakturowniaInvoice, method: string | null, nowMs: number): Promise<void>;
  failed(orderId: string, code: string, nowMs: number): Promise<void>;
  /** The order's invoice row (null = none). */
  invoice(orderId: string): Promise<{ status: string; fakturowniaId: number | null } | null>;
  /** The PAID LIVE Stripe order holding this PaymentIntent, or null. */
  orderByPayment(paymentIntentId: string): Promise<PaymentOrder | null>;
  /** True while the LIVE Stripe order with this id exists and is still awaiting its
   * payment settlement (the refund event came before the payment was applied). */
  awaitingSettlement(orderId: string): Promise<boolean>;
  /** Records the cumulative refunded total (never lower than before); returns the stored total. */
  recordRefund(order: PaymentOrder, refundedTotal: number, nowMs: number): Promise<number>;
  /** One correction attempt per order at a time: the lease on the order's refund row.
   * Returns the stored cumulative refunded total, or 'busy'. */
  leaseCorrection(orderId: string, nowMs: number, leaseMs: number): Promise<number | 'busy'>;
  releaseCorrection(orderId: string): Promise<void>;
  corrections(orderId: string): Promise<Array<{ refundedTotal: number; status: string } & AttemptWindow>>;
  /** First and last attempt times of the order's invoice (both null when unknown). */
  invoiceWindow(orderId: string): Promise<AttemptWindow>;
  /** Insert-if-absent of the correction row for this total; its attempt number, or 'issued'. */
  startCorrection(orderId: string, refundedTotal: number, nowMs: number): Promise<number | 'issued'>;
  correctionIssued(orderId: string, refundedTotal: number, invoice: FakturowniaInvoice, nowMs: number): Promise<void>;
  correctionFailed(orderId: string, refundedTotal: number, code: string, nowMs: number): Promise<void>;
}>;
export type InvoiceDeps = Readonly<{
  /** null = Fakturownia not configured: nothing is issued (and LIVE checkout is closed). */
  fakturownia: FakturowniaClient | null;
  store: InvoiceStore;
  /** Stripe's own word about the payment of a PAID order (read only). */
  paymentFacts(order: PaymentOrder): Promise<StripePaymentFacts>;
  now?: () => number;
}>;
export type InvoiceOutcome = 'disabled' | 'not_applicable' | 'skipped' | 'issued' | 'already_issued' | 'retry';

class InvoiceWait extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
const codeOf = (e: unknown) => e instanceof FakturowniaError || e instanceof InvoiceWait ? e.code : 'INVOICE_INTERNAL';

/** A rejected create may mean „this oid already exists” after a lost response:
 * find that one document; never issue a second. The search covers only the days the
 * application tried to issue it (first attempt day −1 to last attempt day +1; Codex P2
 * on #594), not the account's whole history since the payment. Without recorded
 * attempt times it falls back to the payment date … now. */
function searchWindow(window: AttemptWindow | null, paidAtMs: number, nowMs: number) {
  return { fromMs: window?.firstAttemptMs ?? paidAtMs, toMs: window?.lastAttemptMs ?? nowMs };
}
async function findByOid(client: FakturowniaClient, oid: string, window: { fromMs: number; toMs: number }) {
  const from = warsawDate(window.fromMs - DAY), to = warsawDate(window.toMs + DAY);
  const matches: FakturowniaInvoice[] = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await client.invoicesIssuedBetween(from, to, page);
    matches.push(...batch.filter(i => i.oid === oid));
    if (batch.length < 100) {
      if (matches.length > 1) throw new InvoiceWait('FAKTUROWNIA_DUPLICATE_INVOICE');
      return matches[0] ?? null;
    }
  }
  throw new InvoiceWait('FAKTUROWNIA_LOOKUP_INCOMPLETE');
}
const liveStripe = (o: PaymentOrder) => o.scope.provider === 'stripe' && o.scope.mode === 'live' && o.status === 'paid' &&
  orderPackage(o) === 'PRESELEKCJA' && typeof o.paymentId === 'string' && /^pi_[A-Za-z0-9]{6,64}$/.test(o.paymentId);

function buyerOf(registration: { name: string; nip: string }, facts: StripePaymentFacts) {
  return { name: registration.name, nip: registration.nip, email: facts.email, ...facts.address };
}
function checkFacts(order: PaymentOrder, facts: StripePaymentFacts) {
  if (facts.paymentIntentId !== order.paymentId || facts.amountMinor !== order.amountMinor || !Number.isSafeInteger(facts.paidAtMs))
    throw new InvoiceWait('STRIPE_PAYMENT_MISMATCH');
  if (!facts.address.street || !facts.address.postCode || !facts.address.city || !facts.email)
    throw new InvoiceWait('INVOICE_BUYER_INCOMPLETE');
}

/** The VAT invoice of one paid order. Idempotent; safe to call on every delivery. */
export async function issueOrderInvoice(order: PaymentOrder, deps: InvoiceDeps): Promise<InvoiceOutcome> {
  if (!liveStripe(order)) return 'not_applicable';
  const now = (deps.now ?? Date.now)();
  if (!(await deps.store.installed())) return 'disabled';
  const registration = await deps.store.buyer(order.id);
  if (!registration) return 'retry';
  if (registration.nip === SELLER_NIP) {
    const state = await deps.store.claim(order, now, LEASE_MS);
    if (state === 'issued') return 'already_issued';
    if (state === 'skipped') return 'skipped';
    if (state === 'busy') return 'retry';
    await deps.store.skip(order.id, 'SELLER_CONTROL_PURCHASE', now);
    return 'skipped';
  }
  // A paid LIVE sale whose Fakturownia configuration is missing or broken (removed
  // after the sale): ask Stripe to deliver again, so the invoice is issued once the
  // configuration is back, instead of acknowledging it for good (Codex P2 on #594).
  const client = deps.fakturownia;
  if (!client) { console.error('SC19_STRIPE_INVOICE_FAILED', 'FAKTUROWNIA_NOT_CONFIGURED'); return 'retry'; }
  const attempt = await deps.store.claim(order, now, LEASE_MS);
  if (attempt === 'issued') return 'already_issued';
  if (attempt === 'skipped') return 'skipped';
  if (attempt === 'busy') return 'retry';
  let method: string | null = null;
  try {
    if (!registration.nip || !/^\d{10}$/.test(registration.nip)) throw new InvoiceWait('INVOICE_BUYER_INCOMPLETE');
    const facts = await deps.paymentFacts(order);
    checkFacts(order, facts);
    method = facts.method;
    const oid = `core:${order.id}`;
    let invoice: FakturowniaInvoice;
    try {
      invoice = await client.createStripeInvoice({ oid, grossMinor: order.amountMinor, itemName: invoiceItemName(order),
        quantity: invoicePackages(order), paymentType: fakturowniaPaymentType(method), paymentLabel: paymentMethodLabel(method),
        issueDate: warsawDate(now), paidDate: warsawDate(facts.paidAtMs), paymentReference: facts.paymentIntentId,
        buyer: buyerOf({ name: registration.name, nip: registration.nip }, facts) });
    } catch (e) {
      if (!(e instanceof FakturowniaError) || e.code !== 'FAKTUROWNIA_REQUEST_REJECTED') throw e;
      const existing = await findByOid(client, oid, searchWindow(await deps.store.invoiceWindow(order.id), facts.paidAtMs, now));
      if (!existing) throw e;
      if (existing.kind !== 'vat' || parseSignedMinor(existing.priceGross) !== order.amountMinor)
        throw new FakturowniaError('FAKTUROWNIA_RESPONSE_INVALID');
      invoice = existing;
    }
    await deps.store.issued(order.id, invoice, method, now);
    return 'issued';
  } catch (e) {
    const code = codeOf(e);
    console.error('SC19_STRIPE_INVOICE_FAILED', code, attempt);
    try { await deps.store.failed(order.id, code, now); } catch { /* the lease expires by itself */ }
    return 'retry';
  }
}

/** A refund Stripe reported for a PAID LIVE order: record the cumulative total and
 * issue one correction for it. Never changes the package or the CV pool. */
export async function handleRefund(refund: RefundEvent,
  deps: InvoiceDeps): Promise<InvoiceOutcome | 'ignored'> {
  const { paymentIntentId, orderId, refundedTotal } = refund;
  if (!(await deps.store.installed())) return 'disabled';
  const order = await deps.store.orderByPayment(paymentIntentId);
  // The payment of a verified order of ours is not settled yet (the refund event came
  // first): ask Stripe to deliver again instead of losing the refund (Codex P2, PR #591).
  if (!order) return (await deps.store.awaitingSettlement(orderId)) ? 'retry' : 'ignored';
  if (order.id !== orderId || !liveStripe(order)) return 'ignored';
  if (!Number.isSafeInteger(refundedTotal) || refundedTotal <= 0 || refundedTotal > order.amountMinor) return 'ignored';
  const now = (deps.now ?? Date.now)();
  await deps.store.recordRefund(order, refundedTotal, now);
  // Without a Fakturownia configuration the invoice step answers 'retry' (or 'skipped'
  // for the seller's own purchase), so the refund is redelivered, not lost.
  // The original invoice first (it may still be waiting for a retry).
  const original = await issueOrderInvoice(order, deps);
  if (original === 'skipped') return 'skipped';
  if (original !== 'issued' && original !== 'already_issued') return original === 'disabled' ? 'disabled' : 'retry';
  return issueCorrection(order, deps, now);
}

/** Under the order's correction lease: one correction from the last corrected state
 * to the CURRENT cumulative refunded total (a later, larger refund supersedes an
 * earlier one that was not corrected yet, so documents never overlap). */
async function issueCorrection(order: PaymentOrder, deps: InvoiceDeps, now: number): Promise<InvoiceOutcome> {
  const client = deps.fakturownia;
  if (!client) return 'retry';
  const original = await deps.store.invoice(order.id);
  if (!original || original.status === 'skipped') return 'skipped';
  const leased = await deps.store.leaseCorrection(order.id, now, LEASE_MS);
  if (leased === 'busy') return 'retry';
  const refundedTotal = leased;
  let attempt: number | 'issued' = 0;
  try {
    if (original.status !== 'issued' || !original.fakturowniaId) throw new InvoiceWait('INVOICE_NOT_ISSUED');
    const facts = await deps.paymentFacts(order);
    checkFacts(order, facts);
    // Codex P1 (PR #591): a correction attempt whose outcome is unknown (lost response,
    // failed record) may exist in Fakturownia. Under the order's lease, look every such
    // attempt up by its oid and record it before computing the next document, so a
    // larger refund never corrects the same amount twice.
    let rows = await deps.store.corrections(order.id);
    for (const r of rows.filter(x => x.status !== 'issued')) {
      const found = await findByOid(client, `core-korekta:${order.id}:${r.refundedTotal}`, searchWindow(r, facts.paidAtMs, now));
      if (!found) continue;
      if (found.kind !== 'correction' || (parseSignedMinor(found.priceGross) ?? 0) >= 0)
        throw new FakturowniaError('FAKTUROWNIA_RESPONSE_INVALID');
      await deps.store.correctionIssued(order.id, r.refundedTotal, found, now);
    }
    rows = await deps.store.corrections(order.id);
    if (rows.some(r => r.status === 'issued' && r.refundedTotal >= refundedTotal)) return 'already_issued';
    attempt = await deps.store.startCorrection(order.id, refundedTotal, now);
    if (attempt === 'issued') return 'already_issued';
    const previous = Math.max(0, ...rows.filter(r => r.status === 'issued').map(r => r.refundedTotal));
    const registration = await deps.store.buyer(order.id);
    if (!registration?.nip || registration.nip === SELLER_NIP) throw new InvoiceWait('INVOICE_BUYER_INCOMPLETE');
    const before = order.amountMinor - previous, after = order.amountMinor - refundedTotal;
    const oid = `core-korekta:${order.id}:${refundedTotal}`;
    let invoice: FakturowniaInvoice;
    try {
      invoice = await client.createCorrection({ oid, originalId: original.fakturowniaId, itemName: invoiceItemName(order),
        quantity: invoicePackages(order), beforeGrossMinor: before, afterGrossMinor: after, issueDate: warsawDate(now),
        paymentType: fakturowniaPaymentType(facts.method), paymentReference: facts.paymentIntentId,
        reason: after === 0 ? 'Zwrot całej płatności' : 'Częściowy zwrot płatności',
        buyer: buyerOf({ name: registration.name, nip: registration.nip }, facts) });
    } catch (e) {
      if (!(e instanceof FakturowniaError) || e.code !== 'FAKTUROWNIA_REQUEST_REJECTED') throw e;
      const current = (await deps.store.corrections(order.id)).find(r => r.refundedTotal === refundedTotal) ?? null;
      const existing = await findByOid(client, oid, searchWindow(current, facts.paidAtMs, now));
      if (!existing) throw e;
      if (existing.kind !== 'correction' || parseSignedMinor(existing.priceGross) !== after - before)
        throw new FakturowniaError('FAKTUROWNIA_RESPONSE_INVALID');
      invoice = existing;
    }
    await deps.store.correctionIssued(order.id, refundedTotal, invoice, now);
    return 'issued';
  } catch (e) {
    const code = codeOf(e);
    console.error('SC19_STRIPE_CORRECTION_FAILED', code, attempt);
    if (typeof attempt === 'number' && attempt > 0)
      try { await deps.store.correctionFailed(order.id, refundedTotal, code, now); } catch { /* retried on redelivery */ }
    return 'retry';
  } finally {
    try { await deps.store.releaseCorrection(order.id); } catch { /* the lease expires by itself */ }
  }
}

// ---------------------------------------------------------------- runtime glue
/** The Fakturownia client from FAKTUROWNIA_ACCOUNT / FAKTUROWNIA_API_TOKEN, or null
 * when they are missing or malformed (then no invoice is issued and LIVE checkout
 * stays closed). Values are never logged or returned. */
export function stripeInvoiceClient(env: Record<string, string | undefined>, fetchImpl: FakturowniaFetch = fetch) {
  try { return createFakturowniaClient(readFakturowniaConfig(env), fetchImpl); } catch { return null; }
}

/** LIVE checkout opens only on the production deployment (the configuration gate
 * already refuses a live key on Preview), with a live key and a working Fakturownia
 * configuration, so no real sale happens without its invoice. New checkouts still
 * need the sales switch SC19_PACKAGES_ENABLED=true. */
export const stripeLiveApproved = (config: Readonly<{ mode: PaymentMode; deployment: 'preview' | 'production' }>, invoicesConfigured: boolean) =>
  config.mode === 'live' && config.deployment === 'production' && invoicesConfigured;

/** THE post-grant call site. Runs after the package is granted and committed: the
 * Fakturownia VAT invoice of a LIVE payment (lib/sc19-stripe-invoices.ts). It never
 * undoes the grant. 'retry' = not issued yet: the webhook answers 503 and Stripe
 * delivers the event again. */
export async function afterStripePayment(order: PaymentOrder, deps: InvoiceDeps): Promise<void | 'retry'> {
  try { return await issueOrderInvoice(order, deps) === 'retry' ? 'retry' : undefined; }
  catch { console.error('SC19_STRIPE_INVOICE_FAILED', 'INVOICE_INTERNAL'); return 'retry'; }
}

/** charge.refunded: record the refund and issue the correction invoice. The package
 * and the CV pool are not changed here (the operator corrects a pool by hand). */
export async function stripeRefundEvent(verify: () => Promise<RefundEvent | 'ignored' | null>, deps: InvoiceDeps) {
  const refund = await verify();
  if (refund === null) return null;
  if (refund === 'ignored') return { state: 'ignored' };
  let outcome: Awaited<ReturnType<typeof handleRefund>>;
  try { outcome = await handleRefund(refund, deps); }
  catch { console.error('SC19_STRIPE_REFUND_FAILED'); outcome = 'retry'; }
  if (outcome === 'retry') throw new Sc19PaymentError('SC19_PAYMENT_RETRY');
  return { state: `refund_${outcome}` };
}

type Query = (sql: string, values: unknown[]) => Promise<Record<string, unknown>[]>;
const iso = (ms: number) => new Date(ms).toISOString();
/** The invoice store on the payment adapter's restricted login (sc19_p24_checkout /
 * sc19_p24_preview), never a service key. `toOrder` maps an order row. */
export function postgresInvoiceStore(query: Query, toOrder: (row: Record<string, unknown>) => PaymentOrder): InvoiceStore {
  let ready: Promise<boolean> | undefined;
  // Attempt-time columns (migration 20261122110000); without them nothing is recorded.
  let dates: Promise<boolean> | undefined;
  const hasDates = () => (dates ??= query(`select count(*)::int as n from information_schema.columns
    where table_schema='sc19_stripe' and table_name in ('invoices','invoice_corrections') and column_name='first_attempt_at'`, [])
    .then(r => Number(r[0]?.n) === 2));
  const windowOf = (r: Record<string, unknown> | undefined): AttemptWindow => ({
    firstAttemptMs: r?.first_attempt_at ? new Date(String(r.first_attempt_at)).getTime() : null,
    lastAttemptMs: r?.last_attempt_at ? new Date(String(r.last_attempt_at)).getTime() : null });
  const claimRow = async (key: string, values: unknown[], nowMs: number, leaseMs: number) => {
    const rows = await query(`update sc19_stripe.invoices set status='pending', attempts=attempts+1,
      lease_until=$${values.length + 1}::timestamptz + make_interval(secs => $${values.length + 2}::double precision / 1000),
      changed_at=$${values.length + 1}::timestamptz
      where ${key} and (status in ('new','failed') or (status='pending' and lease_until < $${values.length + 1}::timestamptz))
      returning attempts`, [...values, iso(nowMs), leaseMs]);
    if (rows[0]) return Number(rows[0].attempts);
    const state = await query(`select status from sc19_stripe.invoices where ${key}`, values);
    const status = String(state[0]?.status ?? '');
    return status === 'issued' ? 'issued' as const : status === 'skipped' ? 'skipped' as const : 'busy' as const;
  };
  return Object.freeze({
    installed: () => (ready ??= query("select to_regclass('sc19_stripe.invoices') is not null as ok", [])
      .then(r => r[0]?.ok === true)),
    async buyer(orderId) {
      const rows = await query('select company_name, nip from sc19_stripe.invoice_buyer($1)', [orderId]);
      if (!rows[0] || typeof rows[0].company_name !== 'string') return null;
      return { name: rows[0].company_name, nip: typeof rows[0].nip === 'string' ? rows[0].nip : null };
    },
    async claim(order, nowMs, leaseMs) {
      await query(`insert into sc19_stripe.invoices(order_id, company_id, payment_id, mode) values ($1,$2,$3,'live')
        on conflict (order_id) do nothing`, [order.id, order.companyId, order.paymentId]);
      const attempt = await claimRow('order_id=$1', [order.id], nowMs, leaseMs);
      // Recorded under the lease and BEFORE Fakturownia is called.
      if (typeof attempt === 'number' && await hasDates())
        await query(`update sc19_stripe.invoices set first_attempt_at=coalesce(first_attempt_at,$2), last_attempt_at=$2
          where order_id=$1 and status='pending'`, [order.id, iso(nowMs)]);
      return attempt;
    },
    async invoiceWindow(orderId) {
      if (!(await hasDates())) return windowOf(undefined);
      const rows = await query('select first_attempt_at, last_attempt_at from sc19_stripe.invoices where order_id=$1', [orderId]);
      return windowOf(rows[0]);
    },
    async skip(orderId, code, nowMs) {
      await query(`update sc19_stripe.invoices set status='skipped', error_code=$2, lease_until=null, changed_at=$3
        where order_id=$1 and status<>'issued'`, [orderId, code, iso(nowMs)]);
    },
    async issued(orderId, invoice, method, nowMs) {
      await query(`update sc19_stripe.invoices set status='issued', fakturownia_id=$2, number=$3, payment_method=$4,
        error_code=null, lease_until=null, issued_at=$5, changed_at=$5 where order_id=$1`,
      [orderId, invoice.id, invoice.number, method && /^[a-z0-9_]{1,40}$/.test(method) ? method : null, iso(nowMs)]);
    },
    async failed(orderId, code, nowMs) {
      await query(`update sc19_stripe.invoices set status='failed', error_code=$2, lease_until=null, changed_at=$3
        where order_id=$1 and status='pending'`, [orderId, code, iso(nowMs)]);
    },
    async invoice(orderId) {
      const rows = await query('select status, fakturownia_id from sc19_stripe.invoices where order_id=$1', [orderId]);
      if (!rows[0]) return null;
      return { status: String(rows[0].status), fakturowniaId: rows[0].fakturownia_id === null ? null : Number(rows[0].fakturownia_id) };
    },
    async orderByPayment(paymentIntentId) {
      const rows = await query(`select * from private.sc19_payment_orders where payment_id=$1 and provider='stripe'
        and account='ktig-consulting' and mode='live' and status='paid'`, [paymentIntentId]);
      return rows.length === 1 ? toOrder(rows[0]) : null;
    },
    async awaitingSettlement(orderId) {
      const rows = await query(`select 1 from private.sc19_payment_orders where id=$1 and provider='stripe'
        and account='ktig-consulting' and mode='live' and status='awaiting_payment'
        and checkout_url is distinct from 'sc19:expired'`, [orderId]);
      return rows.length === 1;
    },
    async recordRefund(order, refundedTotal, nowMs) {
      const rows = await query(`insert into sc19_stripe.refunds(order_id, company_id, payment_id, refunded_total, updated_at)
        values ($1,$2,$3,$4,$5) on conflict (order_id) do update
        set refunded_total=greatest(sc19_stripe.refunds.refunded_total, excluded.refunded_total), updated_at=excluded.updated_at
        returning refunded_total`, [order.id, order.companyId, order.paymentId, refundedTotal, iso(nowMs)]);
      return Number(rows[0]?.refunded_total ?? refundedTotal);
    },
    async leaseCorrection(orderId, nowMs, leaseMs) {
      // One row per order; a concurrent caller blocks on it and re-checks the lease.
      const rows = await query(`update sc19_stripe.refunds set lease_until=$2::timestamptz + make_interval(secs => $3::double precision / 1000)
        where order_id=$1 and (lease_until is null or lease_until < $2::timestamptz) returning refunded_total`,
      [orderId, iso(nowMs), leaseMs]);
      return rows[0] ? Number(rows[0].refunded_total) : 'busy';
    },
    async releaseCorrection(orderId) {
      await query('update sc19_stripe.refunds set lease_until=null where order_id=$1', [orderId]);
    },
    async corrections(orderId) {
      const rows = await query(`select refunded_total, status${await hasDates() ? ', first_attempt_at, last_attempt_at' : ''}
        from sc19_stripe.invoice_corrections where order_id=$1`, [orderId]);
      return rows.map(r => ({ refundedTotal: Number(r.refunded_total), status: String(r.status), ...windowOf(r) }));
    },
    async startCorrection(orderId, refundedTotal, nowMs) {
      await query(`insert into sc19_stripe.invoice_corrections(order_id, refunded_total, changed_at) values ($1,$2,$3)
        on conflict (order_id, refunded_total) do nothing`, [orderId, refundedTotal, iso(nowMs)]);
      const rows = await query(`update sc19_stripe.invoice_corrections set status='pending', attempts=attempts+1, changed_at=$3
        where order_id=$1 and refunded_total=$2 and status<>'issued' returning attempts`, [orderId, refundedTotal, iso(nowMs)]);
      if (rows[0] && await hasDates())
        await query(`update sc19_stripe.invoice_corrections set first_attempt_at=coalesce(first_attempt_at,$3), last_attempt_at=$3
          where order_id=$1 and refunded_total=$2 and status='pending'`, [orderId, refundedTotal, iso(nowMs)]);
      return rows[0] ? Number(rows[0].attempts) : 'issued';
    },
    async correctionIssued(orderId, refundedTotal, invoice, nowMs) {
      await query(`update sc19_stripe.invoice_corrections set status='issued', fakturownia_id=$3, number=$4, error_code=null,
        issued_at=$5, changed_at=$5 where order_id=$1 and refunded_total=$2`,
      [orderId, refundedTotal, invoice.id, invoice.number, iso(nowMs)]);
    },
    async correctionFailed(orderId, refundedTotal, code, nowMs) {
      await query(`update sc19_stripe.invoice_corrections set status='failed', error_code=$3, changed_at=$4
        where order_id=$1 and refunded_total=$2 and status='pending'`, [orderId, refundedTotal, code, iso(nowMs)]);
    },
  });
}
