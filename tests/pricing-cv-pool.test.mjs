// Jedno źródło prawdy dla cen to docs/cennik-2026-11-02.md (do czasu SC-PRICING-W2).
// Ten test pilnuje dwóch rzeczy naraz:
//   1. te same liczby w dokumencie cennika, w demie kalkulatora, w komponencie porównania
//      i w domyślnej konfiguracji kalkulatora wewnętrznego;
//   2. kontrakt puli CV z SC-PRICING-W2b: krok 5, ręczne wpisanie tylko jako wielokrotność 5,
//      sprawdzone dla wszystkich trzech pakietów płatnych.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const demo = read('public/kalkulator-demo.html');
const cennik = read('docs/cennik-2026-11-02.md');
const comparison = read('app/components/marketing/package-comparison.tsx');
const internal = read('lib/pricing/internal-calculator.ts');

// Zatwierdzone przez właściciela 2026-11-02. Grosze, brutto.
const APPROVED = {
  pre: { grossMinor: 30_000, baseCv: 60 },
  verify: { grossMinor: 61_500, baseCv: 60 },
  ac: { grossMinor: 149_900, baseCv: 50 },
};

const CV_STEP = 5;
const CV_MIN = 35;
const CV_MAX = 150;
// Pule poniżej suwaka, wybierane przyciskiem — zostają poza kontraktem kroku 5.
const QUICK_CV = [10, 20, 30];

/** Wyciąga literał obiektu z inline'owego skryptu demo, np. BASE_GROSS_CENTS={...}. */
function demoObject(name) {
  const m = demo.match(new RegExp(`const ${name}=\\{([^}]*)\\}`));
  assert.ok(m, `demo kalkulatora nie zawiera stałej ${name}`);
  return Object.fromEntries(
    m[1].split(',').map((pair) => {
      const [k, v] = pair.split(':');
      return [k.trim(), Number(v)];
    }),
  );
}

test('demo kalkulatora niesie zatwierdzone ceny bazowe i pule CV', () => {
  const gross = demoObject('BASE_GROSS_CENTS');
  const baseCv = demoObject('BASE_CV');

  assert.equal(gross.free, 0);
  for (const [pack, { grossMinor }] of Object.entries(APPROVED)) {
    assert.equal(gross[pack], grossMinor, `${pack}: cena bazowa w demie`);
  }
  // PRESELEKCJA liczy się pakietami po 60 CV, więc jej pula bazowa jest osobną stałą.
  assert.match(demo, /const PRE_PACKAGE_CV=60/);
  assert.equal(baseCv.verify, APPROVED.verify.baseCv);
  assert.equal(baseCv.ac, APPROVED.ac.baseCv);
});

test('dokument cennika podaje te same liczby co kod', () => {
  assert.match(cennik, /PRESELEKCJA \| 300 zł \| 60/);
  assert.match(cennik, /WERYFIKACJA \| 615 zł \| 60/);
  assert.match(cennik, /ASSESSMENT CENTER \| 1 499 zł \| 50/);
  // Proces AC jest skalowany na 5–6 osób, maksymalnie 10 — to część oferty, nie tylko opis.
  assert.match(cennik, /5–6 osób, maksymalnie 10/);
  assert.match(cennik, /zwiększana suwakiem \*\*co 5\*\*/, 'cennik zapisuje krok 5 dla puli CV');
});

test('komponent porównania pakietów nie rozjeżdża się z cennikiem', () => {
  assert.match(comparison, /price:"615 zł"/);
  assert.match(comparison, /price:"1 499 zł"/);
  assert.match(comparison, /60 CV \+ testy kompetencji/);
  assert.match(comparison, /50 CV \+ testy \+ zadania praktyczne/);
  // Cena zatwierdzona nie może być opisana jako robocza wizualizacja.
  assert.match(comparison, /priceApproved:true/);
  assert.doesNotMatch(comparison, /899/);
  assert.doesNotMatch(comparison, /1 799|1799/);
});

test('domyślna konfiguracja kalkulatora wewnętrznego zgadza się z cennikiem', () => {
  assert.match(internal, /WERYFIKACJA: \{ grossMinor: 61_500, cvIncluded: 60/);
  assert.match(internal, /ASSESSMENT_CENTER: \{ grossMinor: 149_900, cvIncluded: 50/);
  assert.match(internal, /PRESELEKCJA: \{ grossMinor: 30_000, cvIncluded: 60/);
});

test('suwak puli CV ma krok 5 w całym zakresie', () => {
  assert.match(demo, /id="volumeSlider" min="35" max="150" step="5"/);
  assert.match(demo, /aria-label="Pula CV od 35 do 150, krok 5"/);
});

/**
 * Odtwarza predykat walidacji z `setCv` w demie, zamiast duplikować regułę w teście.
 * Dzięki temu test pilnuje tego, co naprawdę jest w pliku, a nie własnej kopii reguły.
 */
function acceptsCv() {
  // Cała treść `if (...)` to warunek ODRZUCENIA, więc akceptacja to jego negacja.
  const m = demo.match(/function setCv\(cv\)\{if\((.*?)\)return;/);
  assert.ok(m, 'demo kalkulatora nie zawiera walidacji w setCv');
  const rejects = m[1];
  assert.ok(rejects.includes('cv%5===0'), 'walidacja nie wymusza wielokrotności 5');
  assert.ok(rejects.includes('Number.isInteger(cv)'), 'walidacja nie wymusza liczby całkowitej');
  // eslint-disable-next-line no-new-func
  return new Function('cv', `"use strict";return !(${rejects});`);
}

test('pula CV przyjmuje tylko wielokrotności 5 — dla każdego pakietu płatnego', () => {
  const accepts = acceptsCv();
  // Reguła jest wspólna dla pakietów, więc sprawdzamy ją jawnie dla każdego z trzech,
  // żeby regresja na jednym z nich nie przeszła niezauważona.
  for (const pack of ['pre', 'verify', 'ac']) {
    for (let cv = CV_MIN; cv <= CV_MAX; cv += CV_STEP) {
      assert.equal(accepts(cv), true, `${pack}: ${cv} CV powinno być przyjęte`);
    }
    for (const cv of [36, 37, 41, 63, 64, 99, 101, 149]) {
      assert.equal(accepts(cv), false, `${pack}: ${cv} CV nie jest wielokrotnością 5`);
    }
  }
});

test('ręczne wpisanie poza zakresem, niecałkowite lub nieliczbowe jest odrzucane', () => {
  const accepts = acceptsCv();
  for (const cv of [0, -5, 5, 15, 25, 34, 155, 200, 1000]) {
    assert.equal(accepts(cv), false, `${cv} CV jest poza dozwolonym zakresem`);
  }
  for (const cv of [60.5, Number.NaN, Number.POSITIVE_INFINITY, '60', null, undefined, {}]) {
    assert.equal(accepts(cv), false, `${String(cv)} nie jest całkowitą liczbą CV`);
  }
});

test('pule poniżej suwaka pozostają dostępne jako osobne przyciski', () => {
  const accepts = acceptsCv();
  for (const cv of QUICK_CV) {
    assert.equal(accepts(cv), true, `${cv} CV jest pulą wybieraną przyciskiem`);
  }
});

test('podpisy na kartach pakietów opisują tę samą pulę CV co pokazana cena', () => {
  // Regresja z review #248: podpis był statyczny, a cena przeliczana dla state.cv.
  assert.match(demo, /data-package-sub="verify"/);
  assert.match(demo, /data-package-sub="ac"/);
  assert.match(demo, /document\.querySelectorAll\('\[data-package-sub\]'\)/);
  assert.match(demo, /state\.cv===base\?'cena bazowa':'symulacja wolumenu'/);
});

test('demo nie zawiera wycofanych cen', () => {
  assert.doesNotMatch(demo, /\b899\b/);
  assert.doesNotMatch(demo, /\b1845\b/);
  assert.doesNotMatch(demo, /\b1799\b/);
});
