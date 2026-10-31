/** SC-CHECKOUT-P24-001: products sold through the public /checkout path.
 * Prices are server truth; the browser only sends a product code and quantity.
 * Gross price includes 23% VAT. No surcharge for any payment method.
 */
// Mirrors preselekcjaOffer (app/components/marketing/preselekcja-offer.ts); a test keeps them equal.
const PRESELEKCJA = { analyses: 60, grossPln: 300, validityMonths: 3 } as const;

export type CheckoutProduct = Readonly<{
  code: string;
  name: string;
  description: string;
  unitGross: number; // grosze
  maxQuantity: number;
}>;

export const CHECKOUT_PRODUCTS: Readonly<Record<string, CheckoutProduct>> = Object.freeze({
  preselekcja: Object.freeze({
    code: 'preselekcja',
    name: 'Pakiet PRESELEKCJA',
    description: `${PRESELEKCJA.analyses} analiz CV, ważne ${PRESELEKCJA.validityMonths} miesiące`,
    unitGross: PRESELEKCJA.grossPln * 100,
    maxQuantity: 10,
  }),
});

export function checkoutProduct(code: unknown): CheckoutProduct | null {
  return typeof code === 'string' && Object.hasOwn(CHECKOUT_PRODUCTS, code) ? CHECKOUT_PRODUCTS[code] : null;
}

export function checkoutQuantity(product: CheckoutProduct, raw: unknown): number | null {
  const n = typeof raw === 'string' && /^\d{1,2}$/.test(raw) ? Number(raw) : raw;
  return Number.isSafeInteger(n) && (n as number) >= 1 && (n as number) <= product.maxQuantity ? n as number : null;
}

export const formatPln = (grosze: number) =>
  (grosze / 100).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' zł';
