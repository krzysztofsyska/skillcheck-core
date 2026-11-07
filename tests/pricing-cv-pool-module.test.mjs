import { fileURLToPath } from 'node:url';
// SC-PRICING-W2b — kontrakt puli CV liczonej z katalogu cen.
// Test nie zna żadnej ceny ani granicy z kodu strony: wszystkie liczby wchodzą
// jako dane, tak jak wejdą z `public.pricing_published_packages`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import ts from 'typescript';
import {
  CvPoolError,
  cvPoolOptions,
  cvPoolPrice,
  formatGross,
  resolveCvPool,
} from '../lib/pricing/cv-pool.ts';

const VAT = 2300;
// Odpowiedniki wierszy katalogu (supabase/migrations/20261104080000_pricing_catalog.sql).
const weryfikacja = { min: 60, max: 150, step: 5, baseGrossMinor: 61_500, overageGrossPerCvMinor: 20, vatBasisPoints: VAT };
const assessmentCenter = { min: 50, max: 150, step: 5, baseGrossMinor: 149_900, overageGrossPerCvMinor: 20, vatBasisPoints: VAT };
// PRESELEKCJA sprzedaje się w całości: jedna dozwolona pula, brak dopłaty za CV.
const preselekcja = { min: 60, max: 60, step: 5, baseGrossMinor: 30_000, overageGrossPerCvMinor: 0, vatBasisPoints: VAT };
const bounds = { min: 60, max: 150, step: 5 };

test('dozwolone pule to wielokrotności kroku w granicach katalogu', () => {
  const options = cvPoolOptions(bounds);
  assert.equal(options[0], 60);
  assert.equal(options.at(-1), 150);
  assert.ok(options.every(value => value % 5 === 0));
  assert.equal(options.length, 19);
});

test('każda wielokrotność kroku przechodzi bez korekty', () => {
  for (let cv = bounds.min; cv <= bounds.max; cv += bounds.step) {
    const result = resolveCvPool(cv, bounds);
    assert.equal(result.value, cv);
    assert.equal(result.corrected, false);
    assert.equal(result.message, null);
  }
});

test('wpisanie 63 daje 65, nigdy 63, i mówi o korekcie', () => {
  const result = resolveCvPool(63, bounds);
  assert.equal(result.value, 65);
  assert.equal(result.corrected, true);
  assert.match(result.message, /co 5/);
  assert.match(result.message, /65/);
  assert.equal(resolveCvPool(61, bounds).value, 60);
  assert.equal(resolveCvPool(62, bounds).value, 60);
  assert.equal(resolveCvPool(64, bounds).value, 65);
});

test('wartość spoza zakresu wraca do granicy, a nie do NaN', () => {
  const low = resolveCvPool(5, bounds);
  assert.equal(low.value, 60);
  assert.match(low.message, /Najmniejsza pula/);
  const high = resolveCvPool(5000, bounds);
  assert.equal(high.value, 150);
  assert.match(high.message, /Największa pula/);
});

test('tekst, puste pole i ułamek nie wywracają ceny', () => {
  for (const input of ['', '   ', 'sto', '60,5', '6e1', null, undefined, {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = resolveCvPool(input, bounds);
    assert.equal(result.value, 60, `${String(input)} powinno wrócić do puli bazowej`);
    assert.equal(Number.isFinite(result.value), true);
    assert.equal(result.corrected, true);
  }
  // Liczba ułamkowa w zakresie jest zaokrąglana do kroku, nie odrzucana.
  assert.equal(resolveCvPool(62.4, bounds).value, 60);
  // Ta sama liczba jako tekst z suwaka działa identycznie, również z zerem
  // wiodącym i spacjami wokół — tak przychodzą wartości z pola formularza.
  assert.deepEqual(resolveCvPool('65', bounds), resolveCvPool(65, bounds));
  assert.equal(resolveCvPool('065', bounds).value, 65);
  assert.equal(resolveCvPool('  70  ', bounds).value, 70);
  // Dokładnie pół kroku zaokrągla się w górę, deterministycznie.
  assert.equal(resolveCvPool(62.5, bounds).value, 65);
  assert.equal(Object.is(resolveCvPool(-0, bounds).value, -0), false);
});

test('cena bierze się z katalogu, nie z pola formularza', () => {
  const base = cvPoolPrice(60, weryfikacja);
  assert.equal(base.grossMinor, 61_500);
  assert.equal(base.overageCv, 0);
  assert.equal(formatGross(base.grossMinor), '615,00 zł');
  // Wartość skorygowana jest tą, za którą liczymy — nigdy wpisana.
  const corrected = cvPoolPrice('103', weryfikacja);
  assert.equal(corrected.cvCount, 105);
});

test('dopłata liczy się od netto, dokładnie jak w silniku wyceny', () => {
  // docs/cennik-2026-11-02.md: jednostką jest 16 gr NETTO, a VAT dolicza się raz
  // do sumy, więc WERYFIKACJA przy 100 CV to 622,87 zł, a nie 623,00 zł.
  // Dwie formuły oznaczałyby dwie ceny za to samo.
  const bigger = cvPoolPrice(100, weryfikacja);
  assert.equal(bigger.cvCount, 100);
  assert.equal(bigger.overageCv, 40);
  const baseNet = Math.round(61_500 / 1.23);
  assert.equal(bigger.netMinor, baseNet + 40 * 16);
  assert.equal(bigger.grossMinor, 62_287);
  assert.equal(formatGross(bigger.grossMinor), '622,87 zł');
  assert.notEqual(bigger.grossMinor, 61_500 + 40 * 20);
});

test('wynik zgadza się z dokumentem cennika, a nie tylko sam ze sobą', () => {
  // Jedyne źródło prawdy do czasu przepięcia strony na katalog. Jeśli ten moduł
  // kiedyś policzy inaczej niż silnik, ta liczba przestanie się zgadzać.
  const cennik = readFileSync(new URL('../docs/cennik-2026-11-02.md', import.meta.url), 'utf8');
  assert.match(cennik, /622,87 zł/);
  assert.match(cennik, /16 gr netto za sztukę/);
  assert.equal(formatGross(cvPoolPrice(100, weryfikacja).grossMinor), '622,87 zł');
});

test('ASSESSMENT CENTER: pula bazowa 50, krok 5 i ta sama arytmetyka', () => {
  const base = cvPoolPrice(50, assessmentCenter);
  assert.equal(base.cvCount, 50);
  assert.equal(base.grossMinor, 149_900);
  assert.equal(formatGross(base.grossMinor), '1 499,00 zł');
  assert.equal(cvPoolPrice(53, assessmentCenter).cvCount, 55);
  const bigger = cvPoolPrice(100, assessmentCenter);
  assert.equal(bigger.overageCv, 50);
  assert.equal(bigger.netMinor, Math.round(149_900 / 1.23) + 50 * 16);
  assert.equal(cvPoolOptions(assessmentCenter)[0], 50);
});

test('pakiet sprzedawany w całości nie dostaje wymyślonej dopłaty', () => {
  // Katalog daje dziś PRESELEKCJI jedną dozwoloną pulę, więc większa wartość
  // wraca do niej po granicy zakresu.
  const clamped = cvPoolPrice(150, preselekcja);
  assert.equal(clamped.cvCount, 60);
  assert.equal(clamped.grossMinor, 30_000);
  assert.equal(clamped.overageCv, 0);
  assert.equal(clamped.corrected, true);
});

test('katalog dopuszczający większą pulę bez stawki za CV to błąd, nie cicha korekta', () => {
  // Cichy powrót do 60 CV wycenia coś innego, niż klient poprosił. Lepiej
  // komunikat o błędzie konfiguracji niż zaniżona pula w cenie bazowej.
  assert.throws(() => cvPoolPrice(100, { ...preselekcja, max: 150 }),
    error => error instanceof CvPoolError);
  assert.throws(() => cvPoolPrice(60, { ...preselekcja, max: 150 }),
    error => error instanceof CvPoolError);
});

test('kwoty formatują się tak, jak pisze je reszta powierzchni', () => {
  assert.equal(formatGross(0), '0,00 zł');
  assert.equal(formatGross(1), '0,01 zł');
  assert.equal(formatGross(99), '0,99 zł');
  assert.equal(formatGross(30_000), '300,00 zł');
  assert.equal(formatGross(61_500), '615,00 zł');
  assert.equal(formatGross(149_900), '1 499,00 zł');
  assert.equal(formatGross(100_000_000), '1 000 000,00 zł');
});

test('niespójny katalog kończy się błędem, nie ceną', () => {
  // Tylko wiersze, których nie da się zinterpretować. Pula bazowa i zakres
  // niedzielące się przez krok są dozwolone przez katalog i liczone niżej.
  for (const broken of [
    { min: 60, max: 50, step: 5 },
    { min: 60, max: 150, step: 0 },
    { min: -5, max: 150, step: 5 },
    { min: 60, max: 150, step: 2.5 },
    { min: 60.5, max: 150, step: 5 },
  ]) {
    assert.throws(() => resolveCvPool(60, broken), error => error instanceof CvPoolError);
    assert.throws(() => cvPoolOptions(broken), error => error instanceof CvPoolError);
  }
  assert.throws(() => cvPoolPrice(60, { ...weryfikacja, baseGrossMinor: -1 }),
    error => error instanceof CvPoolError);
  assert.throws(() => formatGross(-1), error => error instanceof CvPoolError);
});

test('granice i krok pochodzą z danych, więc zmiana katalogu zmienia kontrakt', () => {
  const tenStep = { min: 50, max: 100, step: 10 };
  assert.deepEqual(cvPoolOptions(tenStep), [50, 60, 70, 80, 90, 100]);
  assert.equal(resolveCvPool(63, tenStep).value, 60);
  assert.match(resolveCvPool(63, tenStep).message, /co 10/);
});

// Prawdziwy silnik wyceny, załadowany przez transpilację (quote-engine.ts używa
// składni, której `node --test` sam nie rozbierze). Ten sam wzorzec, co w
// tests/sc-pricing-engine.test.mjs.
const enginePath = fileURLToPath(new URL('../lib/pricing/quote-engine.ts', import.meta.url));
const engineModule = new Module(enginePath);
engineModule.filename = enginePath;
engineModule.paths = Module._nodeModulePaths(fileURLToPath(new URL('../', import.meta.url)));
engineModule.require = createRequire(enginePath);
engineModule._compile(ts.transpileModule(readFileSync(enginePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, enginePath);
const { quoteOffer } = engineModule.exports;
const engineNet = (grossMinor, vat) =>
  Math.floor((grossMinor * 10_000 * 2 + (10_000 + vat)) / (2 * (10_000 + vat)));

test('wynik zgadza się z silnikiem wyceny stopień po stopniu, nie w jednym punkcie', () => {
  for (const vat of [2300, 500, 800, 777, 10_000]) {
    for (const row of [
      { base: 61_500, overage: 20, min: 60, max: 150, step: 5 },
      { base: 149_900, overage: 20, min: 50, max: 150, step: 5 },
      { base: 30_000, overage: 7, min: 60, max: 300, step: 5 },
    ]) {
      const offer = {
        versionId: 'cmp-v1', status: 'PUBLISHED', approved: true, currency: 'PLN', vatBasisPoints: vat,
        plans: [{
          code: 'WERYFIKACJA', baseNetMinor: engineNet(row.base, vat), commercialStatus: 'purchasable',
          cvIncluded: row.min, cvPolicy: { quick: [], range: { min: row.min, max: row.max, step: row.step } },
          cvOverageRule: { method: 'per_unit', unitMinor: engineNet(row.overage, vat) }, capabilityCode: null,
        }],
        services: [], planServices: [], discounts: [],
      };
      for (let cv = row.min; cv <= row.max; cv += row.step) {
        const quote = quoteOffer(offer,
          { expectedVersionId: 'cmp-v1', packageCode: 'WERYFIKACJA', cvCount: cv, addons: [] }, new Set(), {});
        const mine = cvPoolPrice(cv, {
          min: row.min, max: row.max, step: row.step,
          baseGrossMinor: row.base, overageGrossPerCvMinor: row.overage, vatBasisPoints: vat,
        });
        assert.equal(mine.netMinor, quote.netMinor, `netto przy ${cv} CV, VAT ${vat}`);
        assert.equal(mine.grossMinor, quote.grossMinor, `brutto przy ${cv} CV, VAT ${vat}`);
      }
    }
  }
});

test('katalog dopuszcza pulę bazową i zakres niedzielące się przez krok', () => {
  // `pricing.package_prices` tego nie wymaga, a silnik takie wiersze liczy:
  // drabinka idzie od puli bazowej co krok, a ostatni stopień leży pod cv_max.
  assert.deepEqual(cvPoolOptions({ min: 55, max: 155, step: 10 }), [55, 65, 75, 85, 95, 105, 115, 125, 135, 145, 155]);
  const odd = { min: 50, max: 148, step: 20 };
  assert.deepEqual(cvPoolOptions(odd), [50, 70, 90, 110, 130]);
  assert.equal(resolveCvPool(148, odd).value, 130);
  assert.match(resolveCvPool(148, odd).message, /130 CV/);
  // Wiersz, w którym żaden stopień nie wychodzi ponad pulę bazową, to wciąż
  // pakiet w całości, a nie błąd konfiguracji.
  assert.equal(cvPoolPrice(62, { ...preselekcja, max: 62 }).cvCount, 60);
});
