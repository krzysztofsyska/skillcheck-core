/**
 * SC-PRICING-W4 — ceny pakietów na publicznej stronie czytane z katalogu cen.
 *
 * Moduł jest czysty (bez bazy i importów): zna tylko kształt wierszy
 * `public.pricing_published_packages` i nie zawiera żadnej ceny. Kwoty pochodzą
 * wyłącznie z przekazanych wierszy; gdy wiersze łamią kontrakt, wynik to `null`
 * i strona zostaje przy cenach dotychczasowych (bez cen zastępczych).
 *
 * Flaga włącza funkcję wyłącznie dla dokładnej wartości „true”.
 */

/** Zmienna środowiskowa; brak lub inna wartość niż dokładnie „true” = wyłączone. */
export const PUBLIC_CATALOG_FLAG = 'PRICING_PUBLIC_CATALOG_ENABLED';

export const isPublicCatalogEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  env[PUBLIC_CATALOG_FLAG] === 'true';

export const PUBLIC_PACKAGE_CODES = ['FREE', 'PRESELEKCJA', 'WERYFIKACJA', 'ASSESSMENT_CENTER'] as const;
export type PublicPackageCode = (typeof PUBLIC_PACKAGE_CODES)[number];

/** Ceny brutto w groszach, po jednej na pakiet, wprost z katalogu. */
export type PublicPrices = Record<PublicPackageCode, number>;

const row = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const whole = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;

/**
 * Wiersze `pricing_published_packages` → ceny brutto. Wymaga dokładnie czterech
 * pakietów (po jednym wierszu każdy), kompletnych pól kontraktu i jednej stawki VAT.
 * FREE musi kosztować 0, a pakiety płatne więcej niż 0. Cokolwiek innego → `null`.
 */
export function publicPricesFromRows(rows: unknown): PublicPrices | null {
  if (!Array.isArray(rows) || rows.length !== PUBLIC_PACKAGE_CODES.length) return null;
  const prices: Partial<PublicPrices> = {};
  let vat: number | undefined;
  for (const r of rows) {
    if (!row(r) || typeof r.package_code !== 'string'
      || !(PUBLIC_PACKAGE_CODES as readonly string[]).includes(r.package_code)
      || Object.hasOwn(prices, r.package_code)
      || !whole(r.gross_minor, 0, 100_000_000)
      || !whole(r.cv_included, 0, 100_000) || !whole(r.cv_step, 0, 100_000) || !whole(r.cv_max, 0, 100_000)
      || !whole(r.overage_gross_per_cv_minor, 0, 100_000_000)
      || typeof r.sellable !== 'boolean'
      || !whole(r.vat_basis_points, 0, 10_000) || (vat !== undefined && vat !== r.vat_basis_points)) return null;
    if ((r.package_code === 'FREE') !== (r.gross_minor === 0)) return null;
    vat = r.vat_basis_points;
    prices[r.package_code as PublicPackageCode] = r.gross_minor;
  }
  return prices as PublicPrices;
}

/** Grosze → „300”, „1 499”, „299,99” (przecinek, spacja tysięcy); to samo, co zapis na stronie dziś. */
export function formatPln(grossMinor: number): string {
  const zl = Math.floor(grossMinor / 100);
  const gr = grossMinor % 100;
  const spaced = String(zl).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return gr === 0 ? spaced : `${spaced},${String(gr).padStart(2, '0')}`;
}

/** „300 zł brutto” (pakiety płatne). */
export const grossLabel = (grossMinor: number): string => `${formatPln(grossMinor)} zł brutto`;
/** „0 zł” (FREE), jak dotychczas na stronie. */
export const freeLabel = (grossMinor: number): string => `${formatPln(grossMinor)} zł`;

/**
 * Replaces the static amount quoted inside a terms text (e.g. „nie jest wliczone w <kwota> zł”) with the
 * catalog amount. `staticLabel` is the static „<kwota> zł brutto” label of the same offer.
 */
export const substituteQuotedPrice = (text: string, staticLabel: string, grossMinor: number): string =>
  text.split(staticLabel.replace(/ brutto$/, '')).join(`${formatPln(grossMinor)} zł`);
