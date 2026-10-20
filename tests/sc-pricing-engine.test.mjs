import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import ts from 'typescript';

// All amounts and entitlements in this file are SYNTHETIC, not approved prices.
const path = new URL('../lib/pricing/quote-engine.ts', import.meta.url).pathname;
const mod = new Module(path);
mod.filename = path;
mod.paths = Module._nodeModulePaths(new URL('../', import.meta.url).pathname);
mod.require = createRequire(path);
mod._compile(ts.transpileModule(readFileSync(path, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, path);
const { quoteOffer, PricingError } = mod.exports;
const caps = new Set(['free_ready', 'screening_ready', 'verification_ready', 'ac_ready', 'reports_ready', 'voice_ready', 'tests_ready', 'consult_ready', 'bundle_ready']);
const plans = [
  ['FREE', 0, 5, 'free_ready'],
  ['PRESELEKCJA', 10_000, 20, 'screening_ready'],
  ['WERYFIKACJA', 20_000, 20, 'verification_ready'],
  ['ASSESSMENT_CENTER', 50_000, 20, 'ac_ready'],
].map(([code, baseNetMinor, cvIncluded, capabilityCode]) => ({
  code, baseNetMinor, cvIncluded, capabilityCode, commercialStatus: 'purchasable',
  cvOverageRule: { method: 'per_unit', unitMinor: 75 },
  cvPolicy: code === 'FREE' ? { quick: [1, 2, 3, 4, 5], range: null } :
    { quick: [10, 20, 30], range: { min: 35, max: 150, step: 5 } },
}));
const services = [
  { code: 'report_ext', capabilityCode: 'reports_ready', defaultPriceRule: { method: 'per_unit', unitMinor: 500 } },
  { code: 'interview', capabilityCode: 'voice_ready', defaultPriceRule: { method: 'per_unit', unitMinor: 1000 } },
  { code: 'skill_test', capabilityCode: 'tests_ready', defaultPriceRule: { method: 'volume_tier', mode: 'graduated', tiers: [{ upTo: 2, unitMinor: 300 }, { upTo: null, unitMinor: 100 }] } },
  { code: 'consult', capabilityCode: 'consult_ready', defaultPriceRule: { method: 'fixed', amountMinor: 5000 }, exclusions: ['skill_test'] },
  { code: 'check_plus', capabilityCode: 'reports_ready', defaultPriceRule: { method: 'per_unit', unitMinor: 700 }, dependencies: ['skill_test'] },
  { code: 'bundle_rt', capabilityCode: 'bundle_ready', defaultPriceRule: { method: 'bundle', amountMinor: 1200, covers: [{ serviceCode: 'report_ext', quantity: 1 }, { serviceCode: 'skill_test', quantity: 1 }] } },
].map(s => ({ name: s.code, technicalStatus: 'verified', commercialStatus: 'purchasable', dependencies: [], exclusions: [], ...s }));
const link = (packageCode, serviceCode, includedQuantity = 0, overridePriceRule = undefined) => ({
  packageCode, serviceCode, allowed: true, visible: true, includedQuantity, maxQuantity: 30, quantityStep: 1,
  extraAllowed: true, autoPurchase: true, commercialStatus: 'purchasable', overridePriceRule,
});
const offer = {
  versionId: 'version-test-1', status: 'PUBLISHED', approved: true, currency: 'PLN', vatBasisPoints: 2300,
  plans, services, discounts: [], planServices: [
    link('PRESELEKCJA', 'report_ext', 0, { method: 'per_unit', unitMinor: 200 }),
    link('WERYFIKACJA', 'report_ext', 1, { method: 'per_unit', unitMinor: 300 }),
    link('ASSESSMENT_CENTER', 'report_ext', 2, { method: 'per_unit', unitMinor: 150 }),
    link('WERYFIKACJA', 'interview', 10),
    link('ASSESSMENT_CENTER', 'interview', 10),
    link('WERYFIKACJA', 'skill_test'),
    link('ASSESSMENT_CENTER', 'skill_test'),
    link('WERYFIKACJA', 'consult'),
    link('WERYFIKACJA', 'check_plus'),
    link('ASSESSMENT_CENTER', 'bundle_rt'),
  ],
};
const request = (packageCode, addons = [], cvCount = 20) => ({ expectedVersionId: offer.versionId, packageCode, cvCount, addons });
const clone = () => structuredClone(offer);
const quote = (p, addons = [], cvCount = 20, o = offer, ready = caps, options) => quoteOffer(o, request(p, addons, cvCount), ready, options);
const line = (q, code) => q.lines.find(l => l.code === code);
const error = (fn, code) => assert.throws(fn, e => e instanceof PricingError && e.code === code);

test('all three paid plans have independently priced add-ons, no hardcoded frontend list', () => {
  const p = quote('PRESELEKCJA', [{ serviceCode: 'report_ext', quantity: 2 }]);
  const w = quote('WERYFIKACJA', [{ serviceCode: 'report_ext', quantity: 2 }]);
  const ac = quote('ASSESSMENT_CENTER', [{ serviceCode: 'report_ext', quantity: 3 }]);
  assert.equal(line(p, 'report_ext').netMinor, 400);
  assert.equal(line(w, 'report_ext').netMinor, 300);
  assert.equal(line(ac, 'report_ext').netMinor, 150);
  assert.equal(line(w, 'report_ext').included, 1);
  assert.equal(line(ac, 'report_ext').included, 2);
  assert.equal(p.netMinor, 10_400);
  assert.equal(p.vatMinor, 2392);
  assert.equal(p.grossMinor, 12_792);
  assert.equal(p.canPurchase, true);
});

test('included services are delivered without double charging and CV overage is separate', () => {
  const w = quote('WERYFIKACJA', [], 30);
  assert.equal(line(w, 'report_ext').netMinor, 0);
  assert.equal(line(w, 'interview').netMinor, 0);
  assert.equal(line(w, 'interview').included, 10);
  assert.equal(line(w, 'cv').billed, 10);
  assert.equal(line(w, 'cv').netMinor, 750);
  const more = quote('WERYFIKACJA', [{ serviceCode: 'interview', quantity: 12 }], 30);
  assert.equal(line(more, 'interview').netMinor, 2000);
  assert.equal(more.netMinor, 22_750);
});

test('bundle adds and covers contents once, no repeat charge', () => {
  const q = quote('ASSESSMENT_CENTER', [{ serviceCode: 'bundle_rt', quantity: 1 }]);
  assert.equal(line(q, 'bundle_rt').netMinor, 1200);
  assert.equal(line(q, 'report_ext').netMinor, 0);
  assert.equal(line(q, 'skill_test').netMinor, 0);
  assert.equal(q.netMinor, 51_200);
  const q2 = quote('ASSESSMENT_CENTER', [{ serviceCode: 'bundle_rt', quantity: 1 }, { serviceCode: 'report_ext', quantity: 5 }]);
  assert.equal(line(q2, 'report_ext').billed, 2);
  assert.equal(line(q2, 'report_ext').netMinor, 300);
});

test('tier graduated vs all units use exact integer arithmetic', () => {
  const q = quote('WERYFIKACJA', [{ serviceCode: 'skill_test', quantity: 3 }]);
  assert.equal(line(q, 'skill_test').netMinor, 700);
  const another = clone();
  another.services.find(s => s.code === 'skill_test').defaultPriceRule.mode = 'all_units';
  assert.equal(line(quote('WERYFIKACJA', [{ serviceCode: 'skill_test', quantity: 3 }], 20, another), 'skill_test').netMinor, 300);
});

test('fixed fee once; percent and fixed discounts are server-configured, VAT rounds half up', () => {
  const c = clone();
  c.discounts.push({ code: 'promo_fixed', method: 'amount', value: 300, eligiblePackages: ['WERYFIKACJA'] });
  c.discounts.push({ code: 'promo_percent', method: 'percent', value: 1000, eligiblePackages: ['WERYFIKACJA'] });
  const q = quote('WERYFIKACJA', [{ serviceCode: 'consult', quantity: 2 }], 20, c);
  assert.equal(line(q, 'consult').netMinor, 5000);
  assert.equal(q.subtotalNetMinor, 25000);
  assert.equal(q.discountMinor, 2770);
  assert.equal(q.netMinor, 22230);
  assert.equal(q.vatMinor, 5113);
  assert.equal(q.grossMinor, 27343);
  const half = clone();
  half.plans.find(p => p.code === 'PRESELEKCJA').baseNetMinor = 5;
  half.vatBasisPoints = 1000;
  assert.equal(quote('PRESELEKCJA', [], 20, half).vatMinor, 1); // 0.5 grosza rounds up
});

test('CV counts, FREE trial limit and steps obey per-plan policy', () => {
  assert.equal(quote('FREE', [], 5).grossMinor, 0);
  error(() => quote('FREE', [], 10), 'PLAN_UNAVAILABLE');
  assert.equal(quote('PRESELEKCJA', [], 35).netMinor, 11125);
  error(() => quote('PRESELEKCJA', [], 34), 'PLAN_UNAVAILABLE');
  error(() => quote('PRESELEKCJA', [], 151), 'PLAN_UNAVAILABLE');
  error(() => quote('PRESELEKCJA', [], -5), 'INVALID_REQUEST');
});

test('out-of-package addon and forbidden quantity are refused', () => {
  error(() => quote('PRESELEKCJA', [{ serviceCode: 'skill_test', quantity: 1 }]), 'ADDON_UNAVAILABLE');
  error(() => quote('PRESELEKCJA', [{ serviceCode: 'report_ext', quantity: 31 }]), 'INVALID_QUANTITY');
  error(() => quote('WERYFIKACJA', [{ serviceCode: 'interview', quantity: 9 }]), 'INVALID_QUANTITY');
  error(() => quote('WERYFIKACJA', [{ serviceCode: 'interview', quantity: 11.5 }]), 'INVALID_ADDON');
});

test('dependencies and exclusions apply per-package across included services', () => {
  error(() => quote('WERYFIKACJA', [{ serviceCode: 'check_plus', quantity: 1 }]), 'UNMET_DEPENDENCY');
  error(() => quote('WERYFIKACJA', [{ serviceCode: 'consult', quantity: 1 }, { serviceCode: 'skill_test', quantity: 1 }]), 'MUTUAL_EXCLUSION');
  assert.equal(line(quote('WERYFIKACJA', [{ serviceCode: 'check_plus', quantity: 1 }, { serviceCode: 'skill_test', quantity: 1 }]), 'check_plus').netMinor, 700);
});

test('unapproved, absent price and stale version fail closed', () => {
  const c = clone();
  c.approved = false;
  error(() => quote('PRESELEKCJA', [], 20, c), 'OFFER_NOT_APPROVED');
  c.approved = true;
  c.plans.find(p => p.code === 'PRESELEKCJA').baseNetMinor = null;
  error(() => quote('PRESELEKCJA', [], 20, c), 'UNPRICED');
  error(() => quoteOffer(offer, { ...request('PRESELEKCJA'), expectedVersionId: 'old' }, caps), 'STALE_VERSION');
  const draft = clone();
  draft.status = 'DRAFT';
  error(() => quote('PRESELEKCJA', [], 20, draft), 'OFFER_NOT_APPROVED');
  assert.equal(quote('PRESELEKCJA', [], 20, draft, caps, { allowDraft: true }).canPurchase, false);
});

test('browser-provided prices, discounts, duplicate selection and unknown code fail', () => {
  error(() => quoteOffer(offer, { ...request('PRESELEKCJA'), price: 1 }, caps), 'INVALID_REQUEST');
  error(() => quoteOffer(offer, { ...request('PRESELEKCJA'), discount: { amountMinor: 999999 } }, caps), 'INVALID_REQUEST');
  error(() => quote('PRESELEKCJA', [{ serviceCode: 'report_ext', quantity: 1 }, { serviceCode: 'report_ext', quantity: 2 }]), 'INVALID_ADDON');
  error(() => quote('PRESELEKCJA', [{ serviceCode: 'ghost', quantity: 1 }]), 'ADDON_UNAVAILABLE');
});

test('technical readiness is from trusted runtime capabilities, not commercial status', () => {
  const ready = new Set(['screening_ready', 'reports_ready']);
  assert.equal(quote('WERYFIKACJA', [], 20, offer, ready).canPurchase, false);
  const v = quote('WERYFIKACJA', [{ serviceCode: 'skill_test', quantity: 1 }], 20, offer, ready);
  assert.equal(v.canPurchase, false);
  assert.ok(v.unavailableCapabilities.includes('tests_ready'));
  const c = clone();
  c.services.find(s => s.code === 'report_ext').technicalStatus = 'prototype';
  assert.equal(quote('PRESELEKCJA', [{ serviceCode: 'report_ext', quantity: 1 }], 20, c).canPurchase, false);
});

test('overflow, invalid rule and malicious discount cannot become order totals', () => {
  const tooBig = clone();
  tooBig.plans.find(p => p.code === 'PRESELEKCJA').baseNetMinor = 1_000_000_000_000;
  tooBig.planServices.find(s => s.packageCode === 'PRESELEKCJA').overridePriceRule.unitMinor = 1_000_000_000_000;
  error(() => quote('PRESELEKCJA', [{ serviceCode: 'report_ext', quantity: 2 }], 20, tooBig), 'PRICE_OVERFLOW');
  const bad = clone();
  bad.planServices.find(s => s.packageCode === 'PRESELEKCJA').overridePriceRule.unitMinor = -1;
  error(() => quote('PRESELEKCJA', [{ serviceCode: 'report_ext', quantity: 1 }], 20, bad), 'INVALID_RULE');
  bad.discounts = [{ code: 'bad', method: 'percent', value: 12000, eligiblePackages: ['PRESELEKCJA'] }];
  error(() => quote('PRESELEKCJA', [], 20, bad), 'INVALID_DISCOUNT');
});

test('same addon can be disabled in one plan without affecting another', () => {
  const c = clone();
  c.planServices.find(s => s.packageCode === 'PRESELEKCJA' && s.serviceCode === 'report_ext').allowed = false;
  error(() => quote('PRESELEKCJA', [{ serviceCode: 'report_ext', quantity: 1 }], 20, c), 'ADDON_UNAVAILABLE');
  assert.equal(line(quote('WERYFIKACJA', [{ serviceCode: 'report_ext', quantity: 2 }], 20, c), 'report_ext').netMinor, 300);
});
