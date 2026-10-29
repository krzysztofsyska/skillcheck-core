/** Owner-only internal pricing calculator (prototype for SC-PRICING-006/007, #143/#144).
 * Turns an editable owner configuration into a DRAFT offer for the SC-PRICING-003 quote engine,
 * so the internal calculator prices exactly like the customer-facing quote will once connected.
 * Costs and margins live only here: they are never part of the Offer or the Quote.
 * Not connected to the database, the public calculator or checkout yet.
 */
import {
  PricingError, quoteOffer, validateOfferForPublish,
  type Offer, type PackageCode, type PlanService, type Quote, type Service,
} from './quote-engine';

export const PACKAGE_CODES: readonly PackageCode[] = ['FREE', 'PRESELEKCJA', 'WERYFIKACJA', 'ASSESSMENT_CENTER'];
export const PACKAGE_LABELS: Readonly<Record<PackageCode, string>> = {
  FREE: 'FREE', PRESELEKCJA: 'PRESELEKCJA', WERYFIKACJA: 'WERYFIKACJA', ASSESSMENT_CENTER: 'ASSESSMENT CENTER',
};
const MAX_UNITS = 10_000;
const MAX_MINOR = 1_000_000_000_000;

export type PackageSettings = {
  /** Base price for the package, PLN grosze, gross (with VAT). */
  grossMinor: number;
  cvIncluded: number;
  /** CV counts a customer can choose; cvIncluded is always selectable. */
  cvOptions: number[];
  /** Price per CV above cvIncluded, PLN grosze, gross. */
  overageGrossPerCvMinor: number;
};
export type AddonPackageSettings = { enabled: boolean; included: number; unitGrossMinor: number };
export type AddonSettings = {
  code: string; name: string; unit: string;
  /** Owner's own cost per delivered unit, PLN grosze, net. Never sent to customers. */
  unitCostMinor: number;
  packages: Record<PackageCode, AddonPackageSettings>;
};
export type InternalConfig = {
  version: 1;
  vatBasisPoints: number;
  /** Own cost of analysing one CV, PLN grosze, net. */
  cvCostMinor: number;
  /** Payment provider fee as basis points of the gross amount. */
  paymentFeeBasisPoints: number;
  /** Own fixed cost per order (onboarding, invoicing), PLN grosze, net. */
  fixedCostPerOrderMinor: number;
  packages: Record<PackageCode, PackageSettings>;
  addons: AddonSettings[];
};
export type Scenario = {
  packageCode: PackageCode; cvCount: number;
  /** Total quantity per add-on, including the units the package includes. */
  quantities: Record<string, number>;
  ordersPerMonth: number;
};
export type CostLine = { code: string; label: string; quantity: number; costMinor: number };
export type Calculation =
  | { ok: true; quote: Quote; costs: CostLine[]; costMinor: number; marginMinor: number;
      marginBasisPoints: number | null; monthly: { grossMinor: number; netMinor: number; costMinor: number; marginMinor: number } }
  | { ok: false; code: string };

const addon = (code: string, name: string, unit: string, included: Partial<Record<PackageCode, number>> = {}): AddonSettings => ({
  code, name, unit, unitCostMinor: 0,
  packages: {
    FREE: { enabled: (included.FREE ?? 0) > 0, included: included.FREE ?? 0, unitGrossMinor: 0 },
    PRESELEKCJA: { enabled: true, included: included.PRESELEKCJA ?? 0, unitGrossMinor: 0 },
    WERYFIKACJA: { enabled: true, included: included.WERYFIKACJA ?? 0, unitGrossMinor: 0 },
    ASSESSMENT_CENTER: { enabled: true, included: included.ASSESSMENT_CENTER ?? 0, unitGrossMinor: 0 },
  },
});

/** Structure from the owner's private price sheet (SkillCheck_prywatny_cennik). Only the
 * PRESELEKCJA 60 CV / 300 zł gross price is owner-approved; every other amount starts at 0. */
export function defaultConfig(): InternalConfig {
  return {
    version: 1, vatBasisPoints: 2300, cvCostMinor: 0, paymentFeeBasisPoints: 0, fixedCostPerOrderMinor: 0,
    packages: {
      FREE: { grossMinor: 0, cvIncluded: 5, cvOptions: [1, 2, 3, 4, 5], overageGrossPerCvMinor: 0 },
      PRESELEKCJA: { grossMinor: 30_000, cvIncluded: 60, cvOptions: [30, 50, 60, 100, 150], overageGrossPerCvMinor: 0 },
      WERYFIKACJA: { grossMinor: 0, cvIncluded: 60, cvOptions: [30, 50, 60, 100, 150], overageGrossPerCvMinor: 0 },
      ASSESSMENT_CENTER: { grossMinor: 0, cvIncluded: 60, cvOptions: [30, 50, 60, 100, 150], overageGrossPerCvMinor: 0 },
    },
    addons: [
      addon('interview', 'Rozmowa AI', 'rozmowa', { WERYFIKACJA: 20, ASSESSMENT_CENTER: 20 }),
      addon('skill_test', 'Test kompetencji', 'test', { WERYFIKACJA: 20, ASSESSMENT_CENTER: 20 }),
      addon('case_study', 'Zadanie / case study', 'zadanie', { ASSESSMENT_CENTER: 10 }),
      addon('expert_consult', 'Konsultacja ekspercka', 'godzina', { ASSESSMENT_CENTER: 2 }),
      addon('user_account', 'Konto użytkownika', 'konto', { FREE: 2, PRESELEKCJA: 2, WERYFIKACJA: 2, ASSESSMENT_CENTER: 2 }),
      addon('report', 'Raport PDF/CSV', 'raport', { FREE: 1, PRESELEKCJA: 1, WERYFIKACJA: 1, ASSESSMENT_CENTER: 1 }),
      addon('position', 'Stanowisko / profil', 'stanowisko', { FREE: 1, PRESELEKCJA: 1, WERYFIKACJA: 1, ASSESSMENT_CENTER: 1 }),
      addon('email', 'Wiadomość e-mail', 'wiadomość'),
      addon('sms', 'SMS', 'SMS'),
      addon('ocr_page', 'Strona OCR', 'strona'),
      addon('ai_task', 'Wygenerowanie zadania przez AI', 'zadanie'),
      addon('manual_cv_review', 'Manualny review CV', 'CV'),
      addon('priority_sla', 'Priorytetowe SLA / obsługa', 'godzina'),
      addon('support_hours', 'Godziny wsparcia', 'godzina'),
      addon('ats_integration', 'Integracja ATS / API / SSO', 'wdrożenie'),
      addon('branding', 'Branding / raport dedykowany', 'wdrożenie'),
      addon('localization', 'Język dodatkowy / lokalizacja', 'wdrożenie'),
      addon('custom_contract', 'Umowa indywidualna / DPA', 'umowa'),
      addon('talent_pool', 'Talent Pool — kandydat-miesiąc', 'kand.-mies.'),
      addon('quality_of_hire', 'Quality of Hire — pomiar', 'kontakt'),
    ],
  };
}

const int = (n: unknown, max: number): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= max;
const obj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Strict parser for imported or stored configurations; returns null for anything malformed. */
export function parseConfig(input: unknown): InternalConfig | null {
  if (!obj(input) || input.version !== 1 || !int(input.vatBasisPoints, 10_000) || !int(input.cvCostMinor, MAX_MINOR) ||
      !int(input.paymentFeeBasisPoints, 10_000) || !int(input.fixedCostPerOrderMinor, MAX_MINOR) ||
      !obj(input.packages) || !Array.isArray(input.addons) || input.addons.length > 200) return null;
  const packages = {} as Record<PackageCode, PackageSettings>;
  for (const code of PACKAGE_CODES) {
    const p = input.packages[code];
    if (!obj(p) || !int(p.grossMinor, MAX_MINOR) || !int(p.cvIncluded, MAX_UNITS) || !int(p.overageGrossPerCvMinor, MAX_MINOR) ||
        !Array.isArray(p.cvOptions) || p.cvOptions.length > 30 || !p.cvOptions.every(n => int(n, MAX_UNITS) && n > 0)) return null;
    packages[code] = { grossMinor: p.grossMinor, cvIncluded: p.cvIncluded, cvOptions: p.cvOptions as number[], overageGrossPerCvMinor: p.overageGrossPerCvMinor };
  }
  const codes = new Set<string>();
  const addons: AddonSettings[] = [];
  for (const a of input.addons as unknown[]) {
    if (!obj(a) || typeof a.code !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(a.code) || codes.has(a.code) ||
        typeof a.name !== 'string' || a.name.length > 120 || typeof a.unit !== 'string' || a.unit.length > 40 ||
        !int(a.unitCostMinor, MAX_MINOR) || !obj(a.packages)) return null;
    const per = {} as Record<PackageCode, AddonPackageSettings>;
    for (const code of PACKAGE_CODES) {
      const s = a.packages[code];
      if (!obj(s) || typeof s.enabled !== 'boolean' || !int(s.included, MAX_UNITS) || !int(s.unitGrossMinor, MAX_MINOR)) return null;
      per[code] = { enabled: s.enabled, included: s.included, unitGrossMinor: s.unitGrossMinor };
    }
    codes.add(a.code);
    addons.push({ code: a.code, name: a.name, unit: a.unit, unitCostMinor: a.unitCostMinor, packages: per });
  }
  return { version: 1, vatBasisPoints: input.vatBasisPoints, cvCostMinor: input.cvCostMinor, paymentFeeBasisPoints: input.paymentFeeBasisPoints,
    fixedCostPerOrderMinor: input.fixedCostPerOrderMinor, packages, addons };
}

/** Gross → net in grosze, half-up, so that net + VAT rounds back to the entered gross where possible. */
export const netFromGross = (grossMinor: number, vatBasisPoints: number): number =>
  Math.floor((grossMinor * 10_000 * 2 + (10_000 + vatBasisPoints)) / (2 * (10_000 + vatBasisPoints)));

export const cvChoices = (p: PackageSettings): number[] =>
  Array.from(new Set([...p.cvOptions, p.cvIncluded].filter(n => n > 0))).sort((a, b) => a - b);

const capability = (code: string) => `${code}_ready`;

/** Builds the DRAFT offer the quote engine prices. Only prices and quantities; no costs. */
export function toOffer(config: InternalConfig): Offer {
  const vat = config.vatBasisPoints;
  const services: Service[] = config.addons.map(a => ({
    code: a.code, name: a.name, technicalStatus: 'verified', min: 0, max: MAX_UNITS, step: 1,
    commercialStatus: 'purchasable', capabilityCode: capability(a.code), dependencies: [], exclusions: [], defaultPriceRule: null,
  }));
  const planServices: PlanService[] = [];
  for (const a of config.addons) for (const code of PACKAGE_CODES) {
    const s = a.packages[code];
    if (!s.enabled) continue;
    planServices.push({
      packageCode: code, serviceCode: a.code, allowed: true, visible: true, includedQuantity: s.included,
      maxQuantity: Math.min(MAX_UNITS, s.included + 1_000), quantityStep: 1, extraAllowed: true, autoPurchase: true,
      commercialStatus: 'purchasable', overridePriceRule: { method: 'per_unit', unitMinor: netFromGross(s.unitGrossMinor, vat) },
    });
  }
  return {
    versionId: 'internal-draft', status: 'DRAFT', approved: false, currency: 'PLN', vatBasisPoints: vat,
    plans: PACKAGE_CODES.map(code => {
      const p = config.packages[code];
      return {
        code, baseNetMinor: netFromGross(p.grossMinor, vat), commercialStatus: 'purchasable' as const,
        cvIncluded: p.cvIncluded, cvPolicy: { quick: cvChoices(p), range: null },
        cvOverageRule: { method: 'per_unit' as const, unitMinor: netFromGross(p.overageGrossPerCvMinor, vat) },
        capabilityCode: capability(code.toLowerCase()),
      };
    }),
    services, planServices, discounts: [],
  };
}

const capabilities = (config: InternalConfig): ReadonlySet<string> =>
  new Set([...PACKAGE_CODES.map(c => capability(c.toLowerCase())), ...config.addons.map(a => capability(a.code))]);

/** Same check the database publish step will run; returns stable error codes, never throws. */
export function validateConfig(config: InternalConfig): { ok: true; maxGross: Readonly<Record<string, number>> } | { ok: false; code: string } {
  try {
    return { ok: true, maxGross: validateOfferForPublish(toOffer(config)) };
  } catch (error) {
    if (error instanceof PricingError) return { ok: false, code: error.code };
    throw error;
  }
}

const share = (amount: number, basisPoints: number) => Math.floor((amount * basisPoints * 2 + 10_000) / 20_000);

/** Customer price from the quote engine, plus the owner's own costs and margin for that order. */
export function calculate(config: InternalConfig, scenario: Scenario): Calculation {
  const addons = config.addons
    .filter(a => a.packages[scenario.packageCode].enabled)
    .map(a => ({ a, total: Math.max(a.packages[scenario.packageCode].included, scenario.quantities[a.code] ?? 0) }));
  let quote: Quote;
  try {
    quote = quoteOffer(toOffer(config), {
      expectedVersionId: 'internal-draft', packageCode: scenario.packageCode, cvCount: scenario.cvCount,
      addons: addons.filter(({ a, total }) => total > a.packages[scenario.packageCode].included)
        .map(({ a, total }) => ({ serviceCode: a.code, quantity: total })),
    }, capabilities(config), { allowDraft: true });
  } catch (error) {
    if (error instanceof PricingError) return { ok: false, code: error.code };
    throw error;
  }
  const costs: CostLine[] = [{ code: 'cv', label: 'Analiza CV', quantity: scenario.cvCount, costMinor: scenario.cvCount * config.cvCostMinor }];
  for (const { a, total } of addons) if (total > 0) costs.push({ code: a.code, label: a.name, quantity: total, costMinor: total * a.unitCostMinor });
  costs.push({ code: 'payment_fee', label: 'Opłata za płatność', quantity: 1, costMinor: share(quote.grossMinor, config.paymentFeeBasisPoints) });
  costs.push({ code: 'fixed', label: 'Koszt stały zamówienia', quantity: 1, costMinor: config.fixedCostPerOrderMinor });
  const costMinor = costs.reduce((sum, c) => sum + c.costMinor, 0);
  const marginMinor = quote.netMinor - costMinor;
  const orders = Math.max(0, Math.floor(scenario.ordersPerMonth));
  return {
    ok: true, quote, costs, costMinor, marginMinor,
    marginBasisPoints: quote.netMinor > 0 ? Math.round(marginMinor * 10_000 / quote.netMinor) : null,
    monthly: { grossMinor: quote.grossMinor * orders, netMinor: quote.netMinor * orders, costMinor: costMinor * orders, marginMinor: marginMinor * orders },
  };
}

/** "1 234,56" / "1234.5" / "300" → grosze; null when not a non-negative amount. */
export function parsePln(text: string): number | null {
  const t = text.replace(/\s/g, '').replace(',', '.');
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(t)) return null;
  const [zl, gr = ''] = t.split('.');
  return Number(zl) * 100 + Number((gr + '00').slice(0, 2));
}

export const formatPln = (minor: number): string => {
  const sign = minor < 0 ? '−' : '';
  const abs = Math.abs(minor);
  const zl = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${zl},${String(abs % 100).padStart(2, '0')} zł`;
};

/** Polish messages for the engine codes the calculator can hit. */
export function describeCode(code: string): string {
  const [base, ...rest] = code.split(':');
  const detail = rest.length ? ` (${rest.join(', ')})` : '';
  const messages: Record<string, string> = {
    AMOUNT_OUT_OF_RANGE: 'Kwota przekracza dozwolony zakres.',
    INVALID_CV_POLICY: 'Niepoprawne opcje liczby CV — liczba CV w pakiecie musi być jedną z opcji.',
    PLAN_UNAVAILABLE: 'Tej liczby CV nie da się wybrać w tym pakiecie.',
    INVALID_QUANTITY: 'Niepoprawna ilość dodatku.',
    ADDON_UNAVAILABLE: 'Dodatek jest niedostępny w tym pakiecie.',
    SERVICE_LIMIT_EXCEEDED: 'Ilość przekracza limit usługi.',
    UNPRICED: 'Brakuje ceny.',
    INVALID_CATALOG: 'Niepoprawna konfiguracja katalogu.',
  };
  return (messages[base] ?? 'Błąd wyceny.') + detail + ` [${code}]`;
}
