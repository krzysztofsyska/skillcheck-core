/**
 * SC-PRICING-W3 — opcje płatne wybierane przez klienta, liczone z katalogu cen.
 *
 * Moduł jest czysty (bez bazy, bez importów), więc działa tak samo na serwerze,
 * w przeglądarce i w teście. Zna tylko kształt wierszy katalogu
 * (`public.pricing_published_addons`, `public.pricing_published_packages`),
 * nie zna żadnej ceny ani nazwy opcji z kodu.
 *
 * Zasady:
 * - opcja jest „płatna” tylko wtedy, gdy katalog podaje cenę wyższą od zera;
 *   opcja za 0 zł nigdy nie jest pokazywana jako płatna (wypada z listy),
 * - wybór klienta to wyłącznie liczba sztuk per kod opcji; cena nigdy nie
 *   pochodzi z formularza ani z adresu — zawsze z przeliczenia katalogu,
 * - arytmetyka jak w `quote-engine.ts` i `cv-pool.ts`: jednostką rozliczenia
 *   jest netto, VAT dolicza się raz do zsumowanego netto,
 * - flaga włącza funkcję wyłącznie dla dokładnej wartości „true”.
 */

/** Zmienna środowiskowa; brak lub inna wartość niż dokładnie „true” = wyłączone. */
export const PAID_OPTIONS_FLAG = 'PRICING_PAID_OPTIONS_ENABLED';

export const isPaidOptionsEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  env[PAID_OPTIONS_FLAG] === 'true';

/** Największa liczba sztuk jednej opcji w jednym wyborze (limit techniczny interfejsu). */
export const MAX_OPTION_QUANTITY = 100;

export type PaidOption = {
  code: string;
  name: string;
  unit: string;
  /** Cena brutto za jedną sztukę, w groszach, wprost z katalogu; zawsze większa od zera. */
  grossMinor: number;
};

export type OptionSelection = Record<string, number>;

export type OptionsPrice = {
  lines: { code: string; name: string; unit: string; quantity: number; unitGrossMinor: number; netMinor: number }[];
  netMinor: number;
  vatMinor: number;
  grossMinor: number;
};

const CODE = /^[a-z][a-z0-9_]{1,40}$/;
const row = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const whole = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;

/** Brutto → netto w groszach, pół w górę; ta sama formuła co `netFromGross` w kalkulatorze wewnętrznym. */
const netFromGross = (grossMinor: number, vatBasisPoints: number): number =>
  Math.floor((grossMinor * 10_000 * 2 + (10_000 + vatBasisPoints)) / (2 * (10_000 + vatBasisPoints)));

/** VAT od sumy netto, pół w górę; ta sama formuła co `vatOf` w silniku wyceny. */
const vatOf = (netMinor: number, vatBasisPoints: number): number =>
  Math.floor((netMinor * vatBasisPoints * 2 + 10_000) / 20_000);

/**
 * Wiersze `pricing_published_addons` → opcje płatne. Pozycje z ceną 0 są pomijane
 * (nie są płatne), a wiersz niezgodny z kontraktem unieważnia całość: `null`
 * zamiast zgadywania.
 */
export function paidOptionsFromRows(rows: unknown): PaidOption[] | null {
  if (!Array.isArray(rows) || rows.length > 100) return null;
  const seen = new Set<string>();
  const out: PaidOption[] = [];
  for (const r of rows) {
    if (!row(r) || typeof r.code !== 'string' || !CODE.test(r.code) || seen.has(r.code)
      || typeof r.name !== 'string' || r.name.length < 1 || r.name.length > 120
      || typeof r.unit !== 'string' || r.unit.length < 1 || r.unit.length > 40
      || !whole(r.gross_minor, 0, 100_000_000)) return null;
    seen.add(r.code);
    if (r.gross_minor > 0) out.push({ code: r.code, name: r.name, unit: r.unit, grossMinor: r.gross_minor });
  }
  return out;
}

/**
 * Wybór klienta → czyste ilości. Przyjmuje wyłącznie kody z katalogu i liczby
 * całkowite 1…MAX_OPTION_QUANTITY; każde inne pole (w tym „price”, „amount”)
 * jest ignorowane. Zero i wartości nieprawidłowe oznaczają „nie wybrano”.
 */
export function resolveSelection(input: unknown, options: readonly PaidOption[]): OptionSelection {
  const out: OptionSelection = {};
  if (!row(input)) return out;
  for (const o of options) {
    const q = Object.hasOwn(input, o.code) ? input[o.code] : undefined;
    if (whole(q, 1, MAX_OPTION_QUANTITY)) out[o.code] = q;
  }
  return out;
}

/** Suma wybranych opcji z katalogu. `vatBasisPoints` pochodzi z katalogu pakietów, nie z formularza. */
export function priceSelection(input: unknown, options: readonly PaidOption[], vatBasisPoints: number): OptionsPrice {
  if (!whole(vatBasisPoints, 0, 10_000)) throw new Error('invalid_vat');
  const selection = resolveSelection(input, options);
  const lines: OptionsPrice['lines'] = [];
  let netMinor = 0;
  for (const o of options) {
    const quantity = selection[o.code];
    if (!quantity) continue;
    const lineNet = quantity * netFromGross(o.grossMinor, vatBasisPoints);
    netMinor += lineNet;
    lines.push({ code: o.code, name: o.name, unit: o.unit, quantity, unitGrossMinor: o.grossMinor, netMinor: lineNet });
  }
  const vatMinor = vatOf(netMinor, vatBasisPoints);
  if (!Number.isSafeInteger(netMinor + vatMinor)) throw new Error('amount_out_of_range');
  return { lines, netMinor, vatMinor, grossMinor: netMinor + vatMinor };
}

/** Stawka VAT z wierszy `pricing_published_packages`; `null`, gdy katalog jest niespójny lub pusty. */
export function vatFromPackageRows(rows: unknown): number | null {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 20) return null;
  let vat: number | undefined;
  for (const r of rows) {
    if (!row(r) || !whole(r.vat_basis_points, 0, 10_000) || (vat !== undefined && vat !== r.vat_basis_points)) return null;
    vat = r.vat_basis_points;
  }
  return vat ?? null;
}
