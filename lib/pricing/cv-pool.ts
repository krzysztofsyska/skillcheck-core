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

/**
 * Brutto → netto w groszach, pół w górę. Kopia `netFromGross`
 * z `lib/pricing/internal-calculator.ts`, co do znaku.
 *
 * Nie importujemy jej stamtąd, bo ten plik ciągnie `quote-engine.ts`, którego
 * składni nie uruchomi `node --test` bez transpilacji — a ten moduł ma działać
 * w przeglądarce, na serwerze i w teście jednostkowym bez narzutu. Zgodności
 * pilnuje test, który ładuje prawdziwy `quote-engine.ts` przez transpilację i
 * porównuje netto i brutto stopień po stopniu, przy kilku stawkach VAT — nie
 * tylko jedna liczba z cennika.
 */
const netFromGross = (grossMinor: number, vatBasisPoints: number): number =>
  Math.floor((grossMinor * 10_000 * 2 + (10_000 + vatBasisPoints)) / (2 * (10_000 + vatBasisPoints)));

/** VAT od kwoty netto, zaokrąglany w górę przy połowie — jak `vatOf` w silniku wyceny. */
const vatOf = (netMinor: number, vatBasisPoints: number) =>
  Math.floor((netMinor * vatBasisPoints * 2 + 10_000) / 20_000);

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

/**
 * Katalog wymusza tylko `cv_step between 1 and 1000` i `cv_max >= cv_included`.
 * Nie wymaga, żeby pula bazowa ani zakres dzieliły się przez krok, a silnik
 * wyceny takie wiersze normalnie liczy — drabinka idzie wtedy od puli bazowej
 * co krok, a ostatni dopuszczalny stopień leży poniżej `cv_max`. Ten moduł musi
 * przyjmować to samo, co katalog, bo katalog ma się zmieniać bez wdrożenia.
 * Błędem konfiguracji jest dopiero wiersz, którego nie da się zinterpretować.
 */
function assertBounds(bounds: CvPoolBounds) {
  const { min, max, step } = bounds;
  if (![min, max, step].every(value => Number.isSafeInteger(value))
    || step < 1 || min < 0 || max < min) {
    throw new CvPoolError('invalid_bounds');
  }
}

/** Najwyższy stopień drabinki mieszczący się w `cv_max`; `cv_max` nie musi na niego trafiać. */
function topOfRange(bounds: CvPoolBounds) {
  return bounds.min + Math.floor((bounds.max - bounds.min) / bounds.step) * bounds.step;
}

/** Dozwolone wartości puli, od wliczonej w cenę do maksymalnej z katalogu. */
export function cvPoolOptions(bounds: CvPoolBounds): number[] {
  assertBounds(bounds);
  const options: number[] = [];
  for (let value = bounds.min; value <= topOfRange(bounds); value += bounds.step) options.push(value);
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
  const top = topOfRange(bounds);
  if (parsed > top) {
    return { value: top, corrected: true, message: `Największa pula w tym pakiecie to ${top} CV.` };
  }
  // W zakresie: zaokrąglamy do najbliższego stopnia drabinki, przy remisie w górę.
  const steps = Math.round((parsed - min) / step);
  const value = Math.min(top, min + steps * step);
  if (value === parsed) return { value, corrected: false, message: null };
  const shown = Number.isInteger(parsed) ? String(parsed) : String(parsed).replace('.', ',');
  return {
    value,
    corrected: true,
    message: `Pulę CV zmienia się co ${step}. Zamiast ${shown} ustawiono ${value}.`,
  };
}

export type CvPoolPrice = {
  /** Pula, za którą policzono cenę — zawsze po korekcie. */
  cvCount: number;
  /** Cena netto w groszach; to ona jest jednostką rozliczenia. */
  netMinor: number;
  /** Cena brutto w groszach: netto plus VAT doliczony raz do sumy. */
  grossMinor: number;
  /** Ile CV ponad pulę wliczoną w cenę bazową. */
  overageCv: number;
};

export type CvPoolPackage = CvPoolBounds & {
  /** `gross_minor` z katalogu: cena bazowa brutto w groszach za pulę `min`. */
  baseGrossMinor: number;
  /** `overage_gross_per_cv_minor`: dopłata brutto za jedno CV ponad pulę; 0 = pakiet w całości. */
  overageGrossPerCvMinor: number;
  /** `vat_basis_points` z katalogu, np. 2300 dla 23%. */
  vatBasisPoints: number;
};

/**
 * Cena nigdy nie pochodzi z pola formularza ani z parametru adresu — zawsze
 * z przeliczenia katalogu dla puli, którą katalog dopuszcza.
 *
 * Arytmetyka jest celowo taka sama jak w `lib/pricing/quote-engine.ts`: jednostką
 * rozliczenia jest NETTO, a VAT dolicza się raz do zsumowanego netto. Dopłata
 * 20 gr brutto za CV to 16 gr netto, więc WERYFIKACJA przy 100 CV kosztuje
 * 622,87 zł, a nie 623,00 zł. Ta różnica jest opisana w docs/cennik-2026-11-02.md
 * i nie wolno jej „poprawić" po jednej ze stron — dwie formuły to dwie ceny
 * za to samo.
 *
 * Rzuca `CvPoolError`, więc miejsce wywołania musi złapać wyjątek i pokazać
 * komunikat; te funkcje nie są totalne.
 */
export function cvPoolPrice(input: unknown, pkg: CvPoolPackage): CvPoolPrice & CvPoolResolution {
  const resolution = resolveCvPool(input, pkg);
  if (!Number.isSafeInteger(pkg.baseGrossMinor) || pkg.baseGrossMinor < 0
    || !Number.isSafeInteger(pkg.overageGrossPerCvMinor) || pkg.overageGrossPerCvMinor < 0
    || !Number.isSafeInteger(pkg.vatBasisPoints) || pkg.vatBasisPoints < 0 || pkg.vatBasisPoints > 10_000) {
    throw new CvPoolError('invalid_bounds');
  }
  // Katalog pozwala zwiększyć pulę, ale nie podaje stawki za CV ponad pulę:
  // to niespójny wiersz, nie pakiet sprzedawany w całości. Cichy powrót do puli
  // bazowej byłby wyceną czegoś innego, niż klient poprosił. Pakiet w całości
  // (dziś PRESELEKCJA) ma w katalogu cv_max = cv_included i tu nie wpada.
  // Liczy się drabinka, nie samo `cv_max`: wiersz, w którym żaden stopień nie
  // wychodzi ponad pulę bazową, jest pakietem w całości i jest w porządku.
  // Uwaga na przyszłość: sprzedaż PRESELEKCJI w całych blokach po 60 CV
  // (60 = 300 zł, 120 = 600 zł) to osobna reguła cenowa, nie dopłata za CV —
  // taki wiersz trafi tu w ten warunek i ma to być sygnał do jej dopisania,
  // a nie błąd do obejścia.
  if (topOfRange(pkg) > pkg.min && pkg.overageGrossPerCvMinor === 0) throw new CvPoolError('invalid_bounds');
  const overageCv = resolution.value - pkg.min;
  const baseNetMinor = netFromGross(pkg.baseGrossMinor, pkg.vatBasisPoints);
  const overageNetMinor = netFromGross(pkg.overageGrossPerCvMinor, pkg.vatBasisPoints);
  const netMinor = baseNetMinor + overageCv * overageNetMinor;
  const grossMinor = netMinor + vatOf(netMinor, pkg.vatBasisPoints);
  if (!Number.isSafeInteger(netMinor) || !Number.isSafeInteger(grossMinor)) throw new CvPoolError('invalid_bounds');
  return { ...resolution, cvCount: resolution.value, netMinor, grossMinor, overageCv };
}

/**
 * „615,00 zł", „1 499,00 zł" — z groszy, bez zaokrągleń. Spacja przed tysiącami
 * wymuszona jawnie: domyślne grupowanie w pl-PL nie dzieli liczb czterocyfrowych,
 * a cała reszta powierzchni pisze ASSESSMENT CENTER jako „1 499 zł".
 */
export function formatGross(grossMinor: number) {
  if (!Number.isSafeInteger(grossMinor) || grossMinor < 0) throw new CvPoolError('invalid_bounds');
  const whole = Math.floor(grossMinor / 100);
  const cents = String(grossMinor % 100).padStart(2, '0');
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${grouped},${cents} zł`;
}
