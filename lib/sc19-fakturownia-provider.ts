/** SC-BILLING-INVOICE-001 (#165): Fakturownia proforma as an SC-019 PaymentProvider.
 *
 * Flow: SC-019 order → one proforma (oid = SC-019 checkout key, oid_unique) →
 * customer pays via the proforma's public page ("Zapłać online": BLIK / Szybki
 * Przelew) or the owner marks it paid → a trigger (Fakturownia webhook relay or
 * scheduled reconciliation) produces a short-lived HMAC-signed message →
 * verifyAndRetrieve re-reads the proforma from the API, which is the ONLY source
 * of payment truth → SC-019 grants the order's snapshotted credits exactly once.
 *
 * Not wired into resolveSc19PaymentRuntime: activation needs the SC-019 migration,
 * an approved offer and a separate owner decision.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { HostedCheckout, PaymentOrder, PaymentProvider, PaymentScope, VerifiedPayment } from './sc19-payments.ts';
import { FakturowniaError, parseMinor, type FakturowniaClient, type FakturowniaInvoice } from './fakturownia-client.ts';

export type InvoiceBuyer = Readonly<{ name: string; nip: string; street: string; postCode: string; city: string; email: string }>;
export type FakturowniaProviderDeps = Readonly<{
  client: FakturowniaClient;
  scope: PaymentScope;
  /** Verified buyer data for the order's company (NIP from SC-019 approval + MF white list). */
  buyer(order: PaymentOrder): Promise<InvoiceBuyer>;
  itemName(order: PaymentOrder): string;
  /** ≥32 random bytes, server-only; signs internal payment triggers. */
  triggerSecret: string;
  paymentDays?: number;
  now?: () => number;
}>;

const ORDER = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRIGGER_TTL_MS = 10 * 60_000;
const warsawDate = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date(ms));
const sessionOf = (invoice: FakturowniaInvoice) => `fv-${invoice.id}`;

export class FakturowniaProviderError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'FakturowniaProviderError'; this.code = code; }
}
const fail = (code: string): never => { throw new FakturowniaProviderError(code); };

/** Trigger = which proforma to re-check for which order. Carries no payment truth. */
export function signPaymentTrigger(secret: string, invoiceId: number, orderId: string, nowMs = Date.now()) {
  if (Buffer.byteLength(secret) < 32 || !Number.isSafeInteger(invoiceId) || invoiceId <= 0 || !ORDER.test(orderId))
    fail('FAKTUROWNIA_TRIGGER_INVALID');
  const body = new TextEncoder().encode(JSON.stringify({ v: 1, invoiceId, orderId: orderId.toLowerCase(), issuedAtMs: nowMs }));
  return { body, signature: createHmac('sha256', secret).update(body).digest('hex') };
}

export function createFakturowniaPaymentProvider(deps: FakturowniaProviderDeps): PaymentProvider {
  if (Buffer.byteLength(deps.triggerSecret) < 32) fail('FAKTUROWNIA_PROVIDER_CONFIG_INVALID');
  if (deps.scope.provider !== 'fakturownia') fail('FAKTUROWNIA_PROVIDER_CONFIG_INVALID');
  const now = deps.now ?? Date.now;
  const days = deps.paymentDays ?? 7;
  const scope = Object.freeze({ ...deps.scope });
  const origin = deps.client.origin;

  function hosted(order: PaymentOrder, key: string, invoice: FakturowniaInvoice): HostedCheckout {
    const gross = parseMinor(invoice.priceGross);
    const url = deps.client.publicViewUrl(invoice);
    // Never expose a payment page whose document is not exactly this order.
    if (invoice.kind !== 'proforma' || invoice.oid !== key || invoice.currency !== 'PLN' ||
        gross !== order.amountMinor || !url || !url.startsWith(origin + '/invoice/'))
      return fail('FAKTUROWNIA_PROFORMA_MISMATCH');
    return Object.freeze({ orderId: order.id, sessionId: sessionOf(invoice), url, scope,
      amountMinor: gross, currency: 'PLN', paymentKind: 'one_time' });
  }

  async function findByOid(order: PaymentOrder, key: string): Promise<FakturowniaInvoice | null> {
    // The order is created at most 30 min before its checkout deadline; allow clock/day skew.
    const from = warsawDate(order.checkoutDeadlineMs - 2 * 86_400_000);
    const to = warsawDate(now() + 86_400_000);
    const matches: FakturowniaInvoice[] = [];
    for (let page = 1; page <= 20; page++) {
      const batch = await deps.client.proformasIssuedBetween(from, to, page);
      matches.push(...batch.filter(i => i.oid === key));
      if (batch.length < 100) {
        if (matches.length > 1) return fail('FAKTUROWNIA_DUPLICATE_PROFORMA');
        return matches[0] ?? null;
      }
    }
    // Listing not exhausted: absence is NOT confirmed, so refuse rather than return null.
    return fail('FAKTUROWNIA_LOOKUP_INCOMPLETE');
  }

  return Object.freeze({
    async createCheckout(order: PaymentOrder, key: string): Promise<HostedCheckout> {
      if (key !== `sc19:${order.id}`) fail('FAKTUROWNIA_KEY_MISMATCH');
      const buyer = await deps.buyer(order);
      try {
        const invoice = await deps.client.createProforma({ oid: key, grossMinor: order.amountMinor,
          itemName: deps.itemName(order), issueDate: warsawDate(now()), paymentDays: days, buyer });
        return hosted(order, key, invoice);
      } catch (error) {
        // A rejected create may mean "oid already used" after a lost response:
        // recover the original document; never issue a second one.
        if (error instanceof FakturowniaError && error.code === 'FAKTUROWNIA_REQUEST_REJECTED') {
          const existing = await findByOid(order, key);
          if (existing) return hosted(order, key, existing);
        }
        throw error;
      }
    },
    async lookupCheckout(order: PaymentOrder, key: string): Promise<HostedCheckout | null> {
      if (key !== `sc19:${order.id}`) fail('FAKTUROWNIA_KEY_MISMATCH');
      const existing = await findByOid(order, key);
      return existing ? hosted(order, key, existing) : null;
    },
    async verifyAndRetrieve(raw: Uint8Array, signature: string): Promise<VerifiedPayment | null> {
      const expected = createHmac('sha256', deps.triggerSecret).update(raw).digest();
      const given = /^[0-9a-f]{64}$/.test(signature) ? Buffer.from(signature, 'hex') : Buffer.alloc(0);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return fail('FAKTUROWNIA_TRIGGER_UNAUTHENTICATED');
      let msg: { v?: unknown; invoiceId?: unknown; orderId?: unknown; issuedAtMs?: unknown };
      try { msg = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { return fail('FAKTUROWNIA_TRIGGER_INVALID'); }
      if (!msg || msg.v !== 1 || !Number.isSafeInteger(msg.invoiceId) || (msg.invoiceId as number) <= 0 ||
          typeof msg.orderId !== 'string' || !ORDER.test(msg.orderId) || !Number.isSafeInteger(msg.issuedAtMs))
        return fail('FAKTUROWNIA_TRIGGER_INVALID');
      const age = now() - (msg.issuedAtMs as number);
      if (age < -60_000 || age > TRIGGER_TTL_MS) return fail('FAKTUROWNIA_TRIGGER_EXPIRED');
      // Payment truth comes only from a fresh authenticated API read.
      const invoice = await deps.client.invoice(msg.invoiceId as number);
      const key = `sc19:${msg.orderId.toLowerCase()}`;
      if (invoice.kind !== 'proforma' || invoice.oid !== key) return fail('FAKTUROWNIA_PROFORMA_MISMATCH');
      const gross = parseMinor(invoice.priceGross), paid = parseMinor(invoice.paid);
      if (gross === null || paid === null || invoice.currency !== 'PLN') return fail('FAKTUROWNIA_PROFORMA_MISMATCH');
      const status: VerifiedPayment['status'] =
        invoice.status === 'paid' && paid >= gross ? 'paid' : invoice.status === 'rejected' ? 'failed' : 'pending';
      return Object.freeze({ eventId: `fakturownia:${invoice.id}:${invoice.status}`, orderId: msg.orderId.toLowerCase(),
        sessionId: sessionOf(invoice), paymentId: sessionOf(invoice), scope, amountMinor: gross, currency: 'PLN', status });
    },
  });
}
