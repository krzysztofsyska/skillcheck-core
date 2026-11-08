// SC-BUY-001: one-click path from any "Kup PRESELEKCJĘ" button to the package
// checkout screen. The payment provider integration (Przelewy24 API) is a
// separate task; this module only decides where the visitor is sent.

import { withNext } from "./safe-next-path.ts";

export const BUY_PRESELEKCJA_PATH = "/kup/preselekcja";
export const BUY_PRESELEKCJA_LABEL = "Kup PRESELEKCJĘ";

export type PurchaseCompany = { id: string; owner_id: string | null };

export type BuyPreselekcjaState = {
  /** Signed-in user's id, or null for an anonymous visitor. */
  userId: string | null;
  /** Companies the user can read, as returned by the RLS-scoped query. */
  companies: PurchaseCompany[];
};

/**
 * Only the owner of a company may order for it, so an owned company wins over
 * one the user merely recruits for.
 */
export function selectPurchaseCompany(companies: PurchaseCompany[], userId: string): string | null {
  return companies.find(company => company.owner_id === userId)?.id ?? null;
}

/**
 * Where a visitor clicking "Kup PRESELEKCJĘ" goes:
 *  - signed in, owns a company -> that company's checkout screen,
 *  - signed in, no company at all -> onboarding, returning here afterwards,
 *  - signed in, only companies owned by someone else -> the company list with
 *    an explanation, because the checkout screen would just refuse them,
 *  - anonymous -> registration, returning here after sign-up/sign-in.
 */
export function buyPreselekcjaTarget({ userId, companies }: BuyPreselekcjaState): string {
  if (!userId) return withNext("/register", BUY_PRESELEKCJA_PATH);
  if (companies.length === 0) return withNext("/onboarding", BUY_PRESELEKCJA_PATH);
  const companyId = selectPurchaseCompany(companies, userId);
  if (!companyId) return "/dashboard?message=owner-required";
  return `/dashboard/${companyId}/billing/checkout`;
}

/** Preserve the originating recruitment when an authenticated user purchases from
 * the workspace header. IDs are URL path parameters, never trusted redirect URLs;
 * company membership and purchase ownership are still checked by checkout.
 */
export function workspacePurchasePath(companyId: string | string[] | undefined, recruitmentId?: string | string[]): string {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof companyId !== 'string' || !uuid.test(companyId)) return BUY_PRESELEKCJA_PATH;
  const checkout = `/dashboard/${companyId}/billing/checkout`;
  return typeof recruitmentId === 'string' && uuid.test(recruitmentId)
    ? `${checkout}?recruitmentId=${encodeURIComponent(recruitmentId)}`
    : checkout;
}
