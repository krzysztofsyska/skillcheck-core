/** R7: the package catalog the Stripe checkout sells from, as code.
 *
 * Prices are only in docs/cennik-2026-11-02.md; these numbers must stay equal to
 * it (tests/sc19-stripe.test.mjs reads the price list and compares). The amount a
 * buyer pays is always computed here, on the server, from the package code and the
 * number of whole packages — never taken from a form, a URL or a Stripe object.
 *
 * Pure module: no imports, safe for the browser checkout screen and for tests.
 */

/** Marks every Stripe object this application creates. The same Stripe account
 * also serves skillcheck-preselekcja (metadata app="skillcheck-preselekcja");
 * events of the other application are acknowledged and ignored. */
export const STRIPE_APP = 'skillcheck-core';

export type StripePackageCode = 'PRESELEKCJA' | 'WERYFIKACJA' | 'ASSESSMENT_CENTER';

export type StripePackage = Readonly<{
  code: StripePackageCode;
  name: string;
  /** Gross price of ONE package, in grosze, VAT 23% included. */
  grossMinor: number;
  /** CV analyses in ONE package. */
  cvCredits: number;
  /** Can be bought now. False = shown as „wkrótce”, refused by the server (409). */
  available: boolean;
}>;

export const STRIPE_CATALOG: Readonly<Record<StripePackageCode, StripePackage>> = Object.freeze({
  PRESELEKCJA: Object.freeze({ code: 'PRESELEKCJA', name: 'PRESELEKCJA', grossMinor: 30_000, cvCredits: 60, available: true }),
  // „Wkrótce” until the owner confirms these packages work (owner, 19.11.2026, answer 2).
  WERYFIKACJA: Object.freeze({ code: 'WERYFIKACJA', name: 'WERYFIKACJA', grossMinor: 61_500, cvCredits: 60, available: false }),
  ASSESSMENT_CENTER: Object.freeze({ code: 'ASSESSMENT_CENTER', name: 'ASSESSMENT CENTER', grossMinor: 149_900, cvCredits: 50, available: false }),
});

export const isStripePackageCode = (value: unknown): value is StripePackageCode =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(STRIPE_CATALOG, value);

/** Stripe Price lookup key for a package, e.g. `skillcheck-core:PRESELEKCJA`. */
export const stripeLookupKey = (code: StripePackageCode) => `${STRIPE_APP}:${code}`;

/** CV pool slider step (owner decision 2026-11-02: co 5). */
export const CV_POOL_STEP = 5;
/** Technical cap on one purchase: 20 packages = 1 200 CV = 6 000 zł for PRESELEKCJA.
 * A larger order goes through the operator; this is a safety limit, not a package size. */
export const MAX_PACKAGES = 20;

/** PRESELEKCJA is sold only in whole packages of 60 CV (owner, 19.11.2026:
 * „PRESELEKCJA tylko w całych pakietach po 60 CV, np. 2 pakiety = 600 zł = 120 CV”).
 * A pool chosen on the slider (a multiple of 5) is rounded UP to whole packages. */
export function packagesForPool(pool: unknown, code: StripePackageCode = 'PRESELEKCJA'): number | null {
  const size = STRIPE_CATALOG[code].cvCredits;
  if (!Number.isSafeInteger(pool) || Number(pool) < CV_POOL_STEP || Number(pool) % CV_POOL_STEP !== 0) return null;
  const packages = Math.ceil(Number(pool) / size);
  return packages >= 1 && packages <= MAX_PACKAGES ? packages : null;
}

export type StripeQuote = Readonly<{ code: StripePackageCode; packages: number; grossMinor: number; cvCredits: number }>;

/** Server-side amount for `packages` whole packages. Null for anything outside the catalog. */
export function stripeQuote(code: unknown, packages: unknown): StripeQuote | null {
  if (!isStripePackageCode(code) || !Number.isSafeInteger(packages) || Number(packages) < 1 || Number(packages) > MAX_PACKAGES)
    return null;
  const pkg = STRIPE_CATALOG[code], n = Number(packages);
  return Object.freeze({ code, packages: n, grossMinor: pkg.grossMinor * n, cvCredits: pkg.cvCredits * n });
}
