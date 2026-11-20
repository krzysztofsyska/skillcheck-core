// SC-PRICING-W3 — opcje płatne wybierane przez klienta, za flagą domyślnie wyłączoną.
// Wiersze wchodzą jako dane (jak z `pricing_published_addons`); test nie zna cen z kodu strony.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire, Module } from 'node:module';
import ts from 'typescript';
import {
  MAX_OPTION_QUANTITY,
  isPaidOptionsEnabled,
  paidOptionsFromRows,
  priceSelection,
  resolveSelection,
  vatFromPackageRows,
} from '../lib/pricing/paid-options.ts';

const paidOptionsModule = () => transpile('../lib/pricing/paid-options.ts', {});
const rows = [
  { code: 'report', name: 'Raport PDF/CSV', unit: 'raport', gross_minor: 1_230 },
  { code: 'ocr_page', name: 'Strona OCR', unit: 'strona', gross_minor: 7 },
  { code: 'free_thing', name: 'Pozycja bezpłatna', unit: 'szt.', gross_minor: 0 },
];

function transpile(path, stubs) {
  const file = fileURLToPath(new URL(path, import.meta.url));
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(fileURLToPath(new URL('../', import.meta.url)));
  const real = createRequire(file);
  mod.require = id => (id in stubs ? stubs[id] : real(id));
  mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, file);
  return mod.exports;
}

test('flaga: wyłączona domyślnie, włącza ją wyłącznie dokładne „true”', () => {
  assert.equal(isPaidOptionsEnabled({}), false);
  for (const v of [undefined, '', 'false', 'TRUE', 'True', '1', 'yes', ' true', 'true ']) {
    assert.equal(isPaidOptionsEnabled({ PRICING_PAID_OPTIONS_ENABLED: v }), false, String(v));
  }
  assert.equal(isPaidOptionsEnabled({ PRICING_PAID_OPTIONS_ENABLED: 'true' }), true);
});

test('stan z flagą wyłączoną: loader nie sięga do bazy i zwraca null', async () => {
  let calls = 0;
  const { loadPaidOptions } = transpile('../lib/pricing/paid-options-server.ts', {
    './paid-options': paidOptionsModule(), '../supabase/server': { createClient: async () => { calls += 1; throw new Error('baza nie powinna być wołana'); } },
  });
  for (const env of [{}, { PRICING_PAID_OPTIONS_ENABLED: 'false' }, { PRICING_PAID_OPTIONS_ENABLED: 'TRUE' }]) {
    assert.equal(await loadPaidOptions(env), null);
  }
  assert.equal(calls, 0);
});

test('stan z flagą wyłączoną: strona renderuje sekcję tylko, gdy loader coś zwrócił', () => {
  const page = readFileSync(new URL('../app/preselekcja/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /\{paidOptions \? <PaidOptionsPicker [^>]*\/> : null\}/);
  const flagCalls = page.match(/loadPaidOptions\(/g) ?? [];
  assert.equal(flagCalls.length, 1);
});

test('flaga włączona: loader czyta katalog i zwraca tylko opcje wycenione powyżej zera', async () => {
  const names = [];
  const client = { rpc: async name => {
    names.push(name);
    return name === 'pricing_published_addons'
      ? { data: rows, error: null }
      : { data: [{ vat_basis_points: 2300 }, { vat_basis_points: 2300 }], error: null };
  } };
  const { loadPaidOptions } = transpile('../lib/pricing/paid-options-server.ts', {
    './paid-options': paidOptionsModule(), '../supabase/server': { createClient: async () => client },
  });
  const offer = await loadPaidOptions({ PRICING_PAID_OPTIONS_ENABLED: 'true' });
  assert.deepEqual(names.sort(), ['pricing_published_addons', 'pricing_published_packages']);
  assert.equal(offer.vatBasisPoints, 2300);
  assert.deepEqual(offer.options.map(o => o.code), ['report', 'ocr_page']);
  // Błąd katalogu albo brak płatnych opcji: brak sekcji, nie cena zastępcza.
  const broken = transpile('../lib/pricing/paid-options-server.ts', {
    './paid-options': paidOptionsModule(), '../supabase/server': { createClient: async () => ({ rpc: async () => ({ data: null, error: { message: 'x' } }) }) },
  });
  assert.equal(await broken.loadPaidOptions({ PRICING_PAID_OPTIONS_ENABLED: 'true' }), null);
  const none = transpile('../lib/pricing/paid-options-server.ts', {
    './paid-options': paidOptionsModule(), '../supabase/server': { createClient: async () => ({ rpc: async n => ({
      data: n === 'pricing_published_addons' ? [rows[2]] : [{ vat_basis_points: 2300 }], error: null }) }) },
  });
  assert.equal(await none.loadPaidOptions({ PRICING_PAID_OPTIONS_ENABLED: 'true' }), null);
});

test('opcja za 0 zł nie jest pokazywana jako płatna', () => {
  const options = paidOptionsFromRows(rows);
  assert.deepEqual(options.map(o => o.code), ['report', 'ocr_page']);
  assert.ok(options.every(o => o.grossMinor > 0));
  // Wybór pozycji bezpłatnej jest ignorowany, a nie liczony.
  assert.deepEqual(resolveSelection({ free_thing: 3, report: 1 }, options), { report: 1 });
  assert.deepEqual(paidOptionsFromRows([rows[2]]), []);
});

test('niespójny wiersz katalogu unieważnia całość', () => {
  for (const bad of [
    null, 'x', [null], [{ ...rows[0], gross_minor: -1 }], [{ ...rows[0], gross_minor: 1.5 }],
    [{ ...rows[0], code: 'Report' }], [rows[0], rows[0]], [{ ...rows[0], name: '' }], [{ ...rows[0], unit: 5 }],
  ]) assert.equal(paidOptionsFromRows(bad), null);
  assert.equal(vatFromPackageRows([{ vat_basis_points: 2300 }, { vat_basis_points: 800 }]), null);
  assert.equal(vatFromPackageRows([]), null);
  assert.equal(vatFromPackageRows([{ vat_basis_points: 2300 }]), 2300);
});

test('suma opcji liczona z katalogu: netto jednostkowe, VAT raz od sumy', () => {
  const options = paidOptionsFromRows(rows);
  const price = priceSelection({ report: 2, ocr_page: 10 }, options, 2300);
  assert.equal(price.netMinor, 2 * 1000 + 10 * 6);
  assert.equal(price.vatMinor, Math.floor((2060 * 2300 * 2 + 10_000) / 20_000));
  assert.equal(price.grossMinor, price.netMinor + price.vatMinor);
  assert.deepEqual(price.lines.map(l => [l.code, l.quantity]), [['report', 2], ['ocr_page', 10]]);
  assert.equal(priceSelection({}, options, 2300).grossMinor, 0);
});

test('cena nie pochodzi z formularza: pola z kwotą i nieznane kody są ignorowane', () => {
  const options = paidOptionsFromRows(rows);
  const clean = priceSelection({ report: 1 }, options, 2300);
  const hostile = priceSelection({
    report: 1, price: 1, grossMinor: 1, gross_minor: 1, amount: 1, total: 1, unknown: 5, __proto__: { ocr_page: 9 },
  }, options, 2300);
  assert.deepEqual(hostile, clean);
  for (const q of [0, -1, 0.5, NaN, Infinity, '2', null, MAX_OPTION_QUANTITY + 1]) {
    assert.deepEqual(resolveSelection({ report: q }, options), {}, String(q));
  }
  assert.deepEqual(resolveSelection({ report: MAX_OPTION_QUANTITY }, options), { report: MAX_OPTION_QUANTITY });
  assert.deepEqual(resolveSelection('report', options), {});
  assert.throws(() => priceSelection({ report: 1 }, options, -1));
  assert.throws(() => priceSelection({ report: 1 }, options, 10_001));
});

// Prawdziwy silnik wyceny: suma opcji musi zgadzać się z jego wynikiem dla tych samych cen z katalogu.
const { quoteOffer } = transpile('../lib/pricing/quote-engine.ts', {});
const engineNet = (gross, vat) => Math.floor((gross * 10_000 * 2 + (10_000 + vat)) / (2 * (10_000 + vat)));

test('suma opcji zgadza się z silnikiem wyceny przy kilku stawkach VAT i ilościach', () => {
  const options = paidOptionsFromRows([
    { code: 'report', name: 'Raport', unit: 'raport', gross_minor: 1_230 },
    { code: 'ocr_page', name: 'OCR', unit: 'strona', gross_minor: 7 },
    { code: 'support_hours', name: 'Wsparcie', unit: 'godzina', gross_minor: 15_000 },
  ]);
  for (const vat of [2300, 800, 0, 777, 10_000]) {
    const offer = {
      versionId: 'w3', status: 'PUBLISHED', approved: true, currency: 'PLN', vatBasisPoints: vat,
      plans: [{ code: 'PRESELEKCJA', baseNetMinor: 0, commercialStatus: 'purchasable', cvIncluded: 60,
        cvPolicy: { quick: [60], range: null }, cvOverageRule: null, capabilityCode: null }],
      services: options.map(o => ({ code: o.code, name: o.name, technicalStatus: 'verified', min: 0, max: 10_000,
        step: 1, commercialStatus: 'purchasable', capabilityCode: null, dependencies: [], exclusions: [], defaultPriceRule: null })),
      planServices: options.map(o => ({ packageCode: 'PRESELEKCJA', serviceCode: o.code, allowed: true, visible: true,
        includedQuantity: 0, maxQuantity: 10_000, quantityStep: 1, extraAllowed: true, autoPurchase: true,
        commercialStatus: 'purchasable', overridePriceRule: { method: 'per_unit', unitMinor: engineNet(o.grossMinor, vat) } })),
      discounts: [],
    };
    for (const sel of [{ report: 1 }, { report: 3, ocr_page: 11 }, { ocr_page: 99 }, { report: 2, ocr_page: 5, support_hours: 4 }]) {
      const quote = quoteOffer(offer, {
        expectedVersionId: 'w3', packageCode: 'PRESELEKCJA', cvCount: 60,
        addons: Object.entries(sel).map(([serviceCode, quantity]) => ({ serviceCode, quantity })),
      }, new Set(), {});
      const mine = priceSelection(sel, options, vat);
      assert.equal(mine.netMinor, quote.netMinor, `netto, VAT ${vat}, ${JSON.stringify(sel)}`);
      assert.equal(mine.vatMinor, quote.vatMinor, `VAT, ${vat}`);
      assert.equal(mine.grossMinor, quote.grossMinor, `brutto, ${vat}`);
    }
  }
});

test('przy VAT dzielącym cenę bez reszty suma to zwykła suma cen brutto z katalogu', () => {
  const options = paidOptionsFromRows(rows.slice(0, 1));
  assert.equal(priceSelection({ report: 4 }, options, 2300).grossMinor, 4 * 1_230);
});
