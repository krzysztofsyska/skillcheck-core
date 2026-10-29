import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

// All amounts here are SYNTHETIC test values, not approved prices (except the published PRESELEKCJA 300 zł).
const loaded = new Map();
function load(path) {
  if (loaded.has(path)) return loaded.get(path).exports;
  const mod = new Module(path);
  mod.filename = path;
  mod.paths = Module._nodeModulePaths(dirname(path));
  const base = createRequire(path);
  mod.require = id => id.startsWith('.') ? load(resolve(dirname(path), id.endsWith('.ts') ? id : id + '.ts')) : base(id);
  loaded.set(path, mod);
  mod._compile(ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, path);
  return mod.exports;
}
const calc = load(new URL('../lib/pricing/internal-calculator.ts', import.meta.url).pathname);
const { defaultConfig, parseConfig, toOffer, calculate, validateConfig, netFromGross, parsePln, formatPln, cvChoices } = calc;
const scenario = (packageCode, cvCount, quantities = {}, ordersPerMonth = 1) => ({ packageCode, cvCount, quantities, ordersPerMonth });

test('default PRESELEKCJA 60 CV is quoted at the published 300 zł gross', () => {
  const r = calculate(defaultConfig(), scenario('PRESELEKCJA', 60));
  assert.equal(r.ok, true);
  assert.equal(r.quote.grossMinor, 30_000);
  assert.equal(r.quote.netMinor, 24_390);
  assert.equal(r.quote.vatMinor, 5_610);
  assert.deepEqual(r.quote.blockedReasons, ['DRAFT_PREVIEW']);
});

test('default configuration passes the same publish validation as the real catalog', () => {
  const v = validateConfig(defaultConfig());
  assert.equal(v.ok, true);
  assert.equal(v.maxGross.PRESELEKCJA, 30_000);
});

test('costs and margin come only from the internal config and never enter the offer', () => {
  const c = defaultConfig();
  c.cvCostMinor = 50; c.paymentFeeBasisPoints = 150; c.fixedCostPerOrderMinor = 1_000;
  const offerText = JSON.stringify(toOffer(c));
  assert.doesNotMatch(offerText, /cost|Cost|margin|fee/);
  const r = calculate(c, scenario('PRESELEKCJA', 60, {}, 10));
  // 60 CV × 0,50 zł + 1,5% of 300 zł + 10 zł fixed
  assert.equal(r.costMinor, 3_000 + 450 + 1_000);
  assert.equal(r.marginMinor, 24_390 - 4_450);
  assert.equal(r.marginBasisPoints, Math.round((24_390 - 4_450) * 10_000 / 24_390));
  assert.equal(r.monthly.marginMinor, (24_390 - 4_450) * 10);
  assert.equal(r.monthly.grossMinor, 300_000);
});

test('CV overage and per-package add-on prices go through the quote engine', () => {
  const c = defaultConfig();
  c.packages.PRESELEKCJA.overageGrossPerCvMinor = 123; // 1,23 zł gross → 1,00 zł net
  const interview = c.addons.find(a => a.code === 'interview');
  interview.packages.PRESELEKCJA.unitGrossMinor = 1_230;
  interview.packages.WERYFIKACJA.unitGrossMinor = 2_460;
  interview.unitCostMinor = 200;
  const p = calculate(c, scenario('PRESELEKCJA', 100, { interview: 3 }));
  assert.equal(p.quote.lines.find(l => l.kind === 'cv_overage').netMinor, 40 * 100);
  assert.equal(p.quote.lines.find(l => l.code === 'interview').netMinor, 3 * 1_000);
  // WERYFIKACJA includes 20 interviews: only the extra 2 are billed, but all 22 are delivered (cost).
  const w = calculate(c, scenario('WERYFIKACJA', 60, { interview: 22 }));
  const line = w.quote.lines.find(l => l.code === 'interview');
  assert.equal(line.included, 20);
  assert.equal(line.billed, 2);
  assert.equal(line.netMinor, 2 * 2_000);
  assert.equal(w.costs.find(x => x.code === 'interview').costMinor, 22 * 200);
});

test('fewer requested add-ons than included are raised to the included quantity', () => {
  const r = calculate(defaultConfig(), scenario('WERYFIKACJA', 60, { interview: 5 }));
  assert.equal(r.ok, true);
  assert.equal(r.quote.lines.find(l => l.code === 'interview').quantity, 20);
});

test('invalid choices return stable engine codes instead of throwing', () => {
  assert.deepEqual(calculate(defaultConfig(), scenario('PRESELEKCJA', 61)), { ok: false, code: 'PLAN_UNAVAILABLE' });
  const c = defaultConfig();
  c.addons.find(a => a.code === 'sms').packages.PRESELEKCJA.enabled = false;
  const r = calculate(c, scenario('PRESELEKCJA', 60, { sms: 5 }));
  assert.equal(r.ok, true);
  assert.equal(r.quote.lines.some(l => l.code === 'sms'), false);
  c.packages.PRESELEKCJA.grossMinor = 2_000_000_000_000;
  assert.equal(validateConfig(c).ok, false);
});

test('cvIncluded is always selectable', () => {
  assert.deepEqual(cvChoices({ grossMinor: 0, cvIncluded: 70, cvOptions: [100, 30], overageGrossPerCvMinor: 0 }), [30, 70, 100]);
});

test('gross to net conversion, PLN parsing and formatting', () => {
  assert.equal(netFromGross(30_000, 2300), 24_390);
  assert.equal(netFromGross(123, 2300), 100);
  assert.equal(netFromGross(0, 2300), 0);
  assert.equal(parsePln('1 234,56'), 123_456);
  assert.equal(parsePln('300'), 30_000);
  assert.equal(parsePln('12.5'), 1_250);
  assert.equal(parsePln('-1'), null);
  assert.equal(parsePln('1,234'), null);
  assert.equal(formatPln(123_456), '1 234,56 zł');
  assert.equal(formatPln(-50), '−0,50 zł');
});

test('stored or imported configurations are parsed strictly', () => {
  const c = defaultConfig();
  assert.deepEqual(parseConfig(JSON.parse(JSON.stringify(c))), c);
  assert.equal(parseConfig(null), null);
  assert.equal(parseConfig({ ...c, version: 2 }), null);
  assert.equal(parseConfig({ ...c, vatBasisPoints: -1 }), null);
  const bad = structuredClone(c); bad.addons[0].packages.FREE.enabled = 'true';
  assert.equal(parseConfig(bad), null);
  const dup = structuredClone(c); dup.addons.push(structuredClone(dup.addons[0]));
  assert.equal(parseConfig(dup), null);
  const missing = structuredClone(c); delete missing.packages.WERYFIKACJA;
  assert.equal(parseConfig(missing), null);
});

test('page is owner-gated, server-only and noindex', () => {
  const page = readFileSync(new URL('../app/operator/pricing/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /import 'server-only'/);
  assert.match(page, /await salesOperator\(\)/);
  assert.match(page, /robots: \{ index: false, follow: false \}/);
  const client = readFileSync(new URL('../app/operator/pricing/internal-calculator.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(client, /fetch\(|supabase|process\.env/);
});
