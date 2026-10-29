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
].map(s => ({ name: s.code, technicalStatus: 'verified', commercialStatus: 'purchasable', dependencies: [], exclusions: [], min: 0, max: 30, step: 1, ...s }));
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

test('publish bound uses every reachable tier maximum, not only the largest quantity', () => {
  const c = clone();
  Object.assign(c.plans.find(p => p.code === 'PRESELEKCJA'), {
    cvIncluded: 0, cvPolicy: { quick: [2, 3], range: null },
    cvOverageRule: { method: 'volume_tier', mode: 'all_units', tiers: [{ upTo: 2, unitMinor: 1_000_000_000_000 }, { upTo: null, unitMinor: 1 }] },
  });
  error(() => validateOfferForPublish(c), 'AMOUNT_OUT_OF_RANGE');
  error(() => quote('PRESELEKCJA', [], 2, c), 'AMOUNT_OUT_OF_RANGE');
  assert.equal(line(quote('PRESELEKCJA', [], 3, c), 'cv').netMinor, 3);
});

test('publish bound ignores quantities that the step makes unselectable', () => {
  const c = clone();
  Object.assign(c.planServices.find(l => l.packageCode === 'PRESELEKCJA'), {
    includedQuantity: 0, quantityStep: 10, maxQuantity: 20,
    overridePriceRule: { method: 'tiered_flat', tiers: [{ upTo: 9, amountMinor: 1_000_000_000_000 }, { upTo: 20, amountMinor: 1 }] },
  });
  assert.doesNotThrow(() => validateOfferForPublish(c));
  assert.equal(line(quote('PRESELEKCJA', [{ serviceCode: 'report_ext', quantity: 10 }], 20, c), 'report_ext').netMinor, 1);
  // Gaps in CV policies are also skipped: quick 10/20 never reach the 11..19 tier.
  const d = clone();
  Object.assign(d.plans.find(p => p.code === 'PRESELEKCJA'), {
    cvIncluded: 0, cvPolicy: { quick: [10, 20], range: null },
    cvOverageRule: { method: 'tiered_flat', tiers: [{ upTo: 10, amountMinor: 5 }, { upTo: 19, amountMinor: 1_000_000_000_000 }, { upTo: null, amountMinor: 7 }] },
  });
  assert.doesNotThrow(() => validateOfferForPublish(d));
});

test('publish bound applies eligible discounts before VAT, like quoting', () => {
  const c = clone();
  const p = c.plans.find(x => x.code === 'PRESELEKCJA');
  Object.assign(p, { baseNetMinor: 900_000_000_000, cvIncluded: 30, cvPolicy: { quick: [10, 20, 30], range: null } });
  c.planServices = c.planServices.filter(l => l.packageCode !== 'PRESELEKCJA');
  c.discounts = [{ code: 'half', method: 'percent', value: 5000, eligiblePackages: ['PRESELEKCJA'] }];
  assert.equal(validateOfferForPublish(c).PRESELEKCJA, 553_500_000_000);
  assert.equal(quote('PRESELEKCJA', [], 30, c).grossMinor, 553_500_000_000);
});

test('publish bound respects exclusions: mutually exclusive add-ons are not summed', () => {
  const c = clone();
  const pre = c.plans.find(p => p.code === 'PRESELEKCJA');
  Object.assign(pre, { baseNetMinor: 0, cvIncluded: 30, cvPolicy: { quick: [10, 20, 30], range: null } });
  c.services.push(
    { code: 'opt_a', name: 'A', min: 0, max: 1, step: 1, technicalStatus: 'verified', commercialStatus: 'purchasable', capabilityCode: 'reports_ready', dependencies: [], exclusions: ['opt_b'], defaultPriceRule: { method: 'fixed', amountMinor: 500_000_000_000 } },
    { code: 'opt_b', name: 'B', min: 0, max: 1, step: 1, technicalStatus: 'verified', commercialStatus: 'purchasable', capabilityCode: 'reports_ready', dependencies: [], exclusions: [], defaultPriceRule: { method: 'fixed', amountMinor: 500_000_000_000 } });
  c.planServices = c.planServices.filter(l => l.packageCode !== 'PRESELEKCJA');
  c.planServices.push({ ...link('PRESELEKCJA', 'opt_a'), maxQuantity: 1 }, { ...link('PRESELEKCJA', 'opt_b'), maxQuantity: 1 });
  assert.equal(validateOfferForPublish(c).PRESELEKCJA, 615_000_000_000);
  assert.equal(quote('PRESELEKCJA', [{ serviceCode: 'opt_a', quantity: 1 }], 30, c).grossMinor, 615_000_000_000);
  error(() => quote('PRESELEKCJA', [{ serviceCode: 'opt_a', quantity: 1 }, { serviceCode: 'opt_b', quantity: 1 }], 30, c), 'MUTUAL_EXCLUSION');
  // Without the exclusion both are reachable together and the catalog must be refused.
  c.services.find(s => s.code === 'opt_a').exclusions = [];
  error(() => validateOfferForPublish(c), 'AMOUNT_OUT_OF_RANGE');
  // An add-on excluded by a package-included service is never selectable.
  const d = clone();
  d.services.find(s => s.code === 'report_ext').exclusions = ['interview'];
  d.planServices.find(l => l.packageCode === 'WERYFIKACJA' && l.serviceCode === 'report_ext').overridePriceRule = { method: 'per_unit', unitMinor: 40_000_000_000 };
  d.planServices.find(l => l.packageCode === 'WERYFIKACJA' && l.serviceCode === 'report_ext').includedQuantity = 0;
  d.planServices.find(l => l.packageCode === 'ASSESSMENT_CENTER' && l.serviceCode === 'report_ext').includedQuantity = 0;
  assert.doesNotThrow(() => validateOfferForPublish(d));
});

test('publish rejects mutually exclusive package-included services', () => {
  const c = clone();
  c.services.find(s => s.code === 'report_ext').exclusions = ['interview'];
  error(() => validateOfferForPublish(c), 'INCLUDED_SERVICES_CONFLICT:WERYFIKACJA');
  error(() => quote('WERYFIKACJA', [], 20, c), 'MUTUAL_EXCLUSION');
});

test('publish bound ignores add-ons that quoting would refuse to select (invisible or hidden)', () => {
  for (const patch of [{ visible: false }, { visible: false, commercialStatus: 'hidden', autoPurchase: false }]) {
    const c = clone();
    const l = c.planServices.find(x => x.packageCode === 'PRESELEKCJA' && x.serviceCode === 'report_ext');
    Object.assign(l, patch, { overridePriceRule: { method: 'fixed', amountMinor: 1_000_000_000_000 } });
    assert.doesNotThrow(() => validateOfferForPublish(c));
    error(() => quote('PRESELEKCJA', [{ serviceCode: 'report_ext', quantity: 1 }], 20, c), 'ADDON_UNAVAILABLE');
  }
  const h = clone();
  h.services.find(s => s.code === 'report_ext').commercialStatus = 'hidden';
  h.planServices.find(x => x.packageCode === 'PRESELEKCJA' && x.serviceCode === 'report_ext').overridePriceRule = { method: 'fixed', amountMinor: 1_000_000_000_000 };
  assert.doesNotThrow(() => validateOfferForPublish(h));
});

test('package links must respect global service limits (contract maxQuantity <= service.max)', () => {
  const c = clone();
  c.services.find(s => s.code === 'report_ext').max = 5;
  error(() => validateOfferForPublish(c), 'SERVICE_LIMIT_EXCEEDED');
  error(() => quote('PRESELEKCJA', [{ serviceCode: 'report_ext', quantity: 30 }], 20, c), 'SERVICE_LIMIT_EXCEEDED');
  const d = clone();
  d.services.find(s => s.code === 'report_ext').step = 2;
  error(() => quote('PRESELEKCJA', [], 20, d), 'SERVICE_LIMIT_EXCEEDED');
  const e = clone();
  delete e.services.find(s => s.code === 'report_ext').max;
  error(() => quote('PRESELEKCJA', [], 20, e), 'INVALID_CATALOG');
});

test('publish rejects included services whose dependencies cannot be realized in the package', () => {
  const c = clone();
  // interview is included in WERYFIKACJA and AC; WERYFIKACJA offers consult, AC gets a consult link too → realizable.
  c.services.find(s => s.code === 'interview').dependencies = ['consult'];
  c.planServices.push(link('ASSESSMENT_CENTER', 'consult'));
  assert.doesNotThrow(() => validateOfferForPublish(c));
  assert.equal(quote('ASSESSMENT_CENTER', [{ serviceCode: 'consult', quantity: 1 }], 20, c).canPurchase, true);
  // Without any consult link in AC the included interview can never be quoted.
  const d = clone();
  d.services.find(s => s.code === 'interview').dependencies = ['consult'];
  error(() => validateOfferForPublish(d), 'INCLUDED_DEPENDENCY_UNREALIZABLE:ASSESSMENT_CENTER:consult');
  error(() => quote('ASSESSMENT_CENTER', [], 20, d), 'UNMET_DEPENDENCY');
});

test('publish rejects included services whose required dependencies exclude each other', () => {
  const c = clone();
  c.services.find(s => s.code === 'interview').dependencies = ['consult', 'skill_test'];
  // consult excludes skill_test in the fixture: WERYFIKACJA offers both, so each is selectable alone.
  error(() => validateOfferForPublish(c), 'INCLUDED_DEPENDENCY_CONFLICT:WERYFIKACJA:consult:skill_test');
  error(() => quote('WERYFIKACJA', [{ serviceCode: 'consult', quantity: 1 }], 20, c), 'UNMET_DEPENDENCY');
  error(() => quote('WERYFIKACJA', [{ serviceCode: 'consult', quantity: 1 }, { serviceCode: 'skill_test', quantity: 1 }], 20, c), 'MUTUAL_EXCLUSION');
});

test('global service minimum applies to positive quantities and included quantities', () => {
  const c = clone();
  c.services.find(s => s.code === 'report_ext').min = 5;
  for (const l of c.planServices.filter(l => l.serviceCode === 'report_ext')) l.includedQuantity = 0;
  error(() => quote('PRESELEKCJA', [{ serviceCode: 'report_ext', quantity: 1 }], 20, c), 'INVALID_QUANTITY');
  assert.equal(line(quote('PRESELEKCJA', [{ serviceCode: 'report_ext', quantity: 5 }], 20, c), 'report_ext').billed, 5);
  assert.doesNotThrow(() => validateOfferForPublish(c));
  const d = clone();
  d.services.find(s => s.code === 'report_ext').min = 5; // WERYFIKACJA includes 1 < min 5
  error(() => quote('PRESELEKCJA', [], 20, d), 'SERVICE_LIMIT_EXCEEDED');
});

test('compatible bound follows dependency closures, not only direct exclusions', () => {
  const c = clone();
  Object.assign(c.plans.find(p => p.code === 'PRESELEKCJA'), { baseNetMinor: 0, cvIncluded: 30, cvPolicy: { quick: [10, 20, 30], range: null } });
  const svc = (code, price, extra = {}) => ({ code, name: code, min: 0, max: 1, step: 1, technicalStatus: 'verified',
    commercialStatus: 'purchasable', capabilityCode: 'reports_ready', dependencies: [], exclusions: [],
    defaultPriceRule: { method: 'fixed', amountMinor: price }, ...extra });
  c.services.push(svc('alpha', 500_000_000_000, { dependencies: ['gamma'] }), svc('beta', 500_000_000_000), svc('gamma', 0, { exclusions: ['beta'] }));
  c.planServices = c.planServices.filter(l => l.packageCode !== 'PRESELEKCJA');
  for (const s of ['alpha', 'beta', 'gamma']) c.planServices.push({ ...link('PRESELEKCJA', s), maxQuantity: 1 });
  assert.equal(validateOfferForPublish(c).PRESELEKCJA, 615_000_000_000);
  error(() => quote('PRESELEKCJA', [{ serviceCode: 'alpha', quantity: 1 }, { serviceCode: 'beta', quantity: 1 }], 30, c), 'UNMET_DEPENDENCY');
  error(() => quote('PRESELEKCJA', [{ serviceCode: 'alpha', quantity: 1 }, { serviceCode: 'beta', quantity: 1 }, { serviceCode: 'gamma', quantity: 1 }], 30, c), 'MUTUAL_EXCLUSION');
});

test('included-service dependency needs a positive quantity the package can actually accept', () => {
  const c = clone();
  // interview is included in WERYFIKACJA and AC; give AC a consult link whose step exceeds its maximum.
  c.services.find(s => s.code === 'interview').dependencies = ['consult'];
  c.planServices.push({ ...link('ASSESSMENT_CENTER', 'consult'), maxQuantity: 1, quantityStep: 2 });
  error(() => validateOfferForPublish(c), 'INCLUDED_DEPENDENCY_UNREALIZABLE:ASSESSMENT_CENTER:consult');
  error(() => quote('ASSESSMENT_CENTER', [], 20, c), 'UNMET_DEPENDENCY');
  error(() => quote('ASSESSMENT_CENTER', [{ serviceCode: 'consult', quantity: 1 }], 20, c), 'INVALID_QUANTITY');
  error(() => quote('ASSESSMENT_CENTER', [{ serviceCode: 'consult', quantity: 2 }], 20, c), 'INVALID_QUANTITY');
  // Service minimum above every reachable step is equally unrealizable.
  const d = clone();
  d.services.find(s => s.code === 'interview').dependencies = ['consult'];
  d.services.find(s => s.code === 'consult').min = 5;
  d.planServices.push({ ...link('ASSESSMENT_CENTER', 'consult'), maxQuantity: 4 });
  error(() => validateOfferForPublish(d), 'INCLUDED_DEPENDENCY_UNREALIZABLE:ASSESSMENT_CENTER:consult');
  // A reachable step keeps the package publishable.
  const e = clone();
  e.services.find(s => s.code === 'interview').dependencies = ['consult'];
  e.planServices.push({ ...link('ASSESSMENT_CENTER', 'consult'), maxQuantity: 2, quantityStep: 2 });
  assert.doesNotThrow(() => validateOfferForPublish(e));
  assert.equal(quote('ASSESSMENT_CENTER', [{ serviceCode: 'consult', quantity: 2 }], 20, e).canPurchase, true);
});

test('publish bound ignores add-ons whose dependency closure the package cannot provide', () => {
  const c = clone();
  Object.assign(c.plans.find(p => p.code === 'PRESELEKCJA'), { baseNetMinor: 0, cvIncluded: 30, cvPolicy: { quick: [10, 20, 30], range: null } });
  const svc = (code, price, extra = {}) => ({ code, name: code, min: 0, max: 1, step: 1, technicalStatus: 'verified',
    commercialStatus: 'purchasable', capabilityCode: 'reports_ready', dependencies: [], exclusions: [],
    defaultPriceRule: { method: 'fixed', amountMinor: price }, ...extra });
  c.services.push(svc('alpha', 1_000_000_000_000, { dependencies: ['beta'] }), svc('beta', 0));
  c.planServices = c.planServices.filter(l => l.packageCode !== 'PRESELEKCJA');
  c.planServices.push({ ...link('PRESELEKCJA', 'alpha'), maxQuantity: 1 });
  // beta has no PRESELEKCJA link: alpha can never be quoted, so it adds nothing to the bound.
  assert.equal(validateOfferForPublish(c).PRESELEKCJA, 0);
  error(() => quote('PRESELEKCJA', [{ serviceCode: 'alpha', quantity: 1 }], 30, c), 'UNMET_DEPENDENCY');
  error(() => quote('PRESELEKCJA', [{ serviceCode: 'alpha', quantity: 1 }, { serviceCode: 'beta', quantity: 1 }], 30, c), 'ADDON_UNAVAILABLE');
  // A transitive dependency whose quantity progression is empty is equally unrealizable.
  c.services.push(svc('gamma', 0));
  c.services.find(s => s.code === 'beta').dependencies = ['gamma'];
  c.planServices.push({ ...link('PRESELEKCJA', 'beta'), maxQuantity: 1 }, { ...link('PRESELEKCJA', 'gamma'), maxQuantity: 1, quantityStep: 2 });
  assert.equal(validateOfferForPublish(c).PRESELEKCJA, 0);
  // Once every dependency is selectable, the add-on counts again and the bound fails closed.
  c.planServices.find(l => l.packageCode === 'PRESELEKCJA' && l.serviceCode === 'gamma').quantityStep = 1;
  error(() => validateOfferForPublish(c), 'AMOUNT_OUT_OF_RANGE');
  error(() => quote('PRESELEKCJA', ['alpha', 'beta', 'gamma'].map(serviceCode => ({ serviceCode, quantity: 1 })), 30, c), 'AMOUNT_OUT_OF_RANGE');
});

test('publish bound treats required dependencies of included services as always present', () => {
  const c = clone();
  Object.assign(c.plans.find(p => p.code === 'PRESELEKCJA'), { baseNetMinor: 0, cvIncluded: 30, cvPolicy: { quick: [10, 20, 30], range: null } });
  const svc = (code, price, extra = {}) => ({ code, name: code, min: 0, max: 1, step: 1, technicalStatus: 'verified',
    commercialStatus: 'purchasable', capabilityCode: 'reports_ready', dependencies: [], exclusions: [],
    defaultPriceRule: { method: 'fixed', amountMinor: price }, ...extra });
  c.services.push(svc('alpha', 0, { dependencies: ['beta'] }), svc('beta', 0, { exclusions: ['gamma'] }), svc('gamma', 1_000_000_000_000));
  c.planServices = c.planServices.filter(l => l.packageCode !== 'PRESELEKCJA');
  c.planServices.push({ ...link('PRESELEKCJA', 'alpha', 1), maxQuantity: 1 }, { ...link('PRESELEKCJA', 'beta'), maxQuantity: 1 },
    { ...link('PRESELEKCJA', 'gamma'), maxQuantity: 1 });
  // alpha is included and needs beta, which excludes gamma: gamma is never quotable, so the bound stays 0.
  assert.equal(validateOfferForPublish(c).PRESELEKCJA, 0);
  error(() => quote('PRESELEKCJA', [{ serviceCode: 'gamma', quantity: 1 }], 30, c), 'UNMET_DEPENDENCY');
  error(() => quote('PRESELEKCJA', [{ serviceCode: 'beta', quantity: 1 }, { serviceCode: 'gamma', quantity: 1 }], 30, c), 'MUTUAL_EXCLUSION');
  assert.equal(quote('PRESELEKCJA', [{ serviceCode: 'beta', quantity: 1 }], 30, c).grossMinor, 0);
  // A priced required dependency is part of every quote, so it counts toward the bound.
  c.services.find(s => s.code === 'beta').defaultPriceRule = { method: 'fixed', amountMinor: 1_000 };
  assert.equal(validateOfferForPublish(c).PRESELEKCJA, 1_230);
  assert.equal(quote('PRESELEKCJA', [{ serviceCode: 'beta', quantity: 1 }], 30, c).grossMinor, 1_230);
});

test('unreachable add-ons are filtered before their own line bound is checked', () => {
  const c = clone();
  Object.assign(c.plans.find(p => p.code === 'PRESELEKCJA'), { baseNetMinor: 0, cvIncluded: 30, cvPolicy: { quick: [10, 20, 30], range: null } });
  c.services.push({ code: 'alpha', name: 'alpha', min: 0, max: 2, step: 1, technicalStatus: 'verified', commercialStatus: 'purchasable',
    capabilityCode: 'reports_ready', dependencies: ['beta'], exclusions: [], defaultPriceRule: { method: 'per_unit', unitMinor: 1_000_000_000_000 } },
  { code: 'beta', name: 'beta', min: 0, max: 1, step: 1, technicalStatus: 'verified', commercialStatus: 'purchasable',
    capabilityCode: 'reports_ready', dependencies: [], exclusions: [], defaultPriceRule: null });
  c.planServices = c.planServices.filter(l => l.packageCode !== 'PRESELEKCJA');
  c.planServices.push({ ...link('PRESELEKCJA', 'alpha'), maxQuantity: 2 });
  // alpha's line maximum (2 × 10^12) is out of range, but alpha can never be quoted without beta.
  assert.equal(validateOfferForPublish(c).PRESELEKCJA, 0);
  error(() => quote('PRESELEKCJA', [{ serviceCode: 'alpha', quantity: 1 }], 30, c), 'UNMET_DEPENDENCY');
  // Once beta is selectable the same line is reachable and the bound fails closed.
  c.planServices.push({ ...link('PRESELEKCJA', 'beta'), maxQuantity: 1, overridePriceRule: { method: 'fixed', amountMinor: 0 } });
  error(() => validateOfferForPublish(c), 'AMOUNT_OUT_OF_RANGE');
});

test('publish rejects a required dependency closure that cannot fit in one request', () => {
  const build = n => {
    const c = clone();
    Object.assign(c.plans.find(p => p.code === 'PRESELEKCJA'), { baseNetMinor: 0, cvIncluded: 30, cvPolicy: { quick: [10, 20, 30], range: null } });
    const svc = (code, dependencies) => ({ code, name: code, min: 0, max: 1, step: 1, technicalStatus: 'verified',
      commercialStatus: 'purchasable', capabilityCode: 'reports_ready', dependencies, exclusions: [],
      defaultPriceRule: { method: 'fixed', amountMinor: 0 } });
    const chain = Array.from({ length: n }, (_, i) => `dep_${i}`);
    c.services.push(svc('root', [chain[0]]), ...chain.map((d, i) => svc(d, i + 1 < n ? [chain[i + 1]] : [])));
    c.planServices = c.planServices.filter(l => l.packageCode !== 'PRESELEKCJA');
    c.planServices.push({ ...link('PRESELEKCJA', 'root', 1), maxQuantity: 1 }, ...chain.map(d => ({ ...link('PRESELEKCJA', d), maxQuantity: 1 })));
    return { c, chain };
  };
  const ok = build(64);
  assert.equal(validateOfferForPublish(ok.c).PRESELEKCJA, 0);
  assert.equal(quote('PRESELEKCJA', ok.chain.map(serviceCode => ({ serviceCode, quantity: 1 })), 30, ok.c).canPurchase, true);
  const tooLong = build(65);
  error(() => validateOfferForPublish(tooLong.c), 'INCLUDED_DEPENDENCIES_EXCEED_REQUEST_LIMIT:PRESELEKCJA');
  error(() => quote('PRESELEKCJA', tooLong.chain.map(serviceCode => ({ serviceCode, quantity: 1 })), 30, tooLong.c), 'INVALID_REQUEST');
});
