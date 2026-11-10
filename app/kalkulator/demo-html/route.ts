import { readFile } from "node:fs/promises";
import path from "node:path";
import { isPublicFutureOffersEnabled, renderCalculatorHtml } from "../../../lib/public-future-offers";

// Serves content/kalkulator-demo.html (next.config.mjs rewrites /kalkulator-demo.html here) so the blocks about
// the announced packages can be switched by PUBLIC_FUTURE_OFFERS_ENABLED at request time. The file lives
// outside public/ on purpose: nothing serves it statically, so no encoded URL can return the unfiltered page.
export const dynamic = "force-dynamic";

const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=0, must-revalidate" };

// Shown if the file or the filter fails: only PRESELEKCJA and FREE, never the raw file.
const fallback = `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kalkulator kosztu rekrutacji — SkillCheck</title></head><body><main style="max-width:640px;margin:40px auto;padding:0 16px;font-family:system-ui,sans-serif"><h1>Kalkulator chwilowo niedostępny</h1><p>PRESELEKCJA kosztuje 300 zł brutto za pakiet 60 analiz CV. FREE: 0 zł, 5 analiz CV, jedna próba na firmę.</p><p><a href="/#pakiety">Zobacz ofertę</a> · <a href="/preselekcja">PRESELEKCJA</a></p></main></body></html>`;

export async function GET() {
  try {
    const html = await readFile(path.join(process.cwd(), "content", "kalkulator-demo.html"), "utf8");
    return new Response(renderCalculatorHtml(html, isPublicFutureOffersEnabled()), { headers });
  } catch (error) {
    console.error("kalkulator_demo_html_failed", error instanceof Error ? error.message : "unknown");
    return new Response(fallback, { status: 503, headers: { ...headers, "Retry-After": "30" } });
  }
}
