// SC-PRICING-W2b część 2 — model i komponent suwaka puli CV.
// Wiersze wchodzą jako dane (jak z public.pricing_published_packages), nie ze stałych strony.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sliderPackagesFromRows, sliderView, stepCvPool } from '../lib/pricing/cv-pool-slider-model.ts';

const row = (code, over = {}) => ({ package_code: code, gross_minor: 61_500, cv_included: 60, cv_step: 5, cv_max: 150,
  overage_gross_per_cv_minor: 20, sellable: false, vat_basis_points: 2300, ...over });
const rows = [
  row('FREE', { gross_minor: 0, cv_included: 5, cv_max: 5, overage_gross_per_cv_minor: 0 }),
  row('PRESELEKCJA', { gross_minor: 30_000, cv_max: 60, overage_gross_per_cv_minor: 0, sellable: true }),
  row('WERYFIKACJA'),
  row('ASSESSMENT_CENTER', { gross_minor: 149_900, cv_included: 50 }),
];

test('pakiety płatne z katalogu, FREE pominięty, PRESELEKCJA bez suwaka', () => {
  const packages = sliderPackagesFromRows(rows);
  assert.deepEqual(packages.map(p => p.code), ['PRESELEKCJA', 'WERYFIKACJA', 'ASSESSMENT_CENTER']);
  assert.equal(packages[0].adjustable, false);
  assert.equal(packages[1].adjustable, true);
  assert.equal(packages[2].min, 50);
});

test('granice i krok czytane z katalogu: inna pula w danych zmienia suwak', () => {
  const [pkg] = sliderPackagesFromRows([row('WERYFIKACJA', { cv_included: 40, cv_max: 90, cv_step: 10 })]);
  assert.deepEqual([pkg.min, pkg.max, pkg.step], [40, 90, 10]);
  assert.equal(sliderView(95, pkg).value, 90);
  assert.equal(stepCvPool(40, 1, pkg), 50);
  assert.equal(stepCvPool(90, 1, pkg), 90);
  assert.equal(stepCvPool(40, -1, pkg), 40);
});

test('cena z przeliczenia katalogu: WERYFIKACJA 100 CV = 622,87 zł, nigdy z pola', () => {
  const [pkg] = sliderPackagesFromRows([row('WERYFIKACJA')]);
  assert.equal(sliderView(60, pkg).grossLabel, '615,00 zł');
  assert.equal(sliderView(100, pkg).grossLabel, '622,87 zł');
  assert.equal(sliderView('100', pkg).grossLabel, '622,87 zł');
});

test('63 daje 65 z komunikatem; tekst, puste i spoza zakresu bez NaN', () => {
  const [pkg] = sliderPackagesFromRows([row('WERYFIKACJA')]);
  const fixed = sliderView(63, pkg);
  assert.equal(fixed.value, 65);
  assert.match(fixed.message, /co 5/);
  for (const bad of ['', 'abc', '  ', null, undefined, NaN, Infinity, -5, 1e9, '6.5']) {
    const v = sliderView(bad, pkg);
    assert.ok(Number.isInteger(v.value) && v.value >= 60 && v.value <= 150 && v.value % 5 === 0);
    assert.doesNotMatch(String(v.grossLabel), /NaN|undefined/);
    assert.ok(v.grossLabel);
  }
});

test('katalog nieczytelny albo niespójny daje null, nie cenę', () => {
  assert.equal(sliderPackagesFromRows(null), null);
  assert.equal(sliderPackagesFromRows([row('WERYFIKACJA', { cv_step: 0 })]), null);
  assert.equal(sliderPackagesFromRows([row('WERYFIKACJA', { gross_minor: '615' })]), null);
  assert.equal(sliderPackagesFromRows([row('WERYFIKACJA', { overage_gross_per_cv_minor: 0 })]), null);
  assert.deepEqual(sliderPackagesFromRows([]), []);
});

test('komponent: suwak i pole dzielą jeden stan, klawiatura, brak stałych cen i voicebota', () => {
  const src = readFileSync(new URL('../app/components/pricing/cv-pool-slider.tsx', import.meta.url), 'utf8');
  assert.match(src, /type="range"/);
  assert.match(src, /inputMode="numeric"/);
  assert.equal((src.match(/useState\(pkg\.min\)/g) ?? []).length, 1, 'jeden stan wartości');
  assert.match(src, /aria-valuetext/);
  assert.match(src, /stepCvPool/);
  assert.doesNotMatch(src, /\b\d{3,}\b/, 'żadnych liczb typu cena/pula w komponencie');
  const page = readFileSync(new URL('../app/cennik/suwak-cv/page.tsx', import.meta.url), 'utf8');
  for (const text of [src, page, readFileSync(new URL('../lib/pricing/cv-pool-slider-model.ts', import.meta.url), 'utf8')]) {
    assert.doesNotMatch(text, /voice|bot\b|rozmow/i);
  }
});

test('strona jest domyślnie wyłączona flagą i czyta katalog z RPC', () => {
  const page = readFileSync(new URL('../app/cennik/suwak-cv/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /PRICING_CV_SLIDER_ENABLED !== "true"\) notFound\(\)/);
  assert.match(page, /pricing_published_packages/);
  assert.match(page, /index: false/);
});
