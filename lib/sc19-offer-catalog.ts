/** Read-only checkout catalog: the approved offer a company may be shown.
 *
 * Reading an offer needs no payment provider, so this seam is deliberately
 * separate from lib/sc19-payment-runtime.ts. It can never create an order:
 * it exposes authenticate() and listOffers() only, both read-only, and the
 * database RPC it reads re-checks owner and verified-company authorization
 * exactly as private.sc19_payment_offers access does in
 * lib/sc19-payment-postgres.ts (owner of the company AND an approved
 * private.sc19_trial_approvals row).
 *
 * This module stays pure: no next/headers, no cookies, no provider. The
 * server composition lives in lib/sc19-offer-catalog-runtime.ts.
 */
import type { CheckoutOffer } from './sc19-payment-postgres.ts';
import { Sc19PaymentError } from './sc19-payments.ts';

export type OfferCatalog = Readonly<{
  authenticate(): Promise<{ userId: string } | null>;
  listOffers(companyId: string, userId: string): Promise<CheckoutOffer[]>;
}>;
export type OfferRow = Readonly<{
  id: unknown; revision: unknown; plan: unknown; amount_minor: unknown; currency: unknown; credits: unknown;
  terms_revision: unknown; terms_text: unknown; valid_until_ms: unknown;
}>;
const opaque = /^[A-Za-z0-9][A-Za-z0-9_.:-]{1,159}$/;
const text = (value: unknown): value is string => typeof value === 'string' && opaque.test(value);
const whole = (value: unknown, min: number, max: number): value is number =>
  Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;

/** Fail closed per row: a row that does not match the reviewed economic shape is
 * dropped, never displayed as an unverified price or entitlement. */
export function sc19OfferFromRow(row: OfferRow, nowMs = Date.now()): CheckoutOffer | null {
  if (!row || typeof row !== 'object') return null;
  if (!text(row.id) || !text(row.revision) || !text(row.terms_revision) ||
      row.plan !== 'PRESELEKCJA' || row.currency !== 'PLN' || !whole(row.amount_minor, 1, 100_000_000) ||
      !whole(row.credits, 1, 100_000) || !whole(row.valid_until_ms, 1, Number.MAX_SAFE_INTEGER) ||
      typeof row.terms_text !== 'string' || row.terms_text.length < 1 || row.terms_text.length > 20_000 ||
      row.valid_until_ms <= nowMs) return null;
  return Object.freeze({
    id: row.id, revision: row.revision, plan: 'PRESELEKCJA' as const, active: true, approved: true,
    amountMinor: row.amount_minor, currency: 'PLN' as const, credits: row.credits,
    termsRevision: row.terms_revision, termsText: row.terms_text, validUntilMs: row.valid_until_ms,
  });
}

export function sc19OffersFromRows(rows: readonly OfferRow[] | null, nowMs = Date.now()): CheckoutOffer[] {
  const offers: CheckoutOffer[] = [];
  for (const row of rows ?? []) {
    const offer = sc19OfferFromRow(row, nowMs);
    if (offer) offers.push(offer);
  }
  return offers;
}

export type OfferCatalogSource = Readonly<{
  authenticate(): Promise<{ userId: string } | null>;
  /** Must enforce owner + verified company in the database, not in the client. */
  readOffers(companyId: string): Promise<{ rows: readonly OfferRow[] | null; code?: string }>;
}>;
/** `42501` is the authorization refusal every SC-019 RPC raises; it becomes a
 * FORBIDDEN, and anything else a retryable failure. No database message, NIP or
 * company identity is ever forwarded to the client. */
export function composeSc19OfferCatalog(source: OfferCatalogSource): OfferCatalog {
  return Object.freeze({
    authenticate: source.authenticate,
    async listOffers(companyId: string) {
      const result = await source.readOffers(companyId);
      if (result.code === '42501') throw new Sc19PaymentError('SC19_PAYMENT_FORBIDDEN');
      if (result.code || !result.rows) throw new Sc19PaymentError('SC19_PAYMENT_RETRY');
      return sc19OffersFromRows(result.rows);
    },
  });
}
