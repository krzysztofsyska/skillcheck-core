/** R7: the Fakturownia VAT invoice after a confirmed LIVE Stripe payment.
 *
 * Called from the post-grant hook (lib/sc19-stripe-runtime.ts afterStripePayment),
 * which runs once per payment, after the package grant has committed. Nothing here
 * can undo or block that grant: every failure is caught, recorded by a fixed code
 * and logged with the order id only (no buyer data, no URL, no token).
 *
 * Rules (owner decision 20.11.2026, point 5, docs/DECYZJE.md):
 *  - only orders of the KTIG Stripe account in mode 'live' that are 'paid'. A TEST
 *    order never reaches Fakturownia: a VAT invoice goes to KSeF and cannot be undone;
 *  - Fakturownia invoices automatically when FAKTUROWNIA_ACCOUNT and
 *    FAKTUROWNIA_API_TOKEN are present; there is no other switch;
 *  - exactly one invoice per order, in three layers:
 *      1. the hook itself runs only for the delivery that applied the grant;
 *      2. sc19_stripe.claim_vat_invoice() (migration 20261122000000) records the order
 *         as 'issuing' BEFORE the call; a second or concurrent call gets no claim;
 *      3. Fakturownia `oid` = 'sc19-paid:<order id>' with `oid_unique`, so even a
 *         repeated call with the same order cannot create a second document;
 *  - an outcome that might have created an invoice (timeout, 5xx, rejected request,
 *    unreadable answer) is recorded as 'check' and is NEVER retried automatically;
 *    only an outcome that certainly created nothing is 'failed' (re-claimable);
 *  - amounts come from the order snapshot (order.amountMinor, checked against the
 *    stored order by the claim), never recomputed;
 *  - a later verified delivery of an already paid order (Stripe redelivery or a
 *    resend; PaymentDependencies.onPaidAgain) runs this again: only a 'failed'
 *    record is claimed again, so it retries a transient failure and nothing else;
 *  - the invoice carries only company name and NIP (database), billing address
 *    (from the paid Checkout Session), item name and amount. No e-mail: nothing is
 *    sent to the buyer from here.
 */
import { createFakturowniaClient, FakturowniaError, readFakturowniaConfig,
  type FakturowniaErrorCode, type FakturowniaFetch } from './fakturownia-client.ts';
import { orderPackage, type PaymentOrder } from './sc19-payments.ts';
import { STRIPE_CATALOG } from './stripe-catalog.ts';
import type { StripeBillingAddress } from './sc19-stripe-provider.ts';

export type VatInvoiceClaim =
  | Readonly<{ outcome: 'claimed'; companyName: string; nip: string | null; amountMinor: number | null }>
  | Readonly<{ outcome: 'not_eligible' | 'issuing' | 'issued' | 'failed' | 'check' }>;
export type VatInvoiceFinish =
  | Readonly<{ status: 'issued'; invoiceId: number; invoiceNumber: string | null }>
  | Readonly<{ status: 'failed' | 'check'; code: string }>;
/** Backed by sc19_stripe.claim_vat_invoice / finish_vat_invoice on the adapter role. */
export type VatInvoiceStore = Readonly<{
  claim(orderId: string, companyId: string): Promise<VatInvoiceClaim>;
  finish(orderId: string, result: VatInvoiceFinish): Promise<void>;
}>;
export type StripeInvoiceDeps = Readonly<{
  env: Record<string, string | undefined>;
  fetch: FakturowniaFetch;
  store: VatInvoiceStore;
  billingAddress(order: PaymentOrder): Promise<StripeBillingAddress>;
  nowMs?: () => number;
  log?: (level: 'info' | 'error', code: string, orderId: string) => void;
}>;
export type StripeInvoiceResult = Readonly<{
  state: 'skipped' | 'not_claimed' | 'issued' | 'failed' | 'check' | 'store_unavailable';
  code?: string;
}>;

/** Errors after which Fakturownia certainly created no document: safe to retry. */
const NOTHING_CREATED: ReadonlySet<FakturowniaErrorCode> = new Set<FakturowniaErrorCode>([
  'FAKTUROWNIA_NOT_CONFIGURED', 'FAKTUROWNIA_CONFIG_INVALID', 'FAKTUROWNIA_UNAUTHORIZED',
  'FAKTUROWNIA_ACCOUNT_NOT_FOUND', 'FAKTUROWNIA_RATE_LIMITED',
]);

const defaultLog = (level: 'info' | 'error', code: string, orderId: string) =>
  (level === 'error' ? console.error : console.info)(code, orderId);

/** Calendar date in Warsaw, YYYY-MM-DD (issue, sale and payment date of the invoice). */
export function warsawDate(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ms));
}

/** Item name from the catalog name and the order's own CV count (no price logic). */
export function invoiceItemName(order: Pick<PaymentOrder, 'packageCode' | 'credits'>): string {
  return `SkillCheck ${STRIPE_CATALOG[orderPackage(order)].name} — ${order.credits} analiz CV`;
}

export async function issueStripeVatInvoice(order: PaymentOrder, deps: StripeInvoiceDeps): Promise<StripeInvoiceResult> {
  const log = deps.log ?? defaultLog;
  // 1. Live, paid, Stripe KTIG only. A test order is silently skipped: no call, no record.
  if (!order || order.scope?.provider !== 'stripe' || order.scope.account !== 'ktig-consulting' ||
      order.scope.mode !== 'live' || order.status !== 'paid' || !order.paymentId)
    return { state: 'skipped' };

  // 2. Claim before any call. Without the record (pre-migration database or DB down)
  //    there is no invoice: the exactly-once guarantee comes first.
  let claim: VatInvoiceClaim;
  try { claim = await deps.store.claim(order.id, order.companyId); }
  catch { log('error', 'SC19_INVOICE_STORE_UNAVAILABLE', order.id); return { state: 'store_unavailable' }; }
  if (claim.outcome !== 'claimed') return { state: 'not_claimed', code: claim.outcome };

  const finish = async (result: VatInvoiceFinish): Promise<StripeInvoiceResult> => {
    try { await deps.store.finish(order.id, result); }
    // The row stays 'issuing', which the operator treats like 'check'.
    catch { log('error', 'SC19_INVOICE_RECORD_FAILED', order.id); }
    if (result.status === 'issued') { log('info', 'SC19_INVOICE_ISSUED', order.id); return { state: 'issued' }; }
    log('error', result.code, order.id);
    return { state: result.status, code: result.code };
  };

  // 3. Configuration: missing or invalid keys → no call at all, recorded as failed.
  let config;
  try { config = readFakturowniaConfig(deps.env); }
  catch (e) {
    return finish({ status: 'failed', code: e instanceof FakturowniaError ? e.code : 'FAKTUROWNIA_CONFIG_INVALID' });
  }
  // 4. Buyer data. B2B only: no NIP → no automatic invoice.
  if (!claim.nip || !/^[0-9]{10}$/.test(claim.nip)) return finish({ status: 'failed', code: 'SC19_INVOICE_NIP_MISSING' });
  if (!claim.companyName.trim()) return finish({ status: 'failed', code: 'SC19_INVOICE_BUYER_MISSING' });
  // The amount is the stored order snapshot; the copy in hand must agree with it.
  if (claim.amountMinor !== order.amountMinor) return finish({ status: 'failed', code: 'SC19_INVOICE_AMOUNT_MISMATCH' });
  let address: StripeBillingAddress;
  try { address = await deps.billingAddress(order); }
  catch { return finish({ status: 'failed', code: 'SC19_INVOICE_ADDRESS_UNAVAILABLE' }); }
  // A foreign address needs a different VAT treatment: left to the operator.
  if (address.country !== 'PL') return finish({ status: 'failed', code: 'SC19_INVOICE_ADDRESS_FOREIGN' });

  // 5. The one call. Amount from the order snapshot.
  const date = warsawDate((deps.nowMs ?? Date.now)());
  try {
    const client = createFakturowniaClient(config, deps.fetch);
    const created = await client.createPaidInvoice({
      oid: `sc19-paid:${order.id}`, grossMinor: order.amountMinor, itemName: invoiceItemName(order),
      issueDate: date, paymentReference: order.paymentId,
      buyer: { name: claim.companyName.trim(), nip: claim.nip, street: address.street, postCode: address.postCode,
        city: address.city, email: '' },
    });
    return finish({ status: 'issued', invoiceId: created.id, invoiceNumber: created.number });
  } catch (e) {
    const code = e instanceof FakturowniaError ? e.code : 'SC19_INVOICE_UNEXPECTED';
    return finish({ status: e instanceof FakturowniaError && NOTHING_CREATED.has(e.code) ? 'failed' : 'check', code });
  }
}

/** sc19_stripe.claim_vat_invoice / finish_vat_invoice (migration 20261122000000). */
export function vatInvoiceStore(query: (sql: string, values: unknown[]) => Promise<Record<string, unknown>[]>): VatInvoiceStore {
  return {
    async claim(orderId, companyId) {
      const rows = await query('select outcome, company_name, nip, amount_minor from sc19_stripe.claim_vat_invoice($1,$2)', [orderId, companyId]);
      const row = rows[0];
      if (!row || typeof row.outcome !== 'string') throw new Error('SC19_INVOICE_STORE_INVALID');
      if (row.outcome === 'claimed') return { outcome: 'claimed',
        companyName: typeof row.company_name === 'string' ? row.company_name : '', nip: typeof row.nip === 'string' ? row.nip : null,
        amountMinor: Number.isSafeInteger(row.amount_minor) ? row.amount_minor as number : null };
      if (['not_eligible', 'issuing', 'issued', 'failed', 'check'].includes(row.outcome))
        return { outcome: row.outcome as 'not_eligible' | 'issuing' | 'issued' | 'failed' | 'check' };
      throw new Error('SC19_INVOICE_STORE_INVALID');
    },
    async finish(orderId, result) {
      await query('select sc19_stripe.finish_vat_invoice($1,$2,$3,$4,$5) as ok', result.status === 'issued'
        ? [orderId, 'issued', result.invoiceId, result.invoiceNumber, null]
        : [orderId, result.status, null, null, result.code]);
    },
  };
}
