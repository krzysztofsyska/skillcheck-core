/**
 * SC-PRICING-W2b — pula CV przy pakiecie: suwak co 5 i ręczne wpisanie liczby,
 * też wyłącznie wielokrotność kroku.
 *
 * Moduł jest czysty i nie zna żadnej ceny ani liczby CV z kodu: granice i krok
 * przychodzą z katalogu cen (`public.pricing_published_packages`, SC-PRICING-W2).
 * Dzięki temu zmiana puli w katalogu zmienia stronę bez wdrożenia kodu, a brak
 * katalogu kończy się komunikatem, nie wymyśloną liczbą.
 *
 * Ta sama funkcja liczy wartość po stronie serwera i po stronie przeglądarki, więc
 * wartość wpisana ręcznie w formularzu nigdy nie decyduje o cenie — decyduje
 * przeliczenie na podstawie katalogu.
 */

export type CvPoolBounds = {
  /** Pula wliczona w cenę bazową pakietu (`cv_included`). */
  min: number;
  /** Największa pula, jaką katalog dopuszcza dla tego pakietu (`cv_max`). */
  max: number;
  /** Krok zmiany puli (`cv_step`; decyzja właściciela 2026-11-02: co 5). */
  step: number;
};

export type CvPoolResolution = {
  /** Wartość przyjęta po korekcie — zawsze wielokrotność kroku w granicach katalogu. */
  value: number;
  /** Czy wpisana wartość została zmieniona. */
  corrected: boolean;
  /** Dlaczego, po polsku, do pokazania przy polu. `null`, gdy nic nie korygowano. */
  message: string | null;
};

export class CvPoolError extends Error {
  readonly code: 'invalid_bounds';
  constructor(code: 'invalid_bounds') {
    super(code);
    this.code = code;
    this.name = 'CvPoolError';
  }
}

function assertBounds(bounds: CvPoolBounds) {
  const { min, max, step } = bounds;
  if (![min, max, step].every(value => Number.isSafeInteger(value))
    || step < 1 || min < 0 || max < min
    || min % step !== 0 || (max - min) % step !== 0) {
    // Katalog z niespójną pulą jest błędem konfiguracji, nie wyborem klienta:
    // lepiej pokazać komunikat niż policzyć cenę za pulę, której nie da się kupić.
    throw new CvPoolError('invalid_bounds');
  }
}

/** Dozwolone wartości puli, od wliczonej w cenę do maksymalnej z katalogu. */
export function cvPoolOptions(bounds: CvPoolBounds): number[] {
  assertBounds(bounds);
  const options: number[] = [];
  for (let value = bounds.min; value <= bounds.max; value += bounds.step) options.push(value);
  return options;
}

/**
 * Sprowadza dowolne wejście z formularza do dozwolonej puli.
 * Puste pole, tekst, ułamek i wartość spoza zakresu nie wywracają ceny —
 * wracają jako najbliższa dozwolona pula wraz z wyjaśnieniem.
 */
export function resolveCvPool(input: unknown, bounds: CvPoolBounds): CvPoolResolution {
  assertBounds(bounds);
  const { min, max, step } = bounds;
  const raw = typeof input === 'string' ? input.trim() : input;
  const parsed = typeof raw === 'number' ? raw
    : typeof raw === 'string' && /^[0-9]+$/.test(raw) ? Number(raw)
      : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return { value: min, corrected: true, message: `Podaj liczbę CV. Ustawiono ${min}.` };
  }
  if (parsed < min) {
    return { value: min, corrected: true, message: `Najmniejsza pula w tym pakiecie to ${min} CV.` };
  }
  if (parsed > max) {
    return { value: max, corrected: true, message: `Największa pula w tym pakiecie to ${max} CV.` };
  }
  // W zakresie: zaokrąglamy do najbliższej wielokrotności kroku, przy remisie w górę.
  const steps = Math.round((parsed - min) / step);
  const value = Math.min(max, min + steps * step);
  if (value === parsed) return { value, corrected: false, message: null };
  return {
    value,
    corrected: true,
    message: `Pulę CV zmienia się co ${step}. Zamiast ${parsed} ustawiono ${value}.`,
  };
}

export type CvPoolPrice = {
  /** Pula, za którą policzono cenę — zawsze po korekcie. */
  cvCount: number;
  /** Cena brutto w groszach. */
  grossMinor: number;
  /** Ile CV ponad pulę wliczoną w cenę bazową. */
  overageCv: number;
};

export type CvPoolPackage = CvPoolBounds & {
  /** Cena bazowa brutto w groszach za pulę `min`. */
  baseGrossMinor: number;
  /** Dopłata brutto w groszach za jedno CV ponad pulę bazową; 0 = pakiet w całości. */
  overageGrossPerCvMinor: number;
};

/**
 * Cena nigdy nie pochodzi z pola formularza ani z parametru adresu — zawsze
 * z przeliczenia katalogu dla puli, którą katalog dopuszcza.
 */
export function cvPoolPrice(input: unknown, pkg: CvPoolPackage): CvPoolPrice & CvPoolResolution {
  const resolution = resolveCvPool(input, pkg);
  if (!Number.isSafeInteger(pkg.baseGrossMinor) || pkg.baseGrossMinor < 0
    || !Number.isSafeInteger(pkg.overageGrossPerCvMinor) || pkg.overageGrossPerCvMinor < 0) {
    throw new CvPoolError('invalid_bounds');
  }
  const overageCv = resolution.value - pkg.min;
  if (overageCv > 0 && pkg.overageGrossPerCvMinor === 0) {
    // Pakiet sprzedawany w całości (dziś PRESELEKCJA): katalog nie zna ceny za
    // CV ponad pulę, więc nie wolno jej zmyślić — zostaje pula bazowa.
    return {
      value: pkg.min,
      corrected: true,
      message: `Ten pakiet sprzedajemy w całości, z pulą ${pkg.min} CV.`,
      cvCount: pkg.min,
      grossMinor: pkg.baseGrossMinor,
      overageCv: 0,
    };
  }
  return {
    ...resolution,
    cvCount: resolution.value,
    grossMinor: pkg.baseGrossMinor + overageCv * pkg.overageGrossPerCvMinor,
    overageCv,
  };
}

/** „615,00 zł" z groszy, bez zaokrągleń w drugą stronę. */
export function formatGross(grossMinor: number) {
  if (!Number.isSafeInteger(grossMinor) || grossMinor < 0) throw new CvPoolError('invalid_bounds');
  return `${(grossMinor / 100).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
}
