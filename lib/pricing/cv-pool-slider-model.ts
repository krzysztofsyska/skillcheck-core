/**
 * SC-PRICING-W2b (część 2) — model suwaka puli CV przy pakietach.
 *
 * Czysty moduł bez Reacta: zamienia wiersze `public.pricing_published_packages()`
 * na dane dla komponentu i liczy to, co komponent pokazuje. Żadnej ceny, puli ani
 * kroku nie ma w kodzie — wszystko przychodzi z katalogu. Cena zawsze wychodzi
 * z `cvPoolPrice`, nigdy z wartości pola.
 */
import { CvPoolError, cvPoolOptions, cvPoolPrice, formatGross, resolveCvPool, type CvPoolPackage } from './cv-pool.ts';

/** Etykiety pakietów płatnych. To nazwy, nie liczby; ceny i pule są w katalogu. */
const labels: Record<string, string> = {
  PRESELEKCJA: 'PRESELEKCJA',
  WERYFIKACJA: 'WERYFIKACJA',
  ASSESSMENT_CENTER: 'ASSESSMENT CENTER',
};

export type SliderPackage = CvPoolPackage & {
  code: string;
  name: string;
  /** Katalog oznacza, czy pakiet można dziś kupić; strona tylko to pokazuje. */
  sellable: boolean;
  /** Pakiet sprzedawany w całości (jedna dozwolona pula) nie ma suwaka. */
  adjustable: boolean;
};

const whole = (v: unknown, min: number, max: number): v is number =>
  Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;

/**
 * Wiersze katalogu → pakiety płatne dla suwaka. `null` = katalog nieczytelny
 * (strona pokazuje komunikat, nie liczbę). FREE i nieznane kody są pomijane.
 */
export function sliderPackagesFromRows(rows: unknown): SliderPackage[] | null {
  if (!Array.isArray(rows) || rows.length > 50) return null;
  const output: SliderPackage[] = [];
  for (const p of rows) {
    if (p === null || typeof p !== 'object' || Array.isArray(p)) return null;
    const r = p as Record<string, unknown>;
    if (typeof r.package_code !== 'string' || typeof r.sellable !== 'boolean'
      || !whole(r.gross_minor, 0, 100_000_000) || !whole(r.cv_included, 0, 10_000)
      || !whole(r.cv_step, 1, 1000) || !whole(r.cv_max, r.cv_included, 10_000)
      || !whole(r.overage_gross_per_cv_minor, 0, 100_000_000) || !whole(r.vat_basis_points, 0, 10_000)) return null;
    if (!Object.hasOwn(labels, r.package_code)) continue;
    const pkg: CvPoolPackage = {
      min: r.cv_included, max: r.cv_max, step: r.cv_step, baseGrossMinor: r.gross_minor,
      overageGrossPerCvMinor: r.overage_gross_per_cv_minor, vatBasisPoints: r.vat_basis_points,
    };
    try {
      const options = cvPoolOptions(pkg);
      // Wiersz, który cvPoolPrice odrzuci, nie trafia na stronę z wymyśloną ceną.
      cvPoolPrice(pkg.min, pkg);
      output.push({ ...pkg, code: r.package_code, name: labels[r.package_code], sellable: r.sellable, adjustable: options.length > 1 });
    } catch (error) {
      if (error instanceof CvPoolError) return null;
      throw error;
    }
  }
  return output;
}

export type SliderView = {
  value: number;
  message: string | null;
  /** Cena brutto z przeliczenia katalogu; `null`, gdy się nie da policzyć. */
  grossLabel: string | null;
  netLabel: string | null;
};

/** Stan do pokazania dla dowolnego wejścia (suwak, pole, adres): zawsze z przeliczenia. */
export function sliderView(input: unknown, pkg: SliderPackage): SliderView {
  try {
    const priced = cvPoolPrice(input, pkg);
    return { value: priced.value, message: priced.message,
      grossLabel: formatGross(priced.grossMinor), netLabel: formatGross(priced.netMinor) };
  } catch (error) {
    if (!(error instanceof CvPoolError)) throw error;
    return { value: pkg.min, message: 'Nie możemy teraz policzyć ceny tej puli.', grossLabel: null, netLabel: null };
  }
}

/** Zmiana o jeden krok (przyciski); wynik zawsze z `resolveCvPool`. */
export function stepCvPool(current: number, direction: 1 | -1, pkg: SliderPackage): number {
  return resolveCvPool(current + direction * pkg.step, pkg).value;
}
