import { readFile } from "node:fs/promises";
import path from "node:path";
import { isPublicFutureOffersEnabled, renderCalculatorHtml } from "../../../lib/public-future-offers";

// Serves public/kalkulator-demo.html (next.config.mjs rewrites the old address here) so the blocks about
// the announced packages can be switched by PUBLIC_FUTURE_OFFERS_ENABLED at request time.
export const dynamic = "force-dynamic";

export async function GET() {
  const html = await readFile(path.join(process.cwd(), "public", "kalkulator-demo.html"), "utf8");
  return new Response(renderCalculatorHtml(html, isPublicFutureOffersEnabled()), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=0, must-revalidate" },
  });
}
