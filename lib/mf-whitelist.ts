/** SC-BILLING-INVOICE-001 (#165): company lookup in the Ministry of Finance
 * "Wykaz podatników VAT" (biała lista), https://wl-api.mf.gov.pl/api.
 * Public, keyless API with a low daily quota: call only on explicit user actions
 * (company verification, issuing a document), never in loops or on page views.
 * Returns only what an invoice needs; representatives, PESEL and bank accounts
 * are deliberately discarded.
 */
export type WhitelistFetch = (url: string, init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal }) =>
  Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;

export type WhitelistErrorCode =
  | 'NIP_INVALID' | 'NIP_NOT_FOUND' | 'NIP_NOT_ACTIVE' | 'WHITELIST_ADDRESS_UNPARSEABLE'
  | 'WHITELIST_UNAVAILABLE' | 'WHITELIST_RATE_LIMITED' | 'WHITELIST_TIMEOUT' | 'WHITELIST_RESPONSE_INVALID';

export class WhitelistError extends Error {
  readonly code: WhitelistErrorCode;
  constructor(code: WhitelistErrorCode) { super(code); this.name = 'WhitelistError'; this.code = code; }
}

export type CompanyRecord = Readonly<{
  nip: string; name: string; statusVat: 'Czynny' | 'Zwolniony';
  street: string; postCode: string; city: string; requestId: string;
}>;

const WEIGHTS = [6, 5, 7, 2, 3, 4, 5, 6, 7];
/** Accepts "526-025-02-74", "PL5260250274" etc.; returns 10 digits or null. */
export function normalizeNip(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 32) return null;
  const digits = input.trim().replace(/^PL/i, '').replace(/[\s-]/g, '');
  if (!/^\d{10}$/.test(digits) || /^0{10}$/.test(digits)) return null;
  const sum = WEIGHTS.reduce((acc, w, i) => acc + w * Number(digits[i]), 0);
  const check = sum % 11;
  return check !== 10 && check === Number(digits[9]) ? digits : null;
}

/** "UL. MICHAŁA KAJKI 10-12, 10-547 OLSZTYN" → street / post code / city. */
export function parsePolishAddress(raw: unknown): { street: string; postCode: string; city: string } | null {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  const match = /^(.+),\s*(\d{2}-\d{3})\s+(.+)$/.exec(raw.trim().replace(/\s+/g, ' '));
  if (!match) return null;
  const [, street, postCode, city] = match;
  return street && city ? { street: street.trim(), postCode, city: city.trim() } : null;
}

const warsawDate = (now: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(now);

export async function lookupCompanyByNip(nipInput: string, fetchImpl: WhitelistFetch,
  opts: { now?: Date; timeoutMs?: number; baseUrl?: string } = {}): Promise<CompanyRecord> {
  const nip = normalizeNip(nipInput);
  if (!nip) throw new WhitelistError('NIP_INVALID');
  const base = opts.baseUrl ?? 'https://wl-api.mf.gov.pl/api';
  const url = `${base}/search/nip/${nip}?date=${warsawDate(opts.now ?? new Date())}`;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new WhitelistError('WHITELIST_TIMEOUT')); }, opts.timeoutMs ?? 8000);
  });
  deadline.catch(() => undefined);
  try {
    let response;
    try {
      response = await Promise.race([fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal }), deadline]);
    } catch (e) {
      throw e instanceof WhitelistError ? e : new WhitelistError(controller.signal.aborted ? 'WHITELIST_TIMEOUT' : 'WHITELIST_UNAVAILABLE');
    }
    if (response.status === 429) throw new WhitelistError('WHITELIST_RATE_LIMITED');
    if (response.status === 400) throw new WhitelistError('NIP_INVALID');
    if (!response.ok) throw new WhitelistError('WHITELIST_UNAVAILABLE');
    let body: unknown;
    try { body = await Promise.race([response.json(), deadline]); }
    catch (e) { throw e instanceof WhitelistError ? e : new WhitelistError('WHITELIST_RESPONSE_INVALID'); }
    const result = (body as { result?: { subject?: unknown; requestId?: unknown } } | null)?.result;
    if (!result || typeof result !== 'object') throw new WhitelistError('WHITELIST_RESPONSE_INVALID');
    const subject = result.subject as Record<string, unknown> | null | undefined;
    if (subject === null || subject === undefined) throw new WhitelistError('NIP_NOT_FOUND');
    if (typeof subject !== 'object' || subject.nip !== nip || typeof subject.name !== 'string' ||
        subject.name.trim().length === 0 || subject.name.length > 300 || typeof result.requestId !== 'string')
      throw new WhitelistError('WHITELIST_RESPONSE_INVALID');
    if (subject.statusVat !== 'Czynny' && subject.statusVat !== 'Zwolniony') throw new WhitelistError('NIP_NOT_ACTIVE');
    const address = parsePolishAddress(subject.workingAddress) ?? parsePolishAddress(subject.residenceAddress);
    if (!address) throw new WhitelistError('WHITELIST_ADDRESS_UNPARSEABLE');
    return Object.freeze({ nip, name: subject.name.trim(), statusVat: subject.statusVat, ...address,
      requestId: result.requestId.slice(0, 64) });
  } finally { clearTimeout(timer); }
}

export const whitelistMessages: Record<WhitelistErrorCode, string> = {
  NIP_INVALID: 'Nieprawidłowy NIP. Sprawdź cyfry.',
  NIP_NOT_FOUND: 'Nie znaleziono firmy o tym NIP w wykazie podatników VAT.',
  NIP_NOT_ACTIVE: 'Firma o tym NIP nie jest czynnym ani zwolnionym podatnikiem VAT.',
  WHITELIST_ADDRESS_UNPARSEABLE: 'Nie udało się odczytać adresu firmy z wykazu. Skontaktuj się z nami.',
  WHITELIST_UNAVAILABLE: 'Wykaz podatników VAT jest chwilowo niedostępny. Spróbuj ponownie.',
  WHITELIST_RATE_LIMITED: 'Wykaz podatników VAT chwilowo ogranicza zapytania. Spróbuj później.',
  WHITELIST_TIMEOUT: 'Wykaz podatników VAT nie odpowiedział na czas. Spróbuj ponownie.',
  WHITELIST_RESPONSE_INVALID: 'Wykaz podatników VAT zwrócił nieoczekiwaną odpowiedź.',
};
