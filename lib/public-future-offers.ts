// Public visibility of the announced packages WERYFIKACJA and ASSESSMENT CENTER.
//
// Owner decision 2026-11-10: while Przelewy24 verifies the shop, the public offer must contain only
// what a verifier can actually buy (FREE and PRESELEKCJA). The packages are hidden, not deleted: their
// copy stays in the code (app/components/marketing/future-offers.ts and the marked blocks of
// public/kalkulator-demo.html) and comes back by setting one variable.
//
// This switch only decides what the public pages show. It grants no access, enables no checkout and
// touches neither billing nor the module work behind the packages.

/** Strict read, like SC19_PACKAGES_ENABLED: only the exact string "true" turns it on; unset means off. */
export const isPublicFutureOffersEnabled = (env: Record<string, string | undefined> = process.env) =>
  env.PUBLIC_FUTURE_OFFERS_ENABLED === "true";

const FUTURE_OFFERS_BLOCK = /[ \t]*<!--future-offers:start-->[\s\S]*?<!--future-offers:end-->[ \t]*\r?\n?/g;

/**
 * Static calculator page: the announced-package blocks are wrapped in future-offers markers.
 * When the switch is off the blocks are removed from the HTML that leaves the server; when on, only the markers go.
 */
export function renderCalculatorHtml(html: string, futureOffersEnabled: boolean): string {
  const result = futureOffersEnabled
    ? html.replace(/[ \t]*<!--future-offers:(?:start|end)-->[ \t]*\r?\n?/g, "")
    : html.replace(FUTURE_OFFERS_BLOCK, "");
  // Fail closed: an unpaired marker would leave an announced-package block on the page.
  if (result.includes("future-offers:")) throw new Error("future_offers_marker_unpaired");
  return result;
}
