/** R7: the package catalog the Stripe checkout sells from, as code.
 *
 * Prices are only in docs/cennik-2026-11-02.md; these numbers must stay equal to
 * it (tests/sc19-stripe.test.mjs reads the price list and compares). The amount a
 * buyer pays is always computed here, on the server, from the package code and the
 * number of whole packages — never taken from a form, a URL or a Stripe object.
 *
 * Pure module: its only import is the pure CV pool pricing (lib/pricing/cv-pool.ts,
 * the same arithmetic as the quote engine), safe for the browser checkout screen
 * and for tests.
 */
import { cvPoolPrice } from './pricing/cv-pool.ts';

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
  /** Most whole packages in one purchase. WERYFIKACJA and ASSESSMENT CENTER: 1.
   * Their CV pool above the base is priced by the overage rule of the price list
   * (0,16 zł netto per CV, see `overage`), not by multiplying the package. */
  maxPackages: number;
  /** CV pool above `cvCredits` (docs/cennik-2026-11-02.md, „Dopłata za CV powyżej
   * puli bazowej”), the same values as the pricing catalog row (pricing.package_prices
   * cv_max, overage_gross_per_cv_minor) and the internal calculator. Null =
   * no surcharge: PRESELEKCJA is sold only in whole packages of 60 CV. */
  overage: Readonly<{ cvMax: number; grossPerCvMinor: number }> | null;
}>;

export const STRIPE_CATALOG: Readonly<Record<StripePackageCode, StripePackage>> = Object.freeze({
  PRESELEKCJA: Object.freeze({ code: 'PRESELEKCJA', name: 'PRESELEKCJA', grossMinor: 30_000, cvCredits: 60, available: true, maxPackages: 20, overage: null }),
  // R7 (docs/ROADMAP.md): bought through Stripe Checkout in TEST mode only, behind the
  // same default-off sales switch (SC19_PACKAGES_ENABLED). One whole package per
  // purchase; the paid package is recorded as sc19_commerce.entitlements
  // 'package:<code>' (migration 20261121150000_r7_stripe_packages.sql), which is what
  // the R3 Assessment Center gate reads.
  WERYFIKACJA: Object.freeze({ code: 'WERYFIKACJA', name: 'WERYFIKACJA', grossMinor: 61_500, cvCredits: 60, available: true, maxPackages: 1,
    overage: Object.freeze({ cvMax: 150, grossPerCvMinor: 20 }) }),
  ASSESSMENT_CENTER: Object.freeze({ code: 'ASSESSMENT_CENTER', name: 'ASSESSMENT CENTER', grossMinor: 149_900, cvCredits: 50, available: true, maxPackages: 1,
    overage: Object.freeze({ cvMax: 150, grossPerCvMinor: 20 }) }),
});

export const isStripePackageCode = (value: unknown): value is StripePackageCode =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(STRIPE_CATALOG, value);

/** Stripe Price lookup key for a package, e.g. `skillcheck-core:PRESELEKCJA`. */
export const stripeLookupKey = (code: StripePackageCode) => `${STRIPE_APP}:${code}`;

/** CV pool slider step (owner decision 2026-11-02: co 5). */
export const CV_POOL_STEP = 5;
/** VAT 23%, the rate of the pricing catalog (pricing.catalog_versions.vat_basis_points). */
export const STRIPE_VAT_BASIS_POINTS = 2300;
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
  if (!isStripePackageCode(code) || !Number.isSafeInteger(packages) || Number(packages) < 1 ||
      Number(packages) > Math.min(MAX_PACKAGES, STRIPE_CATALOG[code].maxPackages))
    return null;
  const pkg = STRIPE_CATALOG[code], n = Number(packages);
  return Object.freeze({ code, packages: n, grossMinor: pkg.grossMinor * n, cvCredits: pkg.cvCredits * n });
}

export type StripePoolQuote = Readonly<{ code: StripePackageCode; cvCredits: number; overageCv: number; netMinor: number; grossMinor: number }>;

/** R7: server-side price of ONE WERYFIKACJA or ASSESSMENT CENTER package with a CV
 * pool from its base pool up to `overage.cvMax`, in steps of CV_POOL_STEP counted
 * from the base. Computed by the pricing engine arithmetic (cvPoolPrice: net base +
 * 16 gr net per extra CV, VAT added once on the summed net, whole grosze), so
 * WERYFIKACJA with 100 CV = 62287 gr. The base pool gives exactly the package price.
 * Null for PRESELEKCJA (no surcharge), for a pool below the base (no discount) and
 * for any value the slider cannot produce — never a silently corrected pool. */
export function stripePoolQuote(code: unknown, cvCount: unknown): StripePoolQuote | null {
  if (!isStripePackageCode(code)) return null;
  const pkg = STRIPE_CATALOG[code];
  if (!pkg.overage || typeof cvCount !== 'number' || !Number.isSafeInteger(cvCount) ||
      cvCount < pkg.cvCredits || cvCount > pkg.overage.cvMax || (cvCount - pkg.cvCredits) % CV_POOL_STEP !== 0) return null;
  let price;
  try {
    price = cvPoolPrice(cvCount, { min: pkg.cvCredits, max: pkg.overage.cvMax, step: CV_POOL_STEP,
      baseGrossMinor: pkg.grossMinor, overageGrossPerCvMinor: pkg.overage.grossPerCvMinor, vatBasisPoints: STRIPE_VAT_BASIS_POINTS });
  } catch { return null; }
  if (price.corrected || price.cvCount !== cvCount) return null;
  return Object.freeze({ code, cvCredits: price.cvCount, overageCv: price.overageCv, netMinor: price.netMinor, grossMinor: price.grossMinor });
}

export type CvCountCheck = Readonly<{ ok: true; packages: number }> | Readonly<{ ok: false; message: string }>;

/** R5 W2b: server-side check of a CV count sent with an order (the slider pool).
 *
 * The count never sets the price or the credits: it only has to be a value the
 * slider can produce for this package, and it is turned into whole packages here,
 * on the server. Allowed values:
 * - PRESELEKCJA: a multiple of CV_POOL_STEP from CV_POOL_STEP to MAX_PACKAGES × 60,
 *   rounded UP to whole packages of 60 CV (owner, 19.11.2026);
 * - WERYFIKACJA and ASSESSMENT CENTER: one package with a pool from its base pool
 *   up to the catalog maximum, co CV_POOL_STEP (R7); the amount of a larger pool
 *   is stripePoolQuote(), computed on the server. Never below the base pool.
 * `packages`, when the request also names it, must be the same number of packages
 * the count gives; a mismatch is refused, never silently resolved either way.
 * Messages are Polish and contain only numbers from the request and the catalog. */
export function checkCvCount(code: StripePackageCode, cvCount: unknown, packages: number | null = null): CvCountCheck {
  const pkg = STRIPE_CATALOG[code];
  const no = (message: string): CvCountCheck => Object.freeze({ ok: false, message });
  if (typeof cvCount !== 'number' || !Number.isSafeInteger(cvCount) || cvCount < 0)
    return no('Liczba CV musi być liczbą całkowitą.');
  if (code !== 'PRESELEKCJA') {
    const max = pkg.overage?.cvMax ?? pkg.cvCredits;
    if (cvCount < pkg.cvCredits) return no(`Najmniejsza pula CV w pakiecie ${pkg.name} to ${pkg.cvCredits}.`);
    if (cvCount > max)
      return no(`Największa pula CV w pakiecie ${pkg.name} to ${max}. Większe zamówienie złożysz przez obsługę SkillCheck.`);
    if ((cvCount - pkg.cvCredits) % CV_POOL_STEP !== 0)
      return no(`Liczbę CV wybiera się co ${CV_POOL_STEP}. ${cvCount} nie jest dozwoloną wartością.`);
    if (cvCount !== pkg.cvCredits && !stripePoolQuote(code, cvCount)) return no('Tej liczby CV nie można zamówić online.');
    if (packages !== null && packages !== 1)
      return no(`Pakiet ${pkg.name} kupuje się online jako jeden pakiet; większą pulę wybierasz liczbą CV.`);
    return Object.freeze({ ok: true, packages: 1 });
  }
  const max = MAX_PACKAGES * pkg.cvCredits;
  if (cvCount < CV_POOL_STEP) return no(`Najmniejsza pula CV to ${CV_POOL_STEP}.`);
  if (cvCount % CV_POOL_STEP !== 0) return no(`Liczbę CV wybiera się co ${CV_POOL_STEP}. ${cvCount} nie jest dozwoloną wartością.`);
  if (cvCount > max) return no(`Największa pula CV w jednym zakupie to ${max}. Większe zamówienie złożysz przez obsługę SkillCheck.`);
  const derived = packagesForPool(cvCount, code);
  if (derived === null) return no('Tej liczby CV nie można zamówić online.');
  if (packages !== null && packages !== derived)
    return no(`Liczba CV (${cvCount}) nie zgadza się z liczbą pakietów (${packages}). Odśwież stronę i wybierz pulę CV ponownie.`);
  return Object.freeze({ ok: true, packages: derived });
}
