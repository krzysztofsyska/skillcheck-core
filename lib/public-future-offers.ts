// Public visibility of the announced packages WERYFIKACJA and ASSESSMENT CENTER.
//
// Owner decision 2026-11-10: while the payment operator verified the shop, the public offer contained only what a
// verifier can actually buy (FREE and PRESELEKCJA). Owner decision 2026-11-16 (ROADMAP R4, "tak jak
// polecasz"): the packages were hidden only because of that verification, so they are visible again, with their
// approved prices and the note that they cannot be bought yet. The switch stays as a kill switch: the
// exact value "false" hides them again (copy lives in app/components/marketing/future-offers.ts and the
// marked blocks of content/kalkulator-demo.html).
//
// This switch only decides what the public pages show. It grants no access, enables no checkout and
// touches neither billing nor the module work behind the packages.

/** On by default; only the exact string "false" hides the announced packages (kill switch). */
export const isPublicFutureOffersEnabled = (env: Record<string, string | undefined> = process.env) =>
  env.PUBLIC_FUTURE_OFFERS_ENABLED !== "false";

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
