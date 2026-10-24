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
const { quoteOffer, validateOfferForPublish, PricingError } = mod.exports;
const caps = new Set(['free_ready', 'screening_ready', 'verification_ready', 'ac_ready', 'reports_ready', 'voice_ready', 'tests_ready', 'consult_ready']);
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
  const preview = quote('PRESELEKCJA', [], 20, draft, caps, { allowDraft: true });
  assert.equal(preview.canPurchase, false);
  assert.deepEqual(preview.blockedReasons, ['DRAFT_PREVIEW']);
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
  error(() => quote('PRESELEKCJA', [{ serviceCode: 'report_ext', quantity: 2 }], 20, tooBig), 'AMOUNT_OUT_OF_RANGE');
  const bad = clone();
  bad.planServices.find(s => s.packageCode === 'PRESELEKCJA').overridePriceRule.unitMinor = -1;
  error(() => quote('PRESELEKCJA', [{ serviceCode: 'report_ext', quantity: 1 }], 20, bad), 'INVALID_RULE');
  // The whole catalog is validated at quote time, so an invalid rule fails even when not selected.
  error(() => quote('PRESELEKCJA', [], 20, bad), 'INVALID_RULE');
  bad.planServices.find(s => s.packageCode === 'PRESELEKCJA').overridePriceRule.unitMinor = 200;
  bad.discounts = [{ code: 'bad', method: 'percent', value: 12000, eligiblePackages: ['PRESELEKCJA'] }];
  error(() => quote('PRESELEKCJA', [], 20, bad), 'INVALID_DISCOUNT');
});

test('same addon can be disabled in one plan without affecting another', () => {
  const c = clone();
  Object.assign(c.planServices.find(s => s.packageCode === 'PRESELEKCJA' && s.serviceCode === 'report_ext'),
    { allowed: false, visible: false, autoPurchase: false });
  error(() => quote('PRESELEKCJA', [{ serviceCode: 'report_ext', quantity: 1 }], 20, c), 'ADDON_UNAVAILABLE');
  assert.equal(line(quote('WERYFIKACJA', [{ serviceCode: 'report_ext', quantity: 2 }], 20, c), 'report_ext').netMinor, 300);
});


test('unknown exclusion/dependency target cannot silently permit forbidden purchases', () => {
  const c=clone();
  c.services.find(s => s.code === 'consult').exclusions=['missing_service'];
  error(() => quote('WERYFIKACJA', [{serviceCode:'consult',quantity:1}],20,c), 'INVALID_CATALOG');
  const d=clone();
  d.services.find(s => s.code === 'check_plus').dependencies=['missing_service'];
  error(() => quote('WERYFIKACJA', [],20,d), 'INVALID_CATALOG');
});

test('catalog booleans cannot be coerced from strings', () => {
  for(const key of ['allowed','visible','extraAllowed','autoPurchase']) {
    const c=clone();
    c.planServices.find(l => l.packageCode==='PRESELEKCJA')[key]='false';
    error(() => quote('PRESELEKCJA', [{serviceCode:'report_ext',quantity:1}],20,c), 'INVALID_CATALOG');
  }
});

test('cross-realm compatible ReadonlySet contract and non-approved owner draft', () => {
  const other={size:caps.size,values:()=>caps.values(),has:x=>caps.has(x)};
  assert.equal(quote('PRESELEKCJA',[],20,offer,other).canPurchase,true);
  const bad={size:1,values:function*(){},has:()=>true};
  error(() => quote('PRESELEKCJA',[],20,offer,bad), 'INVALID_CAPABILITIES');
  const draft=clone();draft.status='DRAFT';draft.approved=false;
  error(() => quote('PRESELEKCJA',[],20,draft), 'OFFER_NOT_APPROVED');
  assert.equal(quote('PRESELEKCJA',[],20,draft,caps,{allowDraft:true}).canPurchase,false);
});

test('CV thresholds (tiered_flat): one amount per threshold, owner "progi" mode', () => {
  const c = clone();
  Object.assign(c.plans.find(p => p.code === 'PRESELEKCJA'), {
    baseNetMinor: 0, cvIncluded: 0,
    cvOverageRule: { method: 'tiered_flat', tiers: [
      { upTo: 30, amountMinor: 29_000 }, { upTo: 50, amountMinor: 30_000 },
      { upTo: 100, amountMinor: 31_000 }, { upTo: null, amountMinor: 32_000 }] },
  });
  assert.equal(quote('PRESELEKCJA', [], 10, c).netMinor, 29_000);
  assert.equal(quote('PRESELEKCJA', [], 30, c).netMinor, 29_000);
  assert.equal(quote('PRESELEKCJA', [], 35, c).netMinor, 30_000);
  assert.equal(quote('PRESELEKCJA', [], 100, c).netMinor, 31_000);
  assert.equal(quote('PRESELEKCJA', [], 150, c).netMinor, 32_000);
  assert.equal(line(quote('PRESELEKCJA', [], 50, c), 'cv').billed, 50);
});

test('bounded last tier: quote refuses uncovered quantity, publish refuses the catalog', () => {
  const c = clone();
  c.plans.find(p => p.code === 'PRESELEKCJA').cvOverageRule = { method: 'tiered_flat', tiers: [{ upTo: 50, amountMinor: 1000 }] };
  assert.equal(line(quote('PRESELEKCJA', [], 50, c), 'cv').netMinor, 1000);
  error(() => quote('PRESELEKCJA', [], 100, c), 'QUANTITY_OUT_OF_RANGE');
  error(() => validateOfferForPublish(c), 'TIER_COVERAGE');
  const g = clone();
  g.plans.find(p => p.code === 'PRESELEKCJA').cvOverageRule = { method: 'volume_tier', mode: 'graduated', tiers: [{ upTo: 10, unitMinor: 100 }, { upTo: 40, unitMinor: 50 }] };
  assert.equal(line(quote('PRESELEKCJA', [], 45, g), 'cv').netMinor, 10 * 100 + 15 * 50);
  error(() => quote('PRESELEKCJA', [], 65, g), 'QUANTITY_OUT_OF_RANGE');
});

test('add-on priced per unit or as one fixed amount, per package', () => {
  const c = clone();
  c.planServices.find(l => l.packageCode === 'WERYFIKACJA' && l.serviceCode === 'interview').overridePriceRule = { method: 'fixed', amountMinor: 4_000 };
  assert.equal(line(quote('WERYFIKACJA', [{ serviceCode: 'interview', quantity: 15 }], 20, c), 'interview').netMinor, 4_000);
  assert.equal(line(quote('ASSESSMENT_CENTER', [{ serviceCode: 'interview', quantity: 15 }], 20, c), 'interview').netMinor, 5 * 1000);
});

test('bundle and unknown methods are not part of v1', () => {
  for (const rule of [{ method: 'bundle', amountMinor: 1, covers: [{ serviceCode: 'skill_test', quantity: 1 }] }, { method: 'formula', expr: '1+1' }]) {
    const c = clone();
    c.services.find(s => s.code === 'consult').defaultPriceRule = rule;
    error(() => quote('PRESELEKCJA', [], 20, c), 'UNSUPPORTED_RULE');
    error(() => validateOfferForPublish(c), 'UNSUPPORTED_RULE');
  }
  const extraKey = clone();
  extraKey.services.find(s => s.code === 'consult').defaultPriceRule = { method: 'fixed', amountMinor: 1, unitMinor: 5 };
  error(() => quote('PRESELEKCJA', [], 20, extraKey), 'INVALID_RULE');
});

test('autoPurchase=false prices the add-on but blocks purchase with a stable reason', () => {
  const c = clone();
  c.planServices.find(l => l.packageCode === 'WERYFIKACJA' && l.serviceCode === 'consult').autoPurchase = false;
  const q = quote('WERYFIKACJA', [{ serviceCode: 'consult', quantity: 1 }], 20, c);
  assert.equal(line(q, 'consult').netMinor, 5000);
  assert.equal(q.canPurchase, false);
  assert.deepEqual(q.blockedReasons, ['ADDON_REQUIRES_OPERATOR:consult']);
  const ok = quote('WERYFIKACJA', [], 20, c);
  assert.equal(ok.canPurchase, true);
  assert.deepEqual(ok.blockedReasons, []);
});

test('contradictory plan-service flags are rejected', () => {
  const variants = [
    { autoPurchase: true, commercialStatus: 'on_request' },
    { allowed: false, autoPurchase: false, visible: true },
    { allowed: false, autoPurchase: true, visible: false },
    { commercialStatus: 'hidden', autoPurchase: false, visible: true },
  ];
  for (const v of variants) {
    const c = clone();
    Object.assign(c.planServices.find(l => l.packageCode === 'PRESELEKCJA'), v);
    error(() => quote('PRESELEKCJA', [], 20, c), 'CONTRADICTORY_FLAGS');
    error(() => validateOfferForPublish(c), 'CONTRADICTORY_FLAGS');
  }
});

test('full CV policy is validated even when the count is a quick option', () => {
  const c = clone();
  c.plans.find(p => p.code === 'PRESELEKCJA').cvPolicy = { quick: [20], range: { min: 35, max: 150, step: 0 } };
  error(() => quote('PRESELEKCJA', [], 20, c), 'INVALID_CV_POLICY');
  for (const quick of [[30, 20], [20, 20], [0], [2.5]]) {
    const d = clone();
    d.plans.find(p => p.code === 'PRESELEKCJA').cvPolicy = { quick, range: null };
    error(() => quote('PRESELEKCJA', [], 30, d), 'INVALID_CV_POLICY');
  }
  const e = clone();
  e.plans.find(p => p.code === 'FREE').cvIncluded = 6;
  error(() => quote('FREE', [], 5, e), 'INVALID_CV_POLICY');
});

test('plan status reasons: on_request and informational packages cannot be bought', () => {
  const c = clone();
  c.plans.find(p => p.code === 'PRESELEKCJA').commercialStatus = 'on_request';
  assert.deepEqual(quote('PRESELEKCJA', [], 20, c).blockedReasons, ['ON_REQUEST_PRICE:PRESELEKCJA']);
  c.plans.find(p => p.code === 'PRESELEKCJA').commercialStatus = 'informational';
  assert.deepEqual(quote('PRESELEKCJA', [], 20, c).blockedReasons, ['PACKAGE_NOT_PURCHASABLE']);
  const ready = new Set(['screening_ready']);
  const v = quote('WERYFIKACJA', [], 20, offer, ready);
  assert.ok(v.blockedReasons.includes('CAPABILITY_UNAVAILABLE:verification_ready'));
  assert.equal(v.canPurchase, v.blockedReasons.length === 0);
});

test('publish validator bounds the highest reachable quote per plan', () => {
  const max = validateOfferForPublish(offer);
  // PRESELEKCJA: base 10 000 + 130 CV × 75 + report_ext 30 × 200 = 25 750 net → 31 672.5 → 31 673 gross (half-up)
  assert.equal(max.PRESELEKCJA, 31_673);
  const big = clone();
  big.planServices.find(l => l.packageCode === 'PRESELEKCJA').overridePriceRule = { method: 'per_unit', unitMinor: 40_000_000_000 };
  error(() => validateOfferForPublish(big), 'AMOUNT_OUT_OF_RANGE');
  assert.equal(quote('PRESELEKCJA', [{ serviceCode: 'report_ext', quantity: 1 }], 20, big).netMinor, 10_000 + 40_000_000_000);
  const unpriced = clone();
  unpriced.plans.find(p => p.code === 'PRESELEKCJA').cvOverageRule = null;
  error(() => validateOfferForPublish(unpriced), 'UNPRICED');
  assert.equal(quote('PRESELEKCJA', [], 20, unpriced).netMinor, 10_000);
  error(() => quote('PRESELEKCJA', [], 30, unpriced), 'UNPRICED');
});

test('dependency cycles and dependency/exclusion conflicts are rejected', () => {
  const c = clone();
  c.services.find(s => s.code === 'skill_test').dependencies = ['check_plus'];
  error(() => quote('PRESELEKCJA', [], 20, c), 'DEPENDENCY_CYCLE');
  const d = clone();
  d.services.find(s => s.code === 'check_plus').exclusions = ['skill_test'];
  error(() => quote('PRESELEKCJA', [], 20, d), 'INVALID_CATALOG');
});
