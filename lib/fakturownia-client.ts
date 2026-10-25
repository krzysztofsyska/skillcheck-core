/** SC-BILLING-INVOICE-001 (#165): minimal Fakturownia API client.
 * Server-only. The API token travels as the documented `api_token` query
 * parameter, so request URLs are secrets: never log, return or throw them.
 * Errors carry only a fixed code and an HTTP status number.
 */
export type FakturowniaConfig = Readonly<{ account: string; token: string }>;
export type FakturowniaFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) =>
  Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;

export type FakturowniaErrorCode =
  | 'FAKTUROWNIA_NOT_CONFIGURED' | 'FAKTUROWNIA_CONFIG_INVALID' | 'FAKTUROWNIA_UNAUTHORIZED'
  | 'FAKTUROWNIA_ACCOUNT_NOT_FOUND' | 'FAKTUROWNIA_RATE_LIMITED' | 'FAKTUROWNIA_UNAVAILABLE'
  | 'FAKTUROWNIA_TIMEOUT' | 'FAKTUROWNIA_RESPONSE_INVALID' | 'FAKTUROWNIA_REQUEST_REJECTED';

export class FakturowniaError extends Error {
  readonly code: FakturowniaErrorCode;
  readonly httpStatus: number | null;
  constructor(code: FakturowniaErrorCode, httpStatus: number | null = null) {
    super(code);
    this.name = 'FakturowniaError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Account = subdomain of <account>.fakturownia.pl (RFC 1035 label). */
const ACCOUNT = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Tokens are opaque; reject whitespace/control/URL-structural characters. */
const TOKEN = /^[A-Za-z0-9_\-./]{8,200}$/;

export function readFakturowniaConfig(env: Record<string, string | undefined>): FakturowniaConfig {
  const account = (env.FAKTUROWNIA_ACCOUNT ?? '').trim().toLowerCase().replace(/\.fakturownia\.pl$/, '');
  const token = (env.FAKTUROWNIA_API_TOKEN ?? '').trim();
  if (!account && !token) throw new FakturowniaError('FAKTUROWNIA_NOT_CONFIGURED');
  if (!ACCOUNT.test(account) || !TOKEN.test(token)) throw new FakturowniaError('FAKTUROWNIA_CONFIG_INVALID');
  return Object.freeze({ account, token });
}

export function fakturowniaOrigin(account: string): string {
  if (!ACCOUNT.test(account)) throw new FakturowniaError('FAKTUROWNIA_CONFIG_INVALID');
  return `https://${account}.fakturownia.pl`;
}

function statusError(status: number): FakturowniaError {
  if (status === 401 || status === 403) return new FakturowniaError('FAKTUROWNIA_UNAUTHORIZED', status);
  if (status === 404) return new FakturowniaError('FAKTUROWNIA_ACCOUNT_NOT_FOUND', status);
  if (status === 429) return new FakturowniaError('FAKTUROWNIA_RATE_LIMITED', status);
  if (status >= 500) return new FakturowniaError('FAKTUROWNIA_UNAVAILABLE', status);
  return new FakturowniaError('FAKTUROWNIA_REQUEST_REJECTED', status);
}

export type FakturowniaDepartment = Readonly<{ id: number; name: string; taxNo: string | null }>;
export type FakturowniaInvoice = Readonly<{
  id: number; kind: string; status: string; number: string | null; oid: string | null;
  priceGross: string; paid: string; currency: string; viewToken: string | null;
}>;

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const optText = (v: unknown, max = 200) => (typeof v === 'string' && v.length <= max ? v : null);

function department(v: unknown): FakturowniaDepartment {
  if (!record(v) || !Number.isSafeInteger(v.id)) throw new FakturowniaError('FAKTUROWNIA_RESPONSE_INVALID');
  const name = optText(v.name) ?? optText(v.shortcut) ?? '';
  return Object.freeze({ id: v.id as number, name, taxNo: optText(v.tax_no, 40) });
}

export function parseInvoice(v: unknown): FakturowniaInvoice {
  if (!record(v) || !Number.isSafeInteger(v.id) || typeof v.kind !== 'string' || typeof v.status !== 'string')
    throw new FakturowniaError('FAKTUROWNIA_RESPONSE_INVALID');
  const amount = (x: unknown) => (typeof x === 'string' || typeof x === 'number') ? String(x) : '0';
  return Object.freeze({
    id: v.id as number, kind: v.kind, status: v.status, number: optText(v.number, 100), oid: optText(v.oid, 200),
    priceGross: amount(v.price_gross), paid: amount(v.paid), currency: optText(v.currency, 3) ?? 'PLN',
    viewToken: typeof v.token === 'string' && /^[A-Za-z0-9]{8,64}$/.test(v.token) ? v.token : null,
  });
}

export function createFakturowniaClient(config: FakturowniaConfig, fetchImpl: FakturowniaFetch, timeoutMs = 10_000) {
  const origin = fakturowniaOrigin(config.account);
  async function call(method: 'GET' | 'POST', path: string, query: Record<string, string> = {}, body?: unknown): Promise<unknown> {
    if (!/^\/[a-z_/0-9]+\.json$/.test(path)) throw new FakturowniaError('FAKTUROWNIA_REQUEST_REJECTED');
    const url = new URL(origin + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const headers: Record<string, string> = { Accept: 'application/json' };
    let payload: string | undefined;
    if (method === 'GET') url.searchParams.set('api_token', config.token);
    else { headers['Content-Type'] = 'application/json'; payload = JSON.stringify({ api_token: config.token, ...(body as object) }); }
    const controller = new AbortController();
    // One deadline covers headers AND body: a stalled body must not outlive it.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new FakturowniaError('FAKTUROWNIA_TIMEOUT')); }, timeoutMs);
    });
    deadline.catch(() => undefined);
    try {
      let response;
      try {
        response = await Promise.race([
          fetchImpl(url.toString(), { method, headers, body: payload, signal: controller.signal }), deadline]);
      } catch {
        // Never rethrow the transport error: its message may embed the URL with the token.
        throw new FakturowniaError(controller.signal.aborted ? 'FAKTUROWNIA_TIMEOUT' : 'FAKTUROWNIA_UNAVAILABLE');
      }
      if (!response.ok) throw statusError(response.status);
      try { return await Promise.race([response.json(), deadline]); }
      catch {
        throw new FakturowniaError(controller.signal.aborted ? 'FAKTUROWNIA_TIMEOUT' : 'FAKTUROWNIA_RESPONSE_INVALID',
          controller.signal.aborted ? null : response.status);
      }
    } finally { clearTimeout(timer); }
  }
  return Object.freeze({
    origin,
    /** Read-only connection probe: lists the account's issuing companies. */
    async departments(): Promise<FakturowniaDepartment[]> {
      const data = await call('GET', '/departments.json');
      if (!Array.isArray(data)) throw new FakturowniaError('FAKTUROWNIA_RESPONSE_INVALID');
      return data.slice(0, 50).map(department);
    },
    /** Read-only: count of proformas issued this month (first page only). */
    async proformasThisMonth(): Promise<number> {
      const data = await call('GET', '/invoices.json', { kind: 'proforma', period: 'this_month', per_page: '100', page: '1' });
      if (!Array.isArray(data)) throw new FakturowniaError('FAKTUROWNIA_RESPONSE_INVALID');
      return data.length;
    },
    async invoice(id: number): Promise<FakturowniaInvoice> {
      if (!Number.isSafeInteger(id) || id <= 0) throw new FakturowniaError('FAKTUROWNIA_REQUEST_REJECTED');
      return parseInvoice(await call('GET', `/invoices/${id}.json`));
    },
    publicViewUrl(invoice: FakturowniaInvoice): string | null {
      return invoice.viewToken ? `${origin}/invoice/${invoice.viewToken}` : null;
    },
    /** Issues ONE proforma (non-accounting document, never sent to KSeF).
     * `oid_unique` makes Fakturownia refuse a second document with the same oid,
     * so a retried call cannot create a duplicate. */
    async createProforma(input: ProformaInput): Promise<FakturowniaInvoice> {
      if (!/^sc19:[0-9a-f-]{36}$/.test(input.oid) || !Number.isSafeInteger(input.grossMinor) || input.grossMinor <= 0)
        throw new FakturowniaError('FAKTUROWNIA_REQUEST_REJECTED');
      const invoice = {
        kind: 'proforma', oid: input.oid, oid_unique: 'yes', issue_date: input.issueDate, payment_to_kind: input.paymentDays,
        currency: 'PLN', lang: 'pl', buyer_company: '1', buyer_name: input.buyer.name, buyer_tax_no: input.buyer.nip,
        buyer_street: input.buyer.street, buyer_post_code: input.buyer.postCode, buyer_city: input.buyer.city,
        buyer_country: 'PL', buyer_email: input.buyer.email,
        calculating_strategy: { position: 'keep_gross', sum: 'keep_gross', invoice_form_price_kind: 'gross' },
        positions: [{ name: input.itemName, quantity: 1, quantity_unit: 'usł.', tax: 23,
          total_price_gross: formatMinor(input.grossMinor) }],
        internal_note: `SkillCheck ${input.oid}`,
      };
      return parseInvoice(await call('POST', '/invoices.json', {}, { invoice }));
    },
    /** One page (max 100) of proformas issued between the given Warsaw dates. */
    async proformasIssuedBetween(dateFrom: string, dateTo: string, page: number): Promise<FakturowniaInvoice[]> {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo) || !Number.isSafeInteger(page) || page < 1 || page > 50)
        throw new FakturowniaError('FAKTUROWNIA_REQUEST_REJECTED');
      const data = await call('GET', '/invoices.json', { kind: 'proforma', period: 'more', date_from: dateFrom, date_to: dateTo,
        search_date_type: 'issue_date', per_page: '100', page: String(page) });
      if (!Array.isArray(data)) throw new FakturowniaError('FAKTUROWNIA_RESPONSE_INVALID');
      return data.map(parseInvoice);
    },
  });
}

export type ProformaInput = Readonly<{
  oid: string; grossMinor: number; itemName: string; issueDate: string; paymentDays: number;
  buyer: Readonly<{ name: string; nip: string; street: string; postCode: string; city: string; email: string }>;
}>;

export function formatMinor(minor: number): string {
  return `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}
/** Strict "369.00" / "369,00" / "369" → 36900. Anything else → null. */
export function parseMinor(value: string): number | null {
  const m = /^(\d{1,9})(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
}
export type FakturowniaClient = ReturnType<typeof createFakturowniaClient>;

export type FakturowniaHealth =
  | Readonly<{ ok: true; account: string; departments: readonly FakturowniaDepartment[]; proformasThisMonth: number }>
  | Readonly<{ ok: false; code: FakturowniaErrorCode; httpStatus: number | null }>;

/** Owner diagnostics. Read-only; never issues, sends or changes any document. */
export async function checkFakturowniaConnection(env: Record<string, string | undefined>, fetchImpl: FakturowniaFetch): Promise<FakturowniaHealth> {
  try {
    const config = readFakturowniaConfig(env);
    const client = createFakturowniaClient(config, fetchImpl);
    const departments = await client.departments();
    const proformasThisMonth = await client.proformasThisMonth();
    return Object.freeze({ ok: true, account: config.account, departments: Object.freeze(departments), proformasThisMonth });
  } catch (error) {
    if (error instanceof FakturowniaError) return Object.freeze({ ok: false, code: error.code, httpStatus: error.httpStatus });
    return Object.freeze({ ok: false, code: 'FAKTUROWNIA_RESPONSE_INVALID', httpStatus: null });
  }
}

export const fakturowniaMessages: Record<FakturowniaErrorCode, string> = {
  FAKTUROWNIA_NOT_CONFIGURED: 'Brak zmiennych FAKTUROWNIA_ACCOUNT i FAKTUROWNIA_API_TOKEN w tym środowisku.',
  FAKTUROWNIA_CONFIG_INVALID: 'Zmienne są ustawione, ale mają nieprawidłowy format (nazwa konta albo token).',
  FAKTUROWNIA_UNAUTHORIZED: 'Fakturownia odrzuciła token API. Wygeneruj go ponownie i zaktualizuj zmienną.',
  FAKTUROWNIA_ACCOUNT_NOT_FOUND: 'Nie znaleziono konta. Sprawdź nazwę konta (część adresu przed .fakturownia.pl).',
  FAKTUROWNIA_RATE_LIMITED: 'Fakturownia chwilowo ogranicza liczbę zapytań. Spróbuj za kilka minut.',
  FAKTUROWNIA_UNAVAILABLE: 'Fakturownia nie odpowiada poprawnie. Spróbuj ponownie później.',
  FAKTUROWNIA_TIMEOUT: 'Przekroczono czas oczekiwania na Fakturownię.',
  FAKTUROWNIA_RESPONSE_INVALID: 'Fakturownia zwróciła nieoczekiwaną odpowiedź.',
  FAKTUROWNIA_REQUEST_REJECTED: 'Fakturownia odrzuciła zapytanie.',
};
