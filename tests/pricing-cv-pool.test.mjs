// Jedno źródło prawdy dla cen to docs/cennik-2026-11-02.md (do czasu SC-PRICING-W2).
// Ten test pilnuje dwóch rzeczy naraz:
//   1. te same liczby w dokumencie cennika, w treści strony, w demie kalkulatora
//      i w domyślnej konfiguracji kalkulatora wewnętrznego;
//   2. kontrakt puli CV: krok 5, ręczne wpisanie tylko jako wielokrotność 5 (SC-PRICING-W2b).
//
// Stan oferty po decyzjach właściciela z 2026-11-02: kupić można dziś FREE i PRESELEKCJĘ,
// natomiast WERYFIKACJA i ASSESSMENT CENTER są pokazywane jako kolejne etapy **z zatwierdzoną
// ceną** i bez terminu uruchomienia.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const demo = read('public/kalkulator-demo.html');
const cennik = read('docs/cennik-2026-11-02.md');
const content = read('app/components/marketing/content.ts');
const future = read('app/components/marketing/future-offers.ts');
const comparison = read('app/components/marketing/package-comparison.tsx');
const internal = read('lib/pricing/internal-calculator.ts');

const CV_STEP = 5;
const CV_MIN = 35;
const CV_MAX = 150;
// Pule poniżej suwaka, wybierane przyciskiem — zostają poza kontraktem kroku 5.
const QUICK_CV = [10, 20, 30];

test('dokument cennika podaje zatwierdzone liczby', () => {
  assert.match(cennik, /PRESELEKCJA \| 300 zł \| 60/);
  assert.match(cennik, /WERYFIKACJA \| 615 zł \| 60/);
  assert.match(cennik, /ASSESSMENT CENTER \| 1 499 zł \| 50/);
  assert.match(cennik, /5–6 osób, maksymalnie 10/);
  assert.match(cennik, /zwiększana suwakiem \*\*co 5\*\*/, 'cennik zapisuje krok 5 dla puli CV');
});

test('kolejne etapy na stronie mają zatwierdzone ceny, nie są bezcenowe', () => {
  assert.match(future, /price: "615 zł brutto"/);
  assert.match(future, /price: "1 499 zł brutto"/);
  assert.match(future, /60 CV · do 10 testowanych osób · jedno stanowisko/);
  assert.match(future, /50 CV · do 6 finalistów · 3 ćwiczenia na osobę/);
  // Cena zatwierdzona, pakiet jeszcze nie do kupienia — obie rzeczy muszą być powiedziane.
  assert.match(comparison, /Cena zatwierdzona/);
  assert.match(comparison, /Nie można ich jeszcze kupić/);
  assert.match(comparison, /Cena zatwierdzona · pakiet w przygotowaniu/);
  assert.match(comparison, /stage\.price/);
});

test('demo kalkulatora podaje te same ceny etapów co strona', () => {
  assert.match(demo, /615 zł brutto za 60 CV/);
  assert.match(demo, /1 499 zł brutto za 50 CV/);
  assert.match(demo, /do 6 finalistów w cenie/);
  assert.match(demo, /7–10 osób wymaga osobnej oferty/);
});

test('voicebot nie jest pokazywany nigdzie na powierzchniach publicznych', () => {
  // Decyzja właściciela 2026-11-02 (wieczór): bota nie pokazujemy w ogóle. Wróci dopiero,
  // gdy zacznie działać — wtedy jako dodatek do pakietu, gratis albo za niewielką opłatą.
  for (const [name, text] of [['treść strony', content], ['planowane oferty', future], ['komponent porównania', comparison], ['demo', demo]]) {
    for (const word of ['voicebot', 'Voicebot', 'rozmów z botem', 'Rozmowy z botem', 'rozmowy z botem', 'rozmów AI', 'rozmowy AI']) {
      assert.equal(text.includes(word), false, `${name}: wzmianka o voicebocie „${word}"`);
    }
  }
});

test('wycofane ceny nie wracają', () => {
  for (const stale of ['899', '1799', '1 799', '1845']) {
    assert.equal(demo.includes(stale), false, `demo: wycofana cena ${stale}`);
    assert.equal(future.includes(stale), false, `planowane oferty: wycofana cena ${stale}`);
    assert.equal(content.includes(stale), false, `treść strony: wycofana cena ${stale}`);
    assert.equal(comparison.includes(stale), false, `komponent porównania: wycofana cena ${stale}`);
  }
});

test('domyślna konfiguracja kalkulatora wewnętrznego zgadza się z cennikiem', () => {
  assert.match(internal, /PRESELEKCJA: \{ grossMinor: 30_000, cvIncluded: 60/);
  assert.match(internal, /WERYFIKACJA: \{ grossMinor: 61_500, cvIncluded: 60/);
  assert.match(internal, /ASSESSMENT_CENTER: \{ grossMinor: 149_900, cvIncluded: 50/);
});

test('dopłata za CV ponad pulę bazową jest ustawiona tam, gdzie pula skaluje się co 5', () => {
  // 0,1652 zł netto × 1,23 VAT ≈ 20 groszy brutto — stawka z §2 cennika.
  assert.match(internal, /WERYFIKACJA: \{[^}]*overageGrossPerCvMinor: 20 \}/);
  assert.match(internal, /ASSESSMENT_CENTER: \{[^}]*overageGrossPerCvMinor: 20 \}/);
  assert.equal(Math.round(0.1652 * 1.23 * 100), 20);
});

test('cennik podaje efektywną stawkę dopłaty, a nie równe 20 groszy brutto', () => {
  // Silnik mnoży 16 gr NETTO za sztukę i dolicza VAT raz do zsumowanego netto, więc brutto
  // za jedno CV wychodzi ok. 0,1968 zł. WERYFIKACJA przy 100 CV = 622,87 zł, nie 623,00 zł.
  // Cennik musi podawać tę liczbę, inaczej ktoś uzna rozbieżność za błąd i „poprawi" jedną stronę.
  const baseNet = Math.round(61_500 / 1.23);
  const expected = Math.round((baseNet + 40 * 16) * 1.23) / 100;
  assert.equal(expected, 622.87);
  assert.match(cennik, /622,87 zł/);
  assert.match(cennik, /16 gr netto za sztukę/);
  // PRESELEKCJA nie ma dopłaty za CV — sprzedaje się całymi pakietami.
  assert.match(cennik, /Dotyczy wyłącznie WERYFIKACJI i ASSESSMENT CENTER/);
  assert.match(internal, /PRESELEKCJA: \{ grossMinor: 30_000, cvIncluded: 60, cvOptions: \[60\], overageGrossPerCvMinor: 0 \}/);
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

test('pula CV przyjmuje tylko wielokrotności 5', () => {
  const accepts = acceptsCv();
  for (let cv = CV_MIN; cv <= CV_MAX; cv += CV_STEP) {
    assert.equal(accepts(cv), true, `${cv} CV powinno być przyjęte`);
  }
  for (const cv of [36, 37, 41, 63, 64, 99, 101, 149]) {
    assert.equal(accepts(cv), false, `${cv} CV nie jest wielokrotnością 5`);
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
