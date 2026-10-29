/** SC-PRICING-003: pure and deterministic commercial quote core (contract pln-v1, #149).
 * Inputs are immutable business snapshots, not browser-controlled prices.
 * No database, credentials, tenant credits, billing or provider calls here.
 */
export type PackageCode = 'FREE' | 'PRESELEKCJA' | 'WERYFIKACJA' | 'ASSESSMENT_CENTER';
export type CommercialStatus = 'hidden' | 'informational' | 'on_request' | 'purchasable';
export type TechnicalStatus = 'planned' | 'prototype' | 'verified';
type Tier<K extends string> = Readonly<{ upTo: number | null } & Record<K, number>>;
/** v1 methods only. `bundle` and any other method are rejected with UNSUPPORTED_RULE. */
export type PriceRule =
  | Readonly<{ method: 'fixed'; amountMinor: number }>
  | Readonly<{ method: 'per_unit'; unitMinor: number }>
  | Readonly<{ method: 'volume_tier'; mode: 'graduated' | 'all_units'; tiers: readonly Tier<'unitMinor'>[] }>
  | Readonly<{ method: 'tiered_flat'; tiers: readonly Tier<'amountMinor'>[] }>;
export type CvPolicy = Readonly<{ quick: readonly number[]; range: Readonly<{ min: number; max: number; step: number }> | null }>;
export type Plan = Readonly<{
  code: PackageCode; baseNetMinor: number | null; commercialStatus: CommercialStatus;
  cvIncluded: number; cvPolicy: CvPolicy; cvOverageRule?: PriceRule | null;
  capabilityCode: string | null;
}>;
export type Service = Readonly<{
  code: string; name: string; technicalStatus: TechnicalStatus;
  /** Global quantity limits; every package link must stay inside them (contract pln-v1). */
  min: number; max: number; step: number;
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
  /** Stable machine codes; empty iff canPurchase=true. */
  blockedReasons: readonly string[];
}>;

export class PricingError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'PricingError'; }
}
const fail = (code: string): never => { throw new PricingError(code); };
const ZERO = BigInt(0);
const MAX_MINOR = BigInt(1_000_000_000_000);
const MAX_QUANTITY = 100_000;
const MAX_TIERS = 32;
const MAX_ADDONS = 64; // per quote request
const PACKAGE_CODES: readonly PackageCode[] = ['FREE', 'PRESELEKCJA', 'WERYFIKACJA', 'ASSESSMENT_CENTER'];
const COMMERCIAL: readonly CommercialStatus[] = ['hidden', 'informational', 'on_request', 'purchasable'];
const TECHNICAL: readonly TechnicalStatus[] = ['planned', 'prototype', 'verified'];
const codePattern = /^[a-z][a-z0-9_:-]{1,63}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9_:-]{1,127}$/;
const plain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  plain(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const isCode = (v: unknown): v is string => typeof v === 'string' && codePattern.test(v);
const isPackage = (v: unknown): v is PackageCode => PACKAGE_CODES.includes(v as PackageCode);
const validQty = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= MAX_QUANTITY;
const minor = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0 && BigInt(n as number) <= MAX_MINOR;
const percentage = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 10000;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
/** Every line, subtotal, discount, net, VAT and gross must stay inside MoneyMinor; never truncate. */
const amount = (n: bigint): number => n >= ZERO && n <= MAX_MINOR ? Number(n) : fail('AMOUNT_OUT_OF_RANGE');
const halfUp = (numerator: bigint, denominator: bigint): bigint =>
  denominator > ZERO && numerator >= ZERO ? (numerator * BigInt(2) + denominator) / (BigInt(2) * denominator) : fail('INVALID_RATIO');
const uniq = (items: readonly unknown[]): boolean => new Set(items).size === items.length;
const vatOf = (net: bigint, bps: number): bigint => halfUp(net * BigInt(bps), BigInt(10000));

function capabilitySnapshot(source: ReadonlySet<string>): ReadonlySet<string> {
  try {
    if (!source || typeof source.has !== 'function' || typeof source.values !== 'function' ||
        !Number.isSafeInteger(source.size) || source.size < 0 || source.size > 512) return fail('INVALID_CAPABILITIES');
    const values = Array.from(source.values());
    if (values.length !== source.size || !values.every(isCode) || !uniq(values)) return fail('INVALID_CAPABILITIES');
    if (values.some(c => source.has(c) !== true)) return fail('INVALID_CAPABILITIES');
    return new Set(values);
  } catch (error) {
    if (error instanceof PricingError) throw error;
    return fail('INVALID_CAPABILITIES');
  }
}

// ---------- price rules ----------
type Bounds = { low: number; top: number }; // inclusive range covered by a tier
function tierBounds<K extends 'unitMinor' | 'amountMinor'>(tiers: unknown, key: K): (Bounds & { value: number })[] {
  if (!Array.isArray(tiers) || tiers.length < 1 || tiers.length > MAX_TIERS) return fail('INVALID_TIER');
  const out: (Bounds & { value: number })[] = [];
  let previous = 0;
  for (let i = 0; i < tiers.length; i++) {
    const t: unknown = tiers[i];
    if (!exact(t, ['upTo', key]) || !minor(t[key])) return fail('INVALID_TIER');
    const last = i === tiers.length - 1;
    if (t.upTo === null) {
      if (!last) return fail('INVALID_TIER');
      out.push({ low: previous + 1, top: MAX_QUANTITY, value: t[key] as number });
    } else {
      if (!validQty(t.upTo) || t.upTo <= previous) return fail('INVALID_TIER');
      out.push({ low: previous + 1, top: t.upTo, value: t[key] as number });
      previous = t.upTo;
    }
  }
  return out;
}

type CheckedRule =
  | { kind: 'fixed'; value: number }
  | { kind: 'per_unit'; value: number }
  | { kind: 'graduated' | 'all_units' | 'tiered_flat'; tiers: (Bounds & { value: number })[] };

function checkRule(rule: unknown): CheckedRule {
  if (!plain(rule)) return fail('UNPRICED');
  switch (rule.method) {
    case 'fixed':
      if (!exact(rule, ['method', 'amountMinor']) || !minor(rule.amountMinor)) return fail('INVALID_RULE');
      return { kind: 'fixed', value: rule.amountMinor };
    case 'per_unit':
      if (!exact(rule, ['method', 'unitMinor']) || !minor(rule.unitMinor)) return fail('INVALID_RULE');
      return { kind: 'per_unit', value: rule.unitMinor };
    case 'volume_tier':
      if (!exact(rule, ['method', 'mode', 'tiers']) || (rule.mode !== 'graduated' && rule.mode !== 'all_units'))
        return fail('INVALID_RULE');
      return { kind: rule.mode, tiers: tierBounds(rule.tiers, 'unitMinor') };
    case 'tiered_flat':
      if (!exact(rule, ['method', 'tiers'])) return fail('INVALID_RULE');
      return { kind: 'tiered_flat', tiers: tierBounds(rule.tiers, 'amountMinor') };
    default:
      return fail('UNSUPPORTED_RULE');
  }
}

/** Net charge for `qty` billed units (qty already excludes included units). */
function priceOf(rule: CheckedRule, qty: number): bigint {
  if (!validQty(qty)) return fail('INVALID_QUANTITY');
  if (qty === 0) return ZERO;
  switch (rule.kind) {
    case 'fixed': return BigInt(rule.value);
    case 'per_unit': return BigInt(rule.value) * BigInt(qty);
    case 'all_units': {
      const t = rule.tiers.find(x => qty <= x.top);
      return t ? BigInt(qty) * BigInt(t.value) : fail('QUANTITY_OUT_OF_RANGE');
    }
    case 'tiered_flat': {
      const t = rule.tiers.find(x => qty <= x.top);
      return t ? BigInt(t.value) : fail('QUANTITY_OUT_OF_RANGE');
    }
    case 'graduated': {
      if (qty > rule.tiers[rule.tiers.length - 1].top) return fail('QUANTITY_OUT_OF_RANGE');
      let sum = ZERO;
      for (const t of rule.tiers) {
        if (qty < t.low) break;
        sum += BigInt(Math.min(qty, t.top) - t.low + 1) * BigInt(t.value);
      }
      return sum;
    }
  }
}

/** Largest reachable billed quantity inside [lo, hi] (inclusive), or null. */
type LargestIn = (lo: number, hi: number) => number | null;

/** Highest net charge over every *reachable* billed quantity. Tiered rules need not be monotonic, so
 * each tier is evaluated at its largest reachable quantity; tiers with no reachable quantity are ignored.
 * A reachable quantity beyond a bounded last tier is a configuration error (TIER_COVERAGE). */
function upperBound(rule: CheckedRule, largestIn: LargestIn): bigint {
  const top = largestIn(1, MAX_QUANTITY);
  if (top === null) return ZERO;
  if (rule.kind === 'fixed' || rule.kind === 'per_unit') return priceOf(rule, top);
  const lastTop = rule.tiers[rule.tiers.length - 1].top;
  if (lastTop < MAX_QUANTITY && largestIn(lastTop + 1, MAX_QUANTITY) !== null) return fail('TIER_COVERAGE');
  if (rule.kind === 'graduated') return priceOf(rule, top);
  let best = ZERO;
  for (const t of rule.tiers) {
    const q = largestIn(t.low, t.top);
    if (q === null) continue;
    const candidate = rule.kind === 'tiered_flat' ? BigInt(t.value) : BigInt(q) * BigInt(t.value);
    if (candidate > best) best = candidate;
  }
  return best;
}

/** Billed add-on quantities: positive multiples of step up to `extra`, whose total
 * (included + billed) also reaches the service minimum. */
const stepLargestIn = (step: number, extra: number, minBilled = 1): LargestIn => (lo, hi) => {
  const q = Math.floor(Math.min(hi, extra) / step) * step;
  return q >= Math.max(lo, minBilled, 1) ? q : null;
};

// ---------- catalog validation (shared by publish and quote) ----------
function checkCvPolicy(policy: unknown): { allowed: (n: number) => boolean; max: number; largest: LargestIn } {
  if (!exact(policy, ['quick', 'range']) || !Array.isArray(policy.quick) || policy.quick.length > 30)
    return fail('INVALID_CV_POLICY');
  const quick = policy.quick as unknown[];
  if (!quick.every(x => validQty(x) && x > 0) || !uniq(quick) ||
      quick.some((x, i) => i > 0 && (x as number) <= (quick[i - 1] as number))) return fail('INVALID_CV_POLICY');
  const r = policy.range;
  if (r !== null && (!exact(r, ['min', 'max', 'step']) || !validQty(r.min) || !validQty(r.max) || !validQty(r.step) ||
      r.min <= 0 || r.step <= 0 || r.max < r.min)) return fail('INVALID_CV_POLICY');
  if (!quick.length && r === null) return fail('INVALID_CV_POLICY');
  const range = r as { min: number; max: number; step: number } | null;
  const quickSet = new Set(quick as number[]);
  const rangeTop = range ? range.min + Math.floor((range.max - range.min) / range.step) * range.step : 0;
  const max = Math.max(quick.length ? (quick[quick.length - 1] as number) : 0, rangeTop);
  const largest = (lo: number, hi: number): number | null => {
    let best: number | null = null;
    for (const q of quick as number[]) if (q >= lo && q <= hi) best = q;
    if (range !== null) {
      const cap = Math.min(hi, range.max);
      if (cap >= range.min) {
        const q = range.min + Math.floor((cap - range.min) / range.step) * range.step;
        if (q >= lo && (best === null || q > best)) best = q;
      }
    }
    return best;
  };
  return {
    max,
    largest,
    allowed: n => validQty(n) && n > 0 && (quickSet.has(n) ||
      (range !== null && n >= range.min && n <= range.max && (n - range.min) % range.step === 0)),
  };
}

type Catalog = {
  plans: Map<PackageCode, { plan: Plan; cv: ReturnType<typeof checkCvPolicy>; overage: CheckedRule | null }>;
  services: Map<string, { service: Service; rule: CheckedRule | null }>;
  links: Map<PackageCode, Map<string, { link: PlanService; rule: CheckedRule | null }>>;
  discounts: DiscountRule[];
};

function checkCatalog(offer: Offer): Catalog {
  if (offer.plans.length > 64 || offer.services.length > 1000 || offer.planServices.length > 4000 || offer.discounts.length > 64)
    return fail('INVALID_CATALOG');
  const plans: Catalog['plans'] = new Map();
  for (const p of offer.plans as unknown[]) {
    if (!plain(p) || !isPackage(p.code) || plans.has(p.code) || !(p.baseNetMinor === null || minor(p.baseNetMinor)) ||
        !validQty(p.cvIncluded) || !COMMERCIAL.includes(p.commercialStatus as CommercialStatus) ||
        !(p.capabilityCode === null || isCode(p.capabilityCode))) return fail('INVALID_CATALOG');
    const cv = checkCvPolicy(p.cvPolicy);
    if (p.cvIncluded > cv.max) return fail('INVALID_CV_POLICY');
    // Missing overage rule is allowed only while no overage is reachable (checked at publish and quote).
    const overage = p.cvOverageRule === null || p.cvOverageRule === undefined ? null : checkRule(p.cvOverageRule);
    plans.set(p.code, { plan: p as unknown as Plan, cv, overage });
  }
  const services: Catalog['services'] = new Map();
  for (const s of offer.services as unknown[]) {
    if (!plain(s) || !isCode(s.code) || services.has(s.code) || typeof s.name !== 'string' ||
        !Array.isArray(s.dependencies) || !Array.isArray(s.exclusions) ||
        !s.dependencies.every(isCode) || !s.exclusions.every(isCode) || !uniq(s.dependencies) || !uniq(s.exclusions) ||
        s.dependencies.includes(s.code) || s.exclusions.includes(s.code) ||
        s.dependencies.some(d => (s.exclusions as unknown[]).includes(d)) ||
        !COMMERCIAL.includes(s.commercialStatus as CommercialStatus) || !TECHNICAL.includes(s.technicalStatus as TechnicalStatus) ||
        !(s.capabilityCode === null || isCode(s.capabilityCode)) ||
        !validQty(s.min) || !validQty(s.max) || !validQty(s.step) || s.step === 0 || s.min > s.max)
      return fail('INVALID_CATALOG');
    const rule = s.defaultPriceRule === null || s.defaultPriceRule === undefined ? null : checkRule(s.defaultPriceRule);
    services.set(s.code, { service: s as unknown as Service, rule });
  }
  // A typo in a dependency/exclusion target must not silently weaken it; cycles are rejected.
  for (const { service } of Array.from(services.values()))
    if (service.dependencies.some(c => !services.has(c)) || service.exclusions.some(c => !services.has(c)))
      return fail('INVALID_CATALOG');
  const state = new Map<string, 1 | 2>();
  const visit = (code: string): void => {
    if (state.get(code) === 2) return;
    if (state.get(code) === 1) return fail('DEPENDENCY_CYCLE');
    state.set(code, 1);
    for (const d of services.get(code)!.service.dependencies) visit(d);
    state.set(code, 2);
  };
  for (const code of Array.from(services.keys())) visit(code);

  const links: Catalog['links'] = new Map();
  for (const l of offer.planServices as unknown[]) {
    if (!plain(l) || !isPackage(l.packageCode) || !plans.has(l.packageCode) || !isCode(l.serviceCode) ||
        !services.has(l.serviceCode) || !validQty(l.includedQuantity) || !validQty(l.maxQuantity) ||
        !validQty(l.quantityStep) || l.quantityStep === 0 || l.maxQuantity < l.includedQuantity ||
        !COMMERCIAL.includes(l.commercialStatus as CommercialStatus) ||
        !isBool(l.allowed) || !isBool(l.visible) || !isBool(l.extraAllowed) || !isBool(l.autoPurchase))
      return fail('INVALID_CATALOG');
    // Contradictory flags (contract: autoPurchase semantics).
    if ((l.autoPurchase && (!l.allowed || l.commercialStatus !== 'purchasable')) ||
        (!l.allowed && (l.autoPurchase || l.visible)) ||
        (l.commercialStatus === 'hidden' && l.visible)) return fail('CONTRADICTORY_FLAGS');
    const global = services.get(l.serviceCode)!.service;
    // 0 <= included <= max <= service.max; link step must be a multiple of the service step.
    if (l.maxQuantity > global.max || l.quantityStep % global.step !== 0 ||
        (l.includedQuantity > 0 && l.includedQuantity < global.min)) return fail('SERVICE_LIMIT_EXCEEDED');
    const perPackage = links.get(l.packageCode) ?? new Map();
    if (perPackage.has(l.serviceCode)) return fail('INVALID_CATALOG');
    const override = l.overridePriceRule === null || l.overridePriceRule === undefined ? null : checkRule(l.overridePriceRule);
    perPackage.set(l.serviceCode, { link: l as unknown as PlanService, rule: override ?? services.get(l.serviceCode)!.rule });
    links.set(l.packageCode, perPackage);
  }
  const discountCodes = new Set<string>();
  for (const d of offer.discounts as unknown[]) {
    if (!exact(d, ['code', 'method', 'value', 'eligiblePackages']) || !isCode(d.code) || discountCodes.has(d.code) ||
        !Array.isArray(d.eligiblePackages) || !d.eligiblePackages.every(isPackage) || !uniq(d.eligiblePackages) ||
        !(d.method === 'percent' ? percentage(d.value) : d.method === 'amount' ? minor(d.value) : false))
      return fail('INVALID_DISCOUNT');
    discountCodes.add(d.code);
  }
  return { plans, services, links, discounts: offer.discounts as DiscountRule[] };
}

function checkOfferHeader(offer: Offer): void {
  if (!plain(offer) || typeof offer.versionId !== 'string' || !versionPattern.test(offer.versionId) ||
      offer.currency !== 'PLN' || !percentage(offer.vatBasisPoints) || !isBool(offer.approved) ||
      !Array.isArray(offer.plans) || !Array.isArray(offer.services) ||
      !Array.isArray(offer.planServices) || !Array.isArray(offer.discounts)) return fail('INVALID_CATALOG');
}

const excludesEither = (services: Catalog['services'], a: string, b: string): boolean =>
  services.get(a)!.service.exclusions.includes(b) || services.get(b)!.service.exclusions.includes(a);
/** Selecting a service forces its transitive dependency closure (the service itself included). */
function dependencyClosure(services: Catalog['services'], code: string): Set<string> {
  const seen = new Set<string>(), stack = [code];
  while (stack.length) {
    const x = stack.pop()!;
    if (seen.has(x)) continue;
    seen.add(x);
    for (const d of services.get(x)!.service.dependencies) stack.push(d);
  }
  return seen;
}
const closuresClash = (services: Catalog['services'], a: ReadonlySet<string>, b: Iterable<string>): boolean => {
  for (const x of Array.from(a)) for (const y of Array.from(b)) if (x !== y && excludesEither(services, x, y)) return true;
  return false;
};

/** Maximum total weight over add-on sets the quote engine can accept together: `forced` services
 * (included in the package, plus their required dependency closure) are in every quote, and no two
 * services in the union of the selected services' dependency closures may exclude each other.
 * Every non-forced key of `weight` must already be selectable on its own (see validateOfferForPublish).
 * Exact for conflict components of up to 20 services; larger components fall back to their plain sum,
 * which is conservative (may reject a valid catalog, never accepts an unquotable one). */
function maxCompatibleSum(weight: ReadonlyMap<string, bigint>, forced: ReadonlySet<string>,
  services: Catalog['services']): bigint {
  // Conflicts are judged on dependency closures, not only on the selected services.
  const closure = new Map<string, Set<string>>();
  let total = ZERO;
  for (const c of Array.from(weight.keys())) if (forced.has(c)) total += weight.get(c)!;
  const free = Array.from(weight.keys()).filter(c => !forced.has(c));
  for (const c of free) closure.set(c, dependencyClosure(services, c));
  const conflict = (a: string, b: string): boolean => closuresClash(services, closure.get(a)!, closure.get(b)!);
  const seen = new Set<string>();
  for (const start of free) {
    if (seen.has(start)) continue;
    const component: string[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const c = stack.pop()!;
      component.push(c);
      for (const o of free) if (!seen.has(o) && conflict(c, o)) { seen.add(o); stack.push(o); }
    }
    if (component.length > 20) { for (const c of component) total += weight.get(c)!; continue; }
    let best = ZERO;
    for (let mask = 0; mask < 1 << component.length; mask++) {
      let sum = ZERO, ok = true;
      for (let i = 0; i < component.length && ok; i++) {
        if (!(mask & (1 << i))) continue;
        for (let j = i + 1; j < component.length; j++)
          if (mask & (1 << j) && conflict(component[i], component[j])) { ok = false; break; }
        sum += weight.get(component[i])!;
      }
      if (ok && sum > best) best = sum;
    }
    total += best;
  }
  return total;
}

/** Publish-time validation (contract: "Walidacja przed publish"). Pure; the DB publish RPC must call an
 * equivalent check in the same transaction. Returns the maximal reachable gross per plan. */
export function validateOfferForPublish(offer: Offer): Readonly<Record<string, number>> {
  checkOfferHeader(offer);
  const catalog = checkCatalog(offer);
  const maxGross: Record<string, number> = {};
  for (const [code, { plan, cv, overage }] of Array.from(catalog.plans.entries())) {
    if (plan.commercialStatus === 'purchasable' && (plan.baseNetMinor === null || plan.capabilityCode === null))
      return fail('PURCHASABLE_REQUIRES_PRICE_AND_CAPABILITY');
    let net = BigInt(plan.baseNetMinor ?? 0);
    // Billed CV = allowed count − cvIncluded, for allowed counts above cvIncluded.
    const cvLargest: LargestIn = (lo, hi) => {
      const n = cv.largest(lo + plan.cvIncluded, hi + plan.cvIncluded);
      return n === null || n <= plan.cvIncluded ? null : n - plan.cvIncluded;
    };
    if (cvLargest(1, MAX_QUANTITY) !== null) {
      if (!overage) return fail('UNPRICED');
      net += BigInt(amount(upperBound(overage, cvLargest)));
    }
    // Per-add-on maxima, then the best *compatible* combination (exclusions respected).
    const planLinks = catalog.links.get(code) ?? new Map();
    const forced = new Set<string>();
    const weight = new Map<string, bigint>();
    for (const [serviceCode, { link }] of Array.from(planLinks.entries()))
      if (link.allowed && link.includedQuantity > 0) forced.add(serviceCode);
    const excludedByForced = (c: string): boolean => Array.from(forced).some(f =>
      catalog.services.get(c)!.service.exclusions.includes(f) || catalog.services.get(f)!.service.exclusions.includes(c));
    // Always-present services that exclude each other would make every quote of the plan fail.
    const forcedList = Array.from(forced);
    for (let i = 0; i < forcedList.length; i++)
      for (let j = i + 1; j < forcedList.length; j++)
        if (catalog.services.get(forcedList[i])!.service.exclusions.includes(forcedList[j]) ||
            catalog.services.get(forcedList[j])!.service.exclusions.includes(forcedList[i]))
          return fail(`INCLUDED_SERVICES_CONFLICT:${code}`);
    // Transitive dependencies of always-present services must be realizable in this package:
    // present (included) or selectable with a positive quantity, and not excluded by an included service.
    // A non-included service is selectable only through extra quantity, so at least one positive multiple
    // of the package step must fit under the package maximum and reach the service minimum.
    const selectable = (c: string): boolean => {
      const entry = planLinks.get(c);
      if (!entry) return false;
      const l = entry.link, svc = catalog.services.get(c)!.service;
      return l.allowed && l.visible && l.extraAllowed && l.commercialStatus !== 'hidden' && svc.commercialStatus !== 'hidden' &&
        !excludedByForced(c) && stepLargestIn(l.quantityStep, l.maxQuantity - l.includedQuantity,
          Math.max(1, svc.min - l.includedQuantity))(1, MAX_QUANTITY) !== null;
    };
    const pending = [...forcedList], required = new Set<string>();
    while (pending.length) {
      const c = pending.pop()!;
      if (required.has(c)) continue;
      required.add(c);
      for (const dep of catalog.services.get(c)!.service.dependencies) {
        if (!forced.has(dep) && !selectable(dep)) return fail(`INCLUDED_DEPENDENCY_UNREALIZABLE:${code}:${dep}`);
        pending.push(dep);
      }
    }
    // Everything in the required closure must be present together, so it must be exclusion-free.
    const requiredList = Array.from(required);
    // quoteOffer does not auto-select dependencies: every non-included member of the required closure
    // must be requested explicitly, so the closure must fit in one request.
    if (requiredList.filter(c => !forced.has(c)).length > MAX_ADDONS)
      return fail(`INCLUDED_DEPENDENCIES_EXCEED_REQUEST_LIMIT:${code}`);
    for (let i = 0; i < requiredList.length; i++)
      for (let j = i + 1; j < requiredList.length; j++) {
        const a = catalog.services.get(requiredList[i])!.service, b = catalog.services.get(requiredList[j])!.service;
        if (a.exclusions.includes(b.code) || b.exclusions.includes(a.code))
          return fail(`INCLUDED_DEPENDENCY_CONFLICT:${code}:${a.code < b.code ? a.code + ':' + b.code : b.code + ':' + a.code}`);
      }
    for (const [serviceCode, { link, rule }] of Array.from(planLinks.entries())) {
      if (!link.allowed || !link.extraAllowed) continue;
      // Extra quantity is reachable only through an explicit add-on selection, which quoteOffer
      // accepts only for visible, non-hidden links of non-hidden services (same rule as quoting).
      if (!link.visible || link.commercialStatus === 'hidden' ||
          catalog.services.get(serviceCode)!.service.commercialStatus === 'hidden') continue;
      // An optional add-on is reachable only if its whole dependency closure can be provided by the
      // package and is free of exclusions, internally and against the always-present services.
      // Filter before pricing, so an unreachable line cannot fail the bound (AMOUNT_OUT_OF_RANGE etc.).
      if (!required.has(serviceCode)) {
        const own = dependencyClosure(catalog.services, serviceCode);
        if (!Array.from(own).every(c => required.has(c) || selectable(c)) ||
            closuresClash(catalog.services, own, own) || closuresClash(catalog.services, own, required)) continue;
      }
      const svcMin = catalog.services.get(serviceCode)!.service.min;
      const largest = stepLargestIn(link.quantityStep, link.maxQuantity - link.includedQuantity,
        Math.max(1, svcMin - link.includedQuantity));
      if (largest(1, MAX_QUANTITY) === null) continue;
      if (!rule) return fail(`UNPRICED:${serviceCode}`);
      weight.set(serviceCode, BigInt(amount(upperBound(rule, largest))));
    }
    // Every quote contains the whole required closure, so its members are mandatory in the bound too.
    net += maxCompatibleSum(weight, required, catalog.services);
    amount(net);
    amount(net); // undiscounted subtotal must itself fit (it is a quote field)
    // Discounts are monotonic non-decreasing in net, so the maximal net stays maximal after them;
    // apply the same ordered calculation as quoting before VAT.
    let discounted = net;
    for (const d of catalog.discounts) {
      if (!d.eligiblePackages.includes(code)) continue;
      const applied = d.method === 'percent' ? halfUp(discounted * BigInt(d.value), BigInt(10000)) : BigInt(d.value);
      discounted -= applied > discounted ? discounted : applied;
    }
    maxGross[code] = amount(discounted + vatOf(discounted, offer.vatBasisPoints));
  }
  return maxGross;
}

function checkedRequest(input: unknown): QuoteRequest {
  if (!exact(input, ['expectedVersionId', 'packageCode', 'cvCount', 'addons']) ||
      typeof input.expectedVersionId !== 'string' || !versionPattern.test(input.expectedVersionId) ||
      !isPackage(input.packageCode) || !validQty(input.cvCount) || !Array.isArray(input.addons) || input.addons.length > MAX_ADDONS)
    return fail('INVALID_REQUEST');
  const codes = new Set<string>();
  for (const a of input.addons as unknown[]) {
    if (!exact(a, ['serviceCode', 'quantity']) || !isCode(a.serviceCode) || !validQty(a.quantity) || codes.has(a.serviceCode))
      return fail('INVALID_ADDON');
    codes.add(a.serviceCode);
  }
  return input as unknown as QuoteRequest;
}

/** Preview requires a separately authorized owner API. NEVER derive allowDraft from a browser field. */
export function quoteOffer(offer: Offer, untrustedRequest: unknown,
  runtimeCapabilities: ReadonlySet<string>, options: Readonly<{ allowDraft?: boolean }> = {}): Quote {
  const input = checkedRequest(untrustedRequest);
  const draftPreview = options.allowDraft === true && plain(offer) && offer.status === 'DRAFT';
  if (!plain(offer) || !(offer.status === 'PUBLISHED' && offer.approved === true) && !draftPreview)
    return fail('OFFER_NOT_APPROVED');
  checkOfferHeader(offer);
  const ready = capabilitySnapshot(runtimeCapabilities);
  if (input.expectedVersionId !== offer.versionId) return fail('STALE_VERSION');
  const catalog = checkCatalog(offer);

  const entry = catalog.plans.get(input.packageCode);
  if (!entry || entry.plan.commercialStatus === 'hidden' || !entry.cv.allowed(input.cvCount)) return fail('PLAN_UNAVAILABLE');
  const { plan } = entry;
  if (plan.baseNetMinor === null) return fail('UNPRICED');
  const links = catalog.links.get(plan.code) ?? new Map();

  const desired = new Map<string, number>();
  for (const [code, { link }] of Array.from(links.entries()))
    if (link.allowed && link.includedQuantity > 0) desired.set(code, link.includedQuantity);
  for (const add of input.addons) {
    const found = links.get(add.serviceCode);
    const s = catalog.services.get(add.serviceCode)?.service;
    if (!found || !s || !found.link.allowed || !found.link.visible || found.link.commercialStatus === 'hidden' ||
        s.commercialStatus === 'hidden') return fail('ADDON_UNAVAILABLE');
    const l = found.link;
    const qty = add.quantity === 0 ? l.includedQuantity : add.quantity;
    if (qty < l.includedQuantity || qty > l.maxQuantity || (qty > 0 && qty < s.min) ||
        (qty > l.includedQuantity && (!l.extraAllowed || (qty - l.includedQuantity) % l.quantityStep !== 0)))
      return fail('INVALID_QUANTITY');
    desired.set(add.serviceCode, qty);
  }
  for (const [code, qty] of Array.from(desired.entries())) {
    if (qty === 0) continue;
    const s = catalog.services.get(code)!.service;
    if (s.dependencies.some(c => (desired.get(c) ?? 0) <= 0)) return fail('UNMET_DEPENDENCY');
    if (s.exclusions.some(c => (desired.get(c) ?? 0) > 0)) return fail('MUTUAL_EXCLUSION');
  }

  const blocked = new Set<string>();
  const unavailable = new Set<string>();
  const capability = (cap: string | null, fallback: string, verified = true): void => {
    if (cap === null || !verified || !ready.has(cap)) {
      blocked.add(`CAPABILITY_UNAVAILABLE:${cap ?? fallback}`);
      unavailable.add(cap ?? fallback);
    }
  };
  if (plan.commercialStatus === 'on_request') blocked.add(`ON_REQUEST_PRICE:${plan.code}`);
  else if (plan.commercialStatus !== 'purchasable') blocked.add('PACKAGE_NOT_PURCHASABLE');
  capability(plan.capabilityCode, plan.code);

  const lines: QuoteLine[] = [{ kind: 'base', code: plan.code, quantity: 1, included: 0, billed: 1, netMinor: amount(BigInt(plan.baseNetMinor)) }];
  let subtotal = BigInt(plan.baseNetMinor);
  const cvBilled = Math.max(0, input.cvCount - plan.cvIncluded);
  if (cvBilled) {
    if (!entry.overage) return fail('UNPRICED');
    const price = amount(priceOf(entry.overage, cvBilled));
    subtotal += BigInt(price);
    lines.push({ kind: 'cv_overage', code: 'cv', quantity: input.cvCount, included: plan.cvIncluded, billed: cvBilled, netMinor: price });
  }
  for (const [code, { link, rule }] of Array.from(links.entries())) {
    const qty = desired.get(code) ?? 0;
    if (!qty) continue;
    const s = catalog.services.get(code)!.service;
    const billable = Math.max(0, qty - link.includedQuantity);
    if (billable && !rule) return fail('UNPRICED');
    const price = billable ? amount(priceOf(rule!, billable)) : 0;
    subtotal += BigInt(price);
    lines.push({ kind: 'service', code, quantity: qty, included: link.includedQuantity, billed: billable, netMinor: price });
    capability(s.capabilityCode, code, s.technicalStatus === 'verified');
    if (billable && (!link.autoPurchase || link.commercialStatus !== 'purchasable' || s.commercialStatus !== 'purchasable'))
      blocked.add(`ADDON_REQUIRES_OPERATOR:${code}`);
  }
  amount(subtotal);
  let discounted = subtotal, discountTotal = ZERO;
  for (const d of catalog.discounts) {
    if (!d.eligiblePackages.includes(plan.code)) continue;
    const applied = d.method === 'percent' ? halfUp(discounted * BigInt(d.value), BigInt(10000)) : BigInt(d.value);
    const actual = applied > discounted ? discounted : applied;
    discounted -= actual;
    discountTotal += actual;
    lines.push({ kind: 'discount', code: d.code, quantity: 1, included: 0, billed: 1, netMinor: -amount(actual) });
  }
  const vat = vatOf(discounted, offer.vatBasisPoints);
  if (offer.status !== 'PUBLISHED') blocked.add('DRAFT_PREVIEW');
  const blockedReasons = Array.from(blocked).sort();
  return {
    versionId: offer.versionId, packageCode: plan.code, currency: 'PLN', vatBasisPoints: offer.vatBasisPoints,
    lines, subtotalNetMinor: amount(subtotal), discountMinor: amount(discountTotal),
    netMinor: amount(discounted), vatMinor: amount(vat), grossMinor: amount(discounted + vat),
    canPurchase: blockedReasons.length === 0,
    unavailableCapabilities: Array.from(unavailable).sort(),
    blockedReasons,
  };
}
