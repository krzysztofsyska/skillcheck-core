/** Net / VAT / gross split of a checkout amount. Pure arithmetic, no imports:
 * the browser checkout summary and the server offer catalog share this module,
 * so the customer and the order can never disagree about the price.
 *
 * GROSS is authoritative. `amount_minor` on the offer and on the order is what
 * the customer is charged and what a settlement is matched against; net and VAT
 * are derived from it and never recomputed into a new gross. The VAT part is the
 * remainder, so net + VAT === gross for every representable amount.
 */

/** Owner-approved Polish VAT rate, the same basis points the internal pricing
 * calculator uses (`vatBasisPoints: 2300`, lib/pricing/internal-calculator.ts). */
export const SC19_VAT_BASIS_POINTS = 2300;

export type Sc19OfferAmounts = Readonly<{
  grossMinor: number; netMinor: number; vatMinor: number; vatBasisPoints: number;
}>;

/** Half-up gross → net in grosze, the same formula as `netFromGross` in
 * lib/pricing/internal-calculator.ts. 300,00 zl gross at 23% VAT gives
 * 243,90 zl net + 56,10 zl VAT. Returns null for an amount or rate outside the
 * reviewed range, so a caller renders nothing rather than an invented price. */
export function sc19OfferAmounts(
  grossMinor: number,
  vatBasisPoints: number = SC19_VAT_BASIS_POINTS,
): Sc19OfferAmounts | null {
  if (!Number.isSafeInteger(grossMinor) || grossMinor < 0 || grossMinor > 100_000_000 ||
      !Number.isSafeInteger(vatBasisPoints) || vatBasisPoints < 0 || vatBasisPoints > 10_000) return null;
  const rate = 10_000 + vatBasisPoints;
  const netMinor = Math.floor((grossMinor * 10_000 * 2 + rate) / (2 * rate));
  return Object.freeze({ grossMinor, netMinor, vatMinor: grossMinor - netMinor, vatBasisPoints });
}
