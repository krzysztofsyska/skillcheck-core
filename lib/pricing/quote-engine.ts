/** SC-PRICING-003: pure and deterministic commercial quote core.
 * Inputs are immutable business snapshots, not browser-controlled prices.
 * No database, credentials, tenant credits, billing or provider calls here.
 */
export type PackageCode = 'FREE' | 'PRESELEKCJA' | 'WERYFIKACJA' | 'ASSESSMENT_CENTER';
export type CommercialStatus = 'hidden' | 'informational' | 'on_request' | 'purchasable';
export type TechnicalStatus = 'planned' | 'prototype' | 'verified';
export type PriceRule =
  | Readonly<{ method: 'fixed'; amountMinor: number }>
  | Readonly<{ method: 'per_unit'; unitMinor: number }>
  | Readonly<{ method: 'volume_tier'; mode: 'graduated' | 'all_units'; tiers: readonly Readonly<{ upTo: number | null; unitMinor: number }>[] }>
  | Readonly<{ method: 'bundle'; amountMinor: number; covers: readonly Readonly<{ serviceCode: string; quantity: number }>[] }>;
export type CvPolicy = Readonly<{ quick: readonly number[]; range: Readonly<{ min: number; max: number; step: number }> | null }>;
export type Plan = Readonly<{
  code: PackageCode; baseNetMinor: number | null; commercialStatus: CommercialStatus;
  cvIncluded: number; cvPolicy: CvPolicy; cvOverageRule?: PriceRule | null;
  capabilityCode: string | null;
}>;
export type Service = Readonly<{
  code: string; name: string; technicalStatus: TechnicalStatus;
  commercialStatus: CommercialStatus; capabilityCode: string | null;
  dependencies: readonly string[]; exclusions: readonly string[];
  defaultPriceRule?: PriceRule | null;
}>;
export type PlanService = Readonly<{
  packageCode: PackageCode; serviceCode: string; allowed: boolean; visible: boolean;
  includedQuantity: number; maxQuantity: number; quantityStep: number; extraAllowed: boolean;
  autoPurchase: boolean; commercialStatus: CommercialStatus;
  overridePriceRule?: PriceRule | null;
}>;
export type DiscountRule = Readonly<{
  code: string; method: 'percent' | 'amount'; value: number;
  eligiblePackages: readonly PackageCode[];
}>;
export type Offer = Readonly<{
  versionId: string; status: 'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'SUPERSEDED' | 'ARCHIVED';
  approved: boolean; currency: 'PLN'; vatBasisPoints: number;
  plans: readonly Plan[]; services: readonly Service[];
  planServices: readonly PlanService[]; discounts: readonly DiscountRule[];
}>;
export type QuoteRequest = Readonly<{
  expectedVersionId: string; packageCode: PackageCode; cvCount: number;
  addons: readonly Readonly<{ serviceCode: string; quantity: number }>[];
}>;
export type QuoteLine = Readonly<{
  kind: 'base' | 'cv_overage' | 'service' | 'discount'; code: string;
  quantity: number; included: number; billed: number; netMinor: number;
}>;
export type Quote = Readonly<{
  versionId: string; packageCode: PackageCode; currency: 'PLN'; vatBasisPoints: number;
  lines: readonly QuoteLine[]; subtotalNetMinor: number; discountMinor: number;
  netMinor: number; vatMinor: number; grossMinor: number;
  canPurchase: boolean; unavailableCapabilities: readonly string[];
}>;

export class PricingError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'PricingError'; }
}
const fail = (code: string): never => { throw new PricingError(code); };
const MAX_MINOR = BigInt(1_000_000_000_000);
const MAX_QUANTITY = 100_000;
const PACKAGE_CODES: readonly PackageCode[] = ['FREE', 'PRESELEKCJA', 'WERYFIKACJA', 'ASSESSMENT_CENTER'];
const commercial: readonly CommercialStatus[] = ['hidden', 'informational', 'on_request', 'purchasable'];
const codePattern = /^[a-z][a-z0-9_:-]{1,63}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9_:-]{1,127}$/;
const plain = (v: unknown): boolean =>
  v !== null && typeof v === 'object' && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  plain(v) && Object.keys(v as object).length === keys.length && Object.keys(v as object).every(k => keys.includes(k)) &&
  keys.every(k => Object.hasOwn(v as object, k));
const isCode = (v: unknown): v is string => typeof v === 'string' && codePattern.test(v);
const isPackage = (v: unknown): v is PackageCode => PACKAGE_CODES.includes(v as PackageCode);
const validQty = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= MAX_QUANTITY;
const minor = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0 && BigInt(n as number) <= MAX_MINOR;
const percentage = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 10000;
const cents = (n: bigint): number => n >= BigInt(0) && n <= MAX_MINOR ? Number(n) : fail('PRICE_OVERFLOW');
const roundedRatio = (numerator: bigint, denominator: bigint): bigint =>
  denominator > BigInt(0) && numerator >= BigInt(0) ? (numerator * BigInt(2) + denominator) / (BigInt(2) * denominator) : fail('INVALID_RATIO');
const uniq = (items: readonly string[]): boolean => new Set(items).size === items.length;

function calculateRule(rule: PriceRule | null | undefined, qty: number, allowBundle = false): number {
  if (!validQty(qty)) return fail('INVALID_QUANTITY');
  if (!plain(rule)) return fail('UNPRICED');
  const priced = rule as PriceRule;
  if (priced.method === 'fixed') {
    if (!minor(priced.amountMinor)) return fail('INVALID_RULE');
    return qty > 0 ? priced.amountMinor : 0;
  }
  if (priced.method === 'per_unit') {
    if (!minor(priced.unitMinor)) return fail('INVALID_RULE');
    return cents(BigInt(priced.unitMinor) * BigInt(qty));
  }
  if (priced.method === 'bundle') {
    if (!allowBundle || !minor(priced.amountMinor) || !Array.isArray(priced.covers) || !priced.covers.length || qty !== 1)
      return fail('INVALID_BUNDLE');
    return priced.amountMinor;
  }
  if (priced.method !== 'volume_tier' || (priced.mode !== 'graduated' && priced.mode !== 'all_units') ||
      !Array.isArray(priced.tiers) || !priced.tiers.length || priced.tiers.length > 32)
    return fail('INVALID_RULE');
  let previous = 0;
  for (let i = 0; i < priced.tiers.length; i++) {
    const tier = priced.tiers[i];
    if (!plain(tier) || !minor(tier.unitMinor) ||
        (tier.upTo === null ? i !== priced.tiers.length - 1 : !validQty(tier.upTo) || tier.upTo <= previous))
      return fail('INVALID_TIER');
    previous = tier.upTo ?? MAX_QUANTITY;
  }
  if (priced.tiers[priced.tiers.length - 1].upTo !== null) return fail('INVALID_TIER');
  previous = 0;
  let sum = BigInt(0);
  for (const tier of priced.tiers) {
    const top = tier.upTo ?? MAX_QUANTITY;
    if (priced.mode === 'all_units' && qty <= top)
      return cents(BigInt(qty) * BigInt(tier.unitMinor));
    if (priced.mode === 'graduated') {
      const units = Math.max(0, Math.min(qty, top) - previous);
      sum += BigInt(units) * BigInt(tier.unitMinor);
    }
    previous = top;
  }
  return cents(sum);
}

function validCvCount(policy: CvPolicy, qty: number): boolean {
  if (!validQty(qty) || qty === 0 || !plain(policy) || !Array.isArray(policy.quick)) return false;
  if (policy.quick.length > 30 || !policy.quick.every(x => validQty(x) && x > 0) ||
      new Set(policy.quick).size !== policy.quick.length) return false;
  if (policy.quick.includes(qty)) return true;
  if (policy.range === null) return false;
  const r = policy.range;
  return plain(r) && validQty(r.min) && validQty(r.max) && validQty(r.step) && r.step > 0 &&
    r.min > 0 && r.max >= r.min && qty >= r.min && qty <= r.max && (qty - r.min) % r.step === 0;
}

function validatedRequest(input: unknown): QuoteRequest {
  if (!exact(input, ['expectedVersionId', 'packageCode', 'cvCount', 'addons']) ||
      typeof input.expectedVersionId !== 'string' || !versionPattern.test(input.expectedVersionId) ||
      !isPackage(input.packageCode) || !validQty(input.cvCount) || !Array.isArray(input.addons) || input.addons.length > 64)
    return fail('INVALID_REQUEST');
  const codes = new Set<string>();
  for (const a of input.addons) {
    if (!exact(a, ['serviceCode', 'quantity']) || !isCode(a.serviceCode) || !validQty(a.quantity) || codes.has(a.serviceCode))
      return fail('INVALID_ADDON');
    codes.add(a.serviceCode);
  }
  return input as unknown as QuoteRequest;
}

/** Preview requires a separately authorized owner API. NEVER derive allowDraft from a browser field. */
export function quoteOffer(offer: Offer, untrustedRequest: unknown,
  runtimeCapabilities: ReadonlySet<string>, options: Readonly<{ allowDraft?: boolean }> = {}): Quote {
  const input = validatedRequest(untrustedRequest);
  if (!plain(offer) || !versionPattern.test(offer.versionId) || offer.currency !== 'PLN' ||
      offer.approved !== true || !percentage(offer.vatBasisPoints) ||
      (offer.status !== 'PUBLISHED' && !(options.allowDraft === true && offer.status === 'DRAFT')) ||
      !Array.isArray(offer.plans) || !Array.isArray(offer.services) ||
      !Array.isArray(offer.planServices) || !Array.isArray(offer.discounts) ||
      !(runtimeCapabilities instanceof Set)) return fail('OFFER_NOT_APPROVED');
  if (input.expectedVersionId !== offer.versionId) return fail('STALE_VERSION');
  if (offer.plans.length > 64 || offer.services.length > 1000 || offer.planServices.length > 4000 || offer.discounts.length > 64)
    return fail('INVALID_CATALOG');
  const plans = new Map<PackageCode, Plan>(), services = new Map<string, Service>();
  for (const p of offer.plans) {
    if (!plain(p) || !isPackage(p.code) || plans.has(p.code) || !minor(p.baseNetMinor) && p.baseNetMinor !== null ||
        !validQty(p.cvIncluded) || !commercial.includes(p.commercialStatus) ||
        !(p.capabilityCode === null || isCode(p.capabilityCode))) return fail('INVALID_CATALOG');
    plans.set(p.code, p);
  }
  for (const s of offer.services) {
    if (!plain(s) || !isCode(s.code) || services.has(s.code) || !Array.isArray(s.dependencies) ||
        !Array.isArray(s.exclusions) || !s.dependencies.every(isCode) || !s.exclusions.every(isCode) ||
        !uniq(s.dependencies) || !uniq(s.exclusions) || s.dependencies.includes(s.code) || s.exclusions.includes(s.code) ||
        !commercial.includes(s.commercialStatus) || !['planned', 'prototype', 'verified'].includes(s.technicalStatus) ||
        !(s.capabilityCode === null || isCode(s.capabilityCode))) return fail('INVALID_CATALOG');
    services.set(s.code, s);
  }
  const plan = plans.get(input.packageCode);
  if (!plan || plan.commercialStatus === 'hidden' || !validCvCount(plan.cvPolicy, input.cvCount)) return fail('PLAN_UNAVAILABLE');
  if (plan.baseNetMinor === null) return fail('UNPRICED');
  const links = new Map<string, PlanService>(), desired = new Map<string, number>();
  for (const l of offer.planServices) {
    if (!plain(l) || !isPackage(l.packageCode) || !isCode(l.serviceCode) || !services.has(l.serviceCode) ||
        !validQty(l.includedQuantity) || !validQty(l.maxQuantity) || !validQty(l.quantityStep) || l.quantityStep === 0 ||
        l.maxQuantity < l.includedQuantity || !commercial.includes(l.commercialStatus)) return fail('INVALID_CATALOG');
    if (l.packageCode === input.packageCode) {
      if (links.has(l.serviceCode)) return fail('INVALID_CATALOG');
      links.set(l.serviceCode, l);
      if (l.allowed && l.includedQuantity > 0) desired.set(l.serviceCode, l.includedQuantity);
    }
  }
  const chosen = new Set<string>();
  for (const add of input.addons) {
    const l = links.get(add.serviceCode);
    if (!l || !l.allowed || !l.visible || l.commercialStatus === 'hidden' ||
        services.get(add.serviceCode)?.commercialStatus === 'hidden') return fail('ADDON_UNAVAILABLE');
    const qty = add.quantity === 0 ? l.includedQuantity : add.quantity;
    if (qty < l.includedQuantity || qty > l.maxQuantity ||
        (qty > l.includedQuantity && (!l.extraAllowed || (qty - l.includedQuantity) % l.quantityStep !== 0)))
      return fail('INVALID_QUANTITY');
    desired.set(add.serviceCode, qty);
    if (qty > 0) chosen.add(add.serviceCode);
  }
  // Bundles automatically include their explicitly specified contents; a component may be covered by only one bundle.
  const covered = new Map<string, number>();
  for (const code of Array.from(chosen)) {
    const link = links.get(code)!;
    const rule = link.overridePriceRule ?? services.get(code)?.defaultPriceRule;
    if (rule?.method !== 'bundle') continue;
    if (link.includedQuantity !== 0 || desired.get(code) !== 1 || !Array.isArray(rule.covers) ||
        rule.covers.length === 0 || rule.covers.length > 32) return fail('INVALID_BUNDLE');
    const seen = new Set<string>();
    for (const comp of rule.covers) {
      if (!plain(comp) || !isCode(comp.serviceCode) || !validQty(comp.quantity) || comp.quantity <= 0 ||
          comp.serviceCode === code || seen.has(comp.serviceCode) || covered.has(comp.serviceCode)) return fail('INVALID_BUNDLE');
      seen.add(comp.serviceCode);
      const target = links.get(comp.serviceCode);
      if (!target || !target.allowed || !target.extraAllowed || !services.has(comp.serviceCode)) return fail('INVALID_BUNDLE');
      const targetTotal = target.includedQuantity + comp.quantity;
      if (targetTotal > target.maxQuantity || comp.quantity % target.quantityStep !== 0) return fail('INVALID_BUNDLE');
      covered.set(comp.serviceCode, comp.quantity);
      desired.set(comp.serviceCode, Math.max(targetTotal, desired.get(comp.serviceCode) ?? 0));
    }
  }
  for (const [code, qty] of Array.from(desired.entries())) {
    if (qty === 0) continue;
    const s = services.get(code)!;
    if (s.dependencies.some(c => (desired.get(c) ?? 0) <= 0)) return fail('UNMET_DEPENDENCY');
    if (s.exclusions.some(c => (desired.get(c) ?? 0) > 0)) return fail('MUTUAL_EXCLUSION');
  }
  const lines: QuoteLine[] = [{ kind: 'base', code: plan.code, quantity: 1, included: 0, billed: 1, netMinor: plan.baseNetMinor }];
  let subtotal = BigInt(plan.baseNetMinor);
  const cvBilled = Math.max(0, input.cvCount - plan.cvIncluded);
  if (cvBilled) {
    const price = calculateRule(plan.cvOverageRule, cvBilled);
    subtotal += BigInt(price);
    lines.push({ kind: 'cv_overage', code: 'cv', quantity: input.cvCount, included: plan.cvIncluded, billed: cvBilled, netMinor: price });
  }
  const unavailable = new Set<string>();
  if (plan.commercialStatus !== 'purchasable' || !plan.capabilityCode || !runtimeCapabilities.has(plan.capabilityCode))
    unavailable.add(plan.capabilityCode ?? 'plan_not_ready');
  for (const [code, l] of Array.from(links.entries())) {
    const qty = desired.get(code) ?? 0;
    if (!qty || !l.allowed) continue;
    const s = services.get(code)!;
    const included = l.includedQuantity + (covered.get(code) ?? 0);
    const billable = Math.max(0, qty - included);
    const rule = l.overridePriceRule ?? s.defaultPriceRule;
    const amount = billable ? calculateRule(rule, billable, true) : 0;
    subtotal += BigInt(amount);
    lines.push({ kind: 'service', code, quantity: qty, included, billed: billable, netMinor: amount });
    if (l.commercialStatus !== 'purchasable' || s.commercialStatus !== 'purchasable' ||
        s.technicalStatus !== 'verified' || !l.autoPurchase || !s.capabilityCode ||
        !runtimeCapabilities.has(s.capabilityCode)) unavailable.add(s.capabilityCode ?? code);
  }
  cents(subtotal);
  let discounted = subtotal, discountTotal = BigInt(0);
  const discountCodes = new Set<string>();
  for (const d of offer.discounts) {
    if (!plain(d) || !isCode(d.code) || discountCodes.has(d.code) || !Array.isArray(d.eligiblePackages) ||
        !d.eligiblePackages.every(isPackage) || !uniq(d.eligiblePackages)) return fail('INVALID_DISCOUNT');
    discountCodes.add(d.code);
    if (d.method === 'percent' && !percentage(d.value) || d.method === 'amount' && !minor(d.value) ||
        (d.method !== 'percent' && d.method !== 'amount')) return fail('INVALID_DISCOUNT');
    if (!d.eligiblePackages.includes(input.packageCode)) continue;
    const applied = d.method === 'percent'
      ? roundedRatio(discounted * BigInt(d.value), BigInt(10000))
      : BigInt(d.value);
    const actual = applied > discounted ? discounted : applied;
    discounted -= actual;
    discountTotal += actual;
    lines.push({ kind: 'discount', code: d.code, quantity: 1, included: 0, billed: 1, netMinor: -cents(actual) });
  }
  const vat = roundedRatio(discounted * BigInt(offer.vatBasisPoints), BigInt(10000));
  return {
    versionId: offer.versionId, packageCode: input.packageCode, currency: 'PLN', vatBasisPoints: offer.vatBasisPoints,
    lines, subtotalNetMinor: cents(subtotal), discountMinor: cents(discountTotal),
    netMinor: cents(discounted), vatMinor: cents(vat), grossMinor: cents(discounted + vat),
    canPurchase: unavailable.size === 0 && offer.status === 'PUBLISHED',
    unavailableCapabilities: Array.from(unavailable).sort(),
  };
}
