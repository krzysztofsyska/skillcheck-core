// SC-BUY-001: one-click path from any "Kup PRESELEKCJĘ" button to the package
// checkout screen. The payment provider integration (Przelewy24 API) is a
// separate task; this module only decides where the visitor is sent.

import { withNext } from "./safe-next-path.ts";

export const BUY_PRESELEKCJA_PATH = "/kup/preselekcja";
export const BUY_PRESELEKCJA_LABEL = "Kup PRESELEKCJĘ";

export type BuyPreselekcjaState = {
  /** Signed-in user, or null for an anonymous visitor. */
  signedIn: boolean;
  /** The company whose checkout should open, or null when the user has none. */
  companyId: string | null;
};

/**
 * Where a visitor clicking "Kup PRESELEKCJĘ" goes:
 *  - signed in with a company -> that company's checkout screen,
 *  - signed in without a company -> onboarding, returning here afterwards,
 *  - anonymous -> registration, returning here after sign-up/sign-in.
 */
export function buyPreselekcjaTarget({ signedIn, companyId }: BuyPreselekcjaState): string {
  if (!signedIn) return withNext("/register", BUY_PRESELEKCJA_PATH);
  if (!companyId) return withNext("/onboarding", BUY_PRESELEKCJA_PATH);
  return `/dashboard/${companyId}/billing/checkout`;
}
