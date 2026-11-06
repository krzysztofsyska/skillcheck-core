// SC-PRICING-W2b — kontrakt puli CV liczonej z katalogu cen.
// Test nie zna żadnej ceny ani granicy z kodu strony: wszystkie liczby wchodzą
// jako dane, tak jak wejdą z `public.pricing_published_packages`.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CvPoolError,
  cvPoolOptions,
  cvPoolPrice,
  formatGross,
  resolveCvPool,
} from '../lib/pricing/cv-pool.ts';

// Odpowiednik wiersza katalogu dla WERYFIKACJI: 60 CV w cenie, do 150, krok 5.
const weryfikacja = { min: 60, max: 150, step: 5, baseGrossMinor: 61_500, overageGrossPerCvMinor: 20 };
// PRESELEKCJA sprzedaje się w całości: brak dopłaty za CV ponad pulę.
const preselekcja = { min: 60, max: 60, step: 5, baseGrossMinor: 30_000, overageGrossPerCvMinor: 0 };
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
  // Ta sama liczba jako tekst z suwaka działa identycznie.
  assert.deepEqual(resolveCvPool('65', bounds), resolveCvPool(65, bounds));
});

test('cena bierze się z katalogu, nie z pola formularza', () => {
  const base = cvPoolPrice(60, weryfikacja);
  assert.equal(base.grossMinor, 61_500);
  assert.equal(base.overageCv, 0);
  assert.equal(formatGross(base.grossMinor), '615,00 zł');
  const bigger = cvPoolPrice(100, weryfikacja);
  assert.equal(bigger.cvCount, 100);
  assert.equal(bigger.overageCv, 40);
  assert.equal(bigger.grossMinor, 61_500 + 40 * 20);
  assert.equal(formatGross(bigger.grossMinor), '623,00 zł');
  // Wartość skorygowana jest tą, za którą liczymy — nigdy wpisana.
  const corrected = cvPoolPrice('103', weryfikacja);
  assert.equal(corrected.cvCount, 105);
  assert.equal(corrected.grossMinor, 61_500 + 45 * 20);
});

test('pakiet sprzedawany w całości nie dostaje wymyślonej dopłaty', () => {
  // Katalog daje dziś PRESELEKCJI jedną dozwoloną pulę, więc większa wartość
  // wraca do niej po granicy zakresu.
  const clamped = cvPoolPrice(150, preselekcja);
  assert.equal(clamped.cvCount, 60);
  assert.equal(clamped.grossMinor, 30_000);
  assert.equal(clamped.overageCv, 0);
  assert.equal(clamped.corrected, true);
  // A gdyby katalog dopuścił większą pulę bez stawki za CV ponad pulę, cena nie
  // może zostać zmyślona: zostaje pula bazowa i jasny komunikat.
  const widened = cvPoolPrice(100, { ...preselekcja, max: 150 });
  assert.equal(widened.cvCount, 60);
  assert.equal(widened.grossMinor, 30_000);
  assert.equal(widened.overageCv, 0);
  assert.match(widened.message, /w całości/);
});

test('niespójny katalog kończy się błędem, nie ceną', () => {
  for (const broken of [
    { min: 60, max: 50, step: 5 },
    { min: 60, max: 150, step: 0 },
    { min: 61, max: 150, step: 5 },
    { min: 60, max: 148, step: 5 },
    { min: 60, max: 150, step: 2.5 },
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
