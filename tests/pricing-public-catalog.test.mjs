// SC-PRICING-W4 — ceny pakietów na publicznej stronie z katalogu, za flagą domyślnie wyłączoną.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire, Module } from 'node:module';
import ts from 'typescript';
import {
  formatPln, freeLabel, grossLabel, isPublicCatalogEnabled, publicPricesFromRows, substituteQuotedPrice,
} from '../lib/pricing/public-catalog.ts';
import { preselekcjaOffer, freeOffer } from '../lib/preselekcja-offer.ts';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const cennik = read('docs/cennik-2026-11-02.md');
const migration = read('supabase/migrations/20261104080000_pricing_catalog.sql');

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

const catalogModule = () => transpile('../lib/pricing/public-catalog.ts', {});
const pkg = (package_code, gross_minor, extra = {}) => ({
  package_code, gross_minor, cv_included: 60, cv_step: 5, cv_max: 60,
  overage_gross_per_cv_minor: 0, sellable: true, vat_basis_points: 2300, ...extra,
});
const rows = () => [
  pkg('FREE', 0, { cv_included: 5 }),
  pkg('PRESELEKCJA', 30000),
  pkg('WERYFIKACJA', 61500, { sellable: false }),
  pkg('ASSESSMENT_CENTER', 149900, { sellable: false }),
];
const withPkg = (code, patch) => rows().map(r => (r.package_code === code ? { ...r, ...patch } : r));

test('flaga: wyłączona domyślnie, włącza ją wyłącznie dokładne „true”', () => {
  for (const v of [undefined, '', 'false', 'TRUE', 'True', '1', 'yes', ' true', 'true ']) {
    assert.equal(isPublicCatalogEnabled({ PRICING_PUBLIC_CATALOG_ENABLED: v }), false, String(v));
  }
  assert.equal(isPublicCatalogEnabled({}), false);
  assert.equal(isPublicCatalogEnabled({ PRICING_PUBLIC_CATALOG_ENABLED: 'true' }), true);
});

test('flaga wyłączona: loader nie sięga do bazy i zwraca null', async () => {
  let calls = 0;
  const { loadPublicCatalogPrices } = transpile('../lib/pricing/public-catalog-server.ts', {
    './public-catalog': catalogModule(),
    '../supabase/server': { createClient: async () => { calls += 1; throw new Error('baza nie powinna być wołana'); } },
  });
  for (const env of [{}, { PRICING_PUBLIC_CATALOG_ENABLED: 'false' }, { PRICING_PUBLIC_CATALOG_ENABLED: 'TRUE' }]) {
    assert.equal(await loadPublicCatalogPrices(env), null);
  }
  assert.equal(calls, 0);
});

test('flaga włączona: loader czyta tylko publiczne RPC pakietów; błąd lub zły wiersz = null', async () => {
  const run = async client => {
    const names = [];
    const { loadPublicCatalogPrices } = transpile('../lib/pricing/public-catalog-server.ts', {
      './public-catalog': catalogModule(),
      '../supabase/server': { createClient: async () => ({ rpc: async n => { names.push(n); return client(n); } }) },
    });
    return { result: await loadPublicCatalogPrices({ PRICING_PUBLIC_CATALOG_ENABLED: 'true' }), names };
  };
  const ok = await run(() => ({ data: rows(), error: null }));
  assert.deepEqual(ok.names, ['pricing_published_packages']);
  assert.deepEqual({ ...ok.result }, { FREE: 0, PRESELEKCJA: 30000, WERYFIKACJA: 61500, ASSESSMENT_CENTER: 149900 });
  assert.equal((await run(() => ({ data: null, error: { message: 'x' } }))).result, null);
  assert.equal((await run(() => ({ data: [], error: null }))).result, null);
  assert.equal((await run(() => { throw new Error('sieć'); })).result, null);
});

test('kontrakt: komplet czterech pakietów, jedna stawka VAT, FREE = 0, płatne > 0', () => {
  assert.ok(publicPricesFromRows(rows()));
  const bad = [
    null, {}, [], rows().slice(1),
    [...rows(), pkg('FREE', 0)],
    withPkg('PRESELEKCJA', { package_code: 'FREE' }),
    withPkg('PRESELEKCJA', { package_code: 'VOICEBOT' }),
    withPkg('PRESELEKCJA', { gross_minor: 0 }),
    withPkg('FREE', { gross_minor: 100 }),
    withPkg('PRESELEKCJA', { gross_minor: '30000' }),
    withPkg('PRESELEKCJA', { gross_minor: 299.5 }),
    withPkg('PRESELEKCJA', { gross_minor: -1 }),
    withPkg('PRESELEKCJA', { vat_basis_points: 800 }),
    withPkg('PRESELEKCJA', { sellable: 'yes' }),
    rows().map(({ cv_max, ...r }) => r),
    [...rows().slice(1), 'FREE'],
  ];
  bad.forEach((b, i) => assert.equal(publicPricesFromRows(b), null, `przypadek ${i}`));
});

test('formatowanie: identyczne z zapisem na stronie dziś', () => {
  assert.equal(formatPln(30000), '300');
  assert.equal(formatPln(149900), '1 499');
  assert.equal(formatPln(29999), '299,99');
  assert.equal(formatPln(100000000), '1 000 000');
  assert.equal(grossLabel(30000), '300 zł brutto');
  assert.equal(freeLabel(0), '0 zł');
});

test('wartości katalogu (migracja) = cennik 2026-11-02 = ceny statyczne strony', () => {
  const seeded = Object.fromEntries([...migration.matchAll(/\(version_id, '(FREE|PRESELEKCJA|WERYFIKACJA|ASSESSMENT_CENTER)', (\d+),/g)].map(m => [m[1], Number(m[2])]));
  assert.deepEqual(seeded, { FREE: 0, PRESELEKCJA: 30000, WERYFIKACJA: 61500, ASSESSMENT_CENTER: 149900 });
  // cennik-2026-11-02.md, tabela pakietów
  for (const [name, gross] of [['PRESELEKCJA', '300'], ['WERYFIKACJA', '615'], ['ASSESSMENT CENTER', '1 499']]) {
    assert.match(cennik, new RegExp(`\\| ${name} \\| ${gross} zł \\|`));
  }
  assert.match(cennik, /\| FREE \| 0 zł \|/);
  // strona dziś
  assert.equal(grossLabel(seeded.PRESELEKCJA), `${preselekcjaOffer.grossPln} zł brutto`);
  assert.equal(freeLabel(seeded.FREE), `${freeOffer.grossPln} zł`);
  const future = read('app/components/marketing/future-offers.ts');
  assert.ok(future.includes(`price: "${grossLabel(seeded.WERYFIKACJA)}"`));
  assert.ok(future.includes(`price: "${grossLabel(seeded.ASSESSMENT_CENTER)}"`));
  // wiersze katalogu → liczby identyczne z tym, co strona pokazuje bez flagi
  assert.deepEqual({ ...publicPricesFromRows(rows()) }, seeded);
});

test('strona: flaga wyłączona = ceny dotychczasowe, jedno wywołanie loadera, brak cen wpisanych w nowym kodzie', () => {
  const home = read('app/components/marketing/home-page.tsx');
  assert.equal((home.match(/loadPublicCatalogPrices\(/g) ?? []).length, 1);
  assert.match(home, /const preselekcjaPrice = prices \? grossLabel\(prices\.PRESELEKCJA\) : staticPreselekcjaPrice;/);
  assert.match(home, /prices=\{prices\}/);
  const cmp = read('app/components/marketing/package-comparison.tsx');
  assert.match(cmp, /prices \? freeLabel\(prices\.FREE\) : staticFreePrice/);
  assert.match(cmp, /prices \? grossLabel\(prices\.PRESELEKCJA\) : staticPreselekcjaPrice/);
  assert.match(cmp, /futurePrice\(stage\.name, stage\.price\)/);
  assert.match(cmp, /\{futureResult\(stage\)\}/);
  for (const file of ['lib/pricing/public-catalog.ts', 'lib/pricing/public-catalog-server.ts']) {
    assert.doesNotMatch(read(file).replace(/\/\*[\s\S]*?\*\//g, ''), /\b(30000|61500|149900|615|1 499)\b/, file);
  }
});

test('voicebot nie pojawia się w kodzie nowego modułu', () => {
  for (const file of ['lib/pricing/public-catalog.ts', 'lib/pricing/public-catalog-server.ts']) {
    assert.doesNotMatch(read(file), /voicebot|rozmow[ay] z botem/i);
  }
});

test('warunki ASSESSMENT CENTER: z flagą kwota w tekście = cena z katalogu, bez flagi bez zmian', () => {
  const future = read('app/components/marketing/future-offers.ts');
  const staticPrice = /name: "ASSESSMENT CENTER"[\s\S]*?price: "([^"]+)"/.exec(future)[1];
  const result = /name: "ASSESSMENT CENTER"[\s\S]*?result: "([^"]+)"/.exec(future)[1];
  assert.ok(result.includes(staticPrice.replace(/ brutto$/, '')));
  const changed = substituteQuotedPrice(result, staticPrice, 159900);
  assert.ok(changed.includes('nie jest wliczone w 1 599 zł'));
  assert.ok(!changed.includes('1 499'));
  // ta sama kwota = tekst identyczny
  assert.equal(substituteQuotedPrice(result, staticPrice, 149900), result);
  const cmp = read('app/components/marketing/package-comparison.tsx');
  assert.match(cmp, /if \(!prices \|\| stage\.name !== "ASSESSMENT CENTER"\) return stage\.result;/);
});
