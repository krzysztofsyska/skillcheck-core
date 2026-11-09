/** SC-021-D: period parsing, form parsing and Polish formatting for the operator AI cost and
 * margin panel (/operator/ai-costs). The database re-checks the operator and every value; this
 * module only keeps malformed input away from the RPCs and turns their numbers into plain text.
 * Money is integers end to end: PLN in grosze, provider costs in micro-units. No floats. */

export const COST_GROUPINGS = {
  company: 'Firma',
  recruitment: 'Rekrutacja',
  candidate: 'Kandydat (pseudonim)',
  package: 'Pakiet',
  model: 'Model',
  provider: 'Dostawca',
  task: 'Rodzaj zadania',
  month: 'Miesiąc',
} as const;
export type CostGrouping = keyof typeof COST_GROUPINGS;

export const MARGIN_GROUPINGS = { company: 'Firma', package: 'Pakiet', month: 'Miesiąc' } as const;
export type MarginGrouping = keyof typeof MARGIN_GROUPINGS;

export const OTHER_COST_CATEGORIES = {
  payment_fee: 'Opłata za płatność',
  sms: 'SMS',
  email: 'E-mail',
  other: 'Inne',
} as const;
export type OtherCostCategory = keyof typeof OTHER_COST_CATEGORIES;

export const PACKAGE_CODES = ['FREE', 'PRESELEKCJA', 'WERYFIKACJA', 'ASSESSMENT_CENTER'] as const;
export type PackageCode = typeof PACKAGE_CODES[number];

export const MARGIN_STATUS = {
  confirmed: 'potwierdzona',
  estimated: 'szacunek',
  unavailable: 'niedostępna',
} as const;

/** Why a margin is an estimate or unavailable, in plain Polish. Unknown codes are shown as they are. */
export const MARGIN_REASONS: Record<string, string> = {
  fx_missing: 'brak kursu waluty — marży nie da się policzyć',
  fx_placeholder: 'kurs waluty testowy',
  placeholder_prices: 'część kosztu AI na stawkach testowych',
  unpriced_attempts: 'część wywołań AI bez stawki (koszt zaniżony)',
  unknown_attempts: 'część wywołań AI z nieznanym kosztem',
  reserved_not_counted: 'rezerwacje budżetu nie są wliczone',
  payments_without_amount: 'wpłaty bez kwoty w systemie (ręczny przydział)',
};

export const AI_COST_NOTICES = {
  fx_saved: 'Kurs zapisany. Dotyczy wywołań od podanej daty.',
  cost_saved: 'Koszt zapisany.',
  invalid: 'Sprawdź dane formularza.',
  confirm: 'Zaznacz potwierdzenie przed zapisem.',
  conflict: 'Nic nie zmieniono: ten wpis był już poprawiony albo formularz wysłano drugi raz z inną treścią. Odśwież stronę.',
  company: 'Nie ma takiej firmy.',
  failed: 'Zapis nie powiódł się. Odśwież stronę i spróbuj ponownie.',
} as const;
export type AiCostNotice = keyof typeof AI_COST_NOTICES;

export function aiCostError(error: { code?: string } | null): AiCostNotice {
  if (error?.code === '22023') return 'invalid';
  if (error?.code === 'PT409') return 'conflict';
  if (error?.code === 'PT404') return 'company';
  return 'failed';
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
};

/** 'YYYY-MM' → 'YYYY-MM-01', or null. */
export function parseMonth(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  if (year < 2020 || year > 2100) return null;
  return `${value}-01`;
}

const monthIndex = (iso: string) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;

/** Current month in Europe/Warsaw as 'YYYY-MM'. */
export function warsawMonth(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit' }).formatToParts(now);
  return `${parts.find(p => p.type === 'year')!.value}-${parts.find(p => p.type === 'month')!.value}`;
}

/** Inclusive month range, at most 24 months (the database enforces the same). Falls back to the current month. */
export function parsePeriod(from: unknown, to: unknown, now = new Date()) {
  const current = `${warsawMonth(now)}-01`;
  const start = parseMonth(from) ?? current;
  const end = parseMonth(to) ?? start;
  if (monthIndex(end) < monthIndex(start) || monthIndex(end) - monthIndex(start) > 23) return { from: current, to: current, adjusted: true };
  return { from: start, to: end, adjusted: false };
}

export function parseGrouping<T extends string>(value: unknown, allowed: Record<T, string>, fallback: T): T {
  return typeof value === 'string' && Object.hasOwn(allowed, value) ? value as T : fallback;
}

/** Exact decimal → integer with `scale` fraction digits ('4,1234' with scale 6 → 4123400). No floats. */
export function parseDecimal(value: string, scale: number): number | null {
  const match = /^(\d{1,9})(?:[.,](\d+))?$/.exec(value.replace(/\s/g, ''));
  if (!match || (match[2] ?? '').length > scale) return null;
  const result = Number(match[1]) * 10 ** scale + Number((match[2] ?? '').padEnd(scale, '0') || '0');
  return Number.isSafeInteger(result) ? result : null;
}

export function parseFxForm(form: FormData) {
  const base = text(form, 'base');
  const rate = parseDecimal(text(form, 'rate'), 6);
  const validFrom = text(form, 'validFrom');
  const note = text(form, 'note');
  const requestKey = text(form, 'requestKey');
  if (!['USD', 'EUR'].includes(base) || rate === null || rate < 1 || rate > 1_000_000_000
    || !/^\d{4}-\d{2}-\d{2}$/.test(validFrom) || Number.isNaN(Date.parse(`${validFrom}T00:00:00Z`))
    || note.length < 3 || note.length > 300 || !uuidPattern.test(requestKey)) return null;
  return {
    request_key: requestKey, base_currency: base, rate_micros: rate,
    // Midnight UTC of the chosen day; the panel says so next to the field.
    valid_from: `${validFrom}T00:00:00Z`, source_note: note, placeholder: text(form, 'placeholder') === 'yes',
  };
}

export function parseOtherCostForm(form: FormData) {
  const month = parseMonth(text(form, 'month'));
  const company = text(form, 'companyId');
  const pkg = text(form, 'package');
  const category = text(form, 'category');
  const amount = parseDecimal(text(form, 'amount'), 2);
  const note = text(form, 'note');
  const supersedes = text(form, 'supersedes');
  const requestKey = text(form, 'requestKey');
  if (!month || !uuidPattern.test(company) || (pkg && !(PACKAGE_CODES as readonly string[]).includes(pkg))
    || !Object.hasOwn(OTHER_COST_CATEGORIES, category) || amount === null || amount > 10_000_000_000
    || note.length > 300 || (supersedes && !uuidPattern.test(supersedes)) || !uuidPattern.test(requestKey)) return null;
  return {
    request_key: requestKey, period_month: month, target_company: company, package_code: pkg || null,
    category, amount_minor: amount, note: note || null, supersedes: supersedes || null,
  };
}

const ZERO = BigInt(0), HUNDRED = BigInt(100), MILLION = BigInt(1_000_000);

/** Grosze → '1234,56 zł' (Polish grouping). Integer split, so no float rounding. null → 'niedostępne'. */
export function formatPln(minor: number | string | null | undefined): string {
  if (minor === null || minor === undefined) return 'niedostępne';
  const value = BigInt(minor);
  const abs = value < ZERO ? -value : value;
  return `${value < ZERO ? '−' : ''}${(abs / HUNDRED).toLocaleString('pl-PL')},${String(abs % HUNDRED).padStart(2, '0')} zł`;
}

/** Micro-units → '1,500000 USD' (exact, six decimals). */
export function formatMicros(micros: number | string, currency: string): string {
  const value = BigInt(micros);
  const whole = value / MILLION;
  const fraction = String(value % MILLION).padStart(6, '0');
  return `${whole.toLocaleString('pl-PL')},${fraction} ${currency === '?' ? '(waluta nieznana)' : currency}`;
}

/** PLN per unit, scaled ×1 000 000 → '4,123456'. */
export function formatRate(rateMicros: number | string): string {
  const value = BigInt(rateMicros);
  return `${value / MILLION},${String(value % MILLION).padStart(6, '0')}`;
}

export type CostMicros = Record<string, { confirmed: number; placeholder: number; reserved: number }>;

/** One line per currency, only the non-zero classes. */
export function describeCostMicros(costs: CostMicros): string[] {
  return Object.entries(costs).sort(([a], [b]) => a.localeCompare(b)).flatMap(([currency, c]) => [
    c.confirmed ? `${formatMicros(c.confirmed, currency)} (stawki zatwierdzone)` : null,
    c.placeholder ? `${formatMicros(c.placeholder, currency)} — szacunek (stawki testowe)` : null,
    c.reserved ? `${formatMicros(c.reserved, currency)} zarezerwowane, niewliczone` : null,
  ].filter((line): line is string => line !== null));
}

export function describeReasons(reasons: readonly string[] | null | undefined): string {
  return (reasons ?? []).map(code => MARGIN_REASONS[code] ?? code).join('; ');
}
