/**
 * SC-020-B — domeny klienta: czyste reguły (bez sieci i bazy), wspólne dla
 * proxy, akcji serwera, weryfikatora i testów.
 *
 * Reguły nazwy hosta są TE SAME co tenant_domains.valid_hostname /
 * reserved_hostname / reserved_label w migracji 20261109200000.
 *
 * Granica zaufania: nagłówki TENANT_COMPANY_HEADER / TENANT_HOST_HEADER
 * ustawia wyłącznie proxy.ts po rozpoznaniu hosta w bazie i po usunięciu
 * wartości przysłanych przez klienta. Czytać je wolno tylko w trasach objętych
 * `config.matcher` w proxy.ts (patrz TENANT_TRUSTED_PATH_PREFIXES i test).
 */

import { whiteLabelEnabled, type WhiteLabelEnvironment } from './white-label-flag.ts';

export const TENANT_COMPANY_HEADER = 'x-skillcheck-tenant-company';
export const TENANT_HOST_HEADER = 'x-skillcheck-tenant-host';
/** Trasy, na których proxy zawsze działa, więc nagłówki firmy są wiarygodne. */
export const TENANT_TRUSTED_PATH_PREFIXES = Object.freeze([
  '/login', '/register', '/forgot-password', '/reset-password', '/onboarding', '/dashboard', '/operator', '/kup', '/auth',
]);

export const VERIFICATION_RECORD_PREFIX = '_skillcheck-challenge';
export const VERIFICATION_VALUE_PREFIX = 'skillcheck-domain-verification=';

const HOSTNAME = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
const TOKEN = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const RESERVED_SUFFIXES = Object.freeze([
  'skillcheck.pl', 'skillcheck.invalid', 'vercel.app', 'vercel.com', 'vercel.dev', 'now.sh',
  'supabase.co', 'supabase.com', 'supabase.in', 'supabase.net',
  'localhost', 'local', 'internal', 'localdomain', 'home.arpa', 'arpa', 'test', 'invalid', 'example',
  'example.com', 'example.net', 'example.org', 'onion',
]);
const RESERVED_LABELS = new Set([
  'www', 'app', 'api', 'admin', 'auth', 'login', 'operator', 'dashboard', 'panel', 'mail', 'smtp',
  'imap', 'pop', 'ftp', 'ns', 'ns1', 'ns2', 'dns', 'status', 'static', 'cdn', 'assets', 'media',
  'preview', 'staging', 'dev', 'test', 'support', 'help', 'docs', 'blog', 'billing', 'pay',
  'skillcheck', 'security', 'abuse', 'postmaster', 'webmaster', 'root', 'autodiscover', 'autoconfig',
]);

export function isValidHostname(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 4 && value.length <= 253 && HOSTNAME.test(value);
}

export function isReservedHostname(host: string): boolean {
  return RESERVED_SUFFIXES.some(suffix => host === suffix || host.endsWith('.' + suffix));
}

export function isReservedLabel(label: string): boolean {
  return RESERVED_LABELS.has(label) || label.startsWith('xn--') || label.includes('--');
}

/**
 * Wejście z formularza -> kanoniczna nazwa hosta albo null. Przyjmuje wielkie
 * litery, kropkę na końcu i nazwy IDN (zamieniane na punycode); odrzuca
 * schemat, ścieżkę, port, dane logowania i adresy IP.
 */
export function normalizeHostnameInput(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let host = value.trim();
  if (!host || host.length > 300 || /[\s/\\:@?#[\]%]/.test(host)) return null;
  host = host.replace(/\.$/, '').toLowerCase();
  if (/[^\x00-\x7f]/.test(host)) {
    try {
      host = new URL('https://' + host).hostname;
    } catch {
      return null;
    }
  }
  return isValidHostname(host) ? host : null;
}

export type ClaimCheck =
  | { ok: true; hostname: string }
  | { ok: false; reason: 'invalid' | 'reserved' | 'subdomains_disabled' };

/** Ta sama decyzja co public.tenant_domain_claim, przed wywołaniem bazy. */
export function checkClaim(input: unknown, kind: 'custom' | 'subdomain', subdomainBase: string | null): ClaimCheck {
  if (kind === 'subdomain') {
    if (!subdomainBase) return { ok: false, reason: 'subdomains_disabled' };
    const label = typeof input === 'string' ? input.trim().toLowerCase() : '';
    if (!/^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])$/.test(label)) return { ok: false, reason: 'invalid' };
    if (isReservedLabel(label)) return { ok: false, reason: 'reserved' };
    const hostname = `${label}.${subdomainBase}`;
    return isValidHostname(hostname) ? { ok: true, hostname } : { ok: false, reason: 'invalid' };
  }
  const hostname = normalizeHostnameInput(input);
  if (!hostname) return { ok: false, reason: 'invalid' };
  if (isReservedHostname(hostname)) return { ok: false, reason: 'reserved' };
  if (subdomainBase && (hostname === subdomainBase || hostname.endsWith('.' + subdomainBase))) return { ok: false, reason: 'reserved' };
  return { ok: true, hostname };
}

/** Rekord TXT, który klient dodaje u swojego dostawcy DNS. */
export function verificationRecord(hostname: string, token: string) {
  if (!isValidHostname(hostname) || !TOKEN.test(token)) throw new Error('Nieprawidłowa domena lub token.');
  return { name: `${VERIFICATION_RECORD_PREFIX}.${hostname}`, value: VERIFICATION_VALUE_PREFIX + token };
}

/** Interfejs zapytań DNS (prawdziwy: node:dns/promises; w testach: atrapa). */
export interface DnsTxtResolver {
  resolveTxt(name: string): Promise<string[][]>;
}
/** Interfejs sprawdzenia gotowości TLS (prawdziwy: lib/tenant-domain-network.ts). */
export interface TlsReadinessChecker {
  isReady(hostname: string): Promise<boolean>;
}

export type DnsCheckResult = 'ok' | 'missing' | 'unavailable';
const NO_RECORD = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENONAME']);

/**
 * Sprawdza rekord TXT. 'missing' — rekordu nie ma (wynik wiarygodny);
 * 'unavailable' — błąd sieci/limit czasu (nic nie zapisujemy, żeby awaria
 * resolvera nie wyłączała domen klientów).
 */
export async function checkDnsOwnership(resolver: DnsTxtResolver, hostname: string, token: string, timeoutMs = 5000): Promise<DnsCheckResult> {
  const record = verificationRecord(hostname, token);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answers = await Promise.race([
      resolver.resolveTxt(record.name),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), timeoutMs); }),
    ]);
    if (!Array.isArray(answers)) return 'unavailable';
    return answers.some(chunks => Array.isArray(chunks) && chunks.join('') === record.value) ? 'ok' : 'missing';
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return typeof code === 'string' && NO_RECORD.has(code) ? 'missing' : 'unavailable';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type ParsedHost = { ok: true; hostname: string; authority: string } | { ok: false };

/**
 * Nagłówek Host (i X-Forwarded-Host, jeśli jest) -> nazwa hosta. Odrzuca
 * wszystko, co nie jest pojedynczą, kanoniczną nazwą z opcjonalnym portem,
 * oraz X-Forwarded-Host różny od Host (podszywanie się pod inny host).
 */
export function parseRequestHost(host: string | null, forwardedHost: string | null): ParsedHost {
  if (typeof host !== 'string' || !host) return { ok: false };
  const authority = host.toLowerCase();
  const match = /^([a-z0-9.-]{1,253})(?::(\d{1,5}))?$/.exec(authority);
  if (!match) return { ok: false };
  const hostname = match[1];
  if (match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > 65535)) return { ok: false };
  const local = hostname === 'localhost' || /^127\.0\.0\.1$/.test(hostname);
  if (!local && !isValidHostname(hostname)) return { ok: false };
  if (forwardedHost !== null && forwardedHost.toLowerCase() !== authority) return { ok: false };
  return { ok: true, hostname, authority };
}

type HostEnvironment = {
  NEXT_PUBLIC_SITE_URL?: string; VERCEL_ENV?: string; NODE_ENV?: string;
  VERCEL_BRANCH_URL?: string; VERCEL_URL?: string; VERCEL_PROJECT_PRODUCTION_URL?: string;
};

/** Hosty samej platformy (z konfiguracji, nigdy z żądania). Na nich nie szukamy firmy. */
export function platformHostnames(env: HostEnvironment): Set<string> {
  const hosts = new Set<string>();
  const add = (value: string | undefined, bare: boolean) => {
    if (!value) return;
    try {
      hosts.add(new URL(bare ? 'https://' + value : value).hostname.toLowerCase());
    } catch { /* błędną konfigurację pomijamy: host nieznany = brak firmy */ }
  };
  add(env.NEXT_PUBLIC_SITE_URL, false);
  add(env.VERCEL_URL, true);
  add(env.VERCEL_BRANCH_URL, true);
  add(env.VERCEL_PROJECT_PRODUCTION_URL, true);
  if (!env.VERCEL_ENV) { hosts.add('localhost'); hosts.add('127.0.0.1'); }
  return hosts;
}

/** Ta sama flaga co SC-020-A (SC-020-D: jedna funkcja, lib/white-label-flag.ts). */
export function tenantDomainsEnabled(env: WhiteLabelEnvironment): boolean {
  return whiteLabelEnabled(env);
}

export type TenantRoute = { kind: 'continue' } | { kind: 'not_found' } | { kind: 'redirect'; location: string };

/**
 * Na domenie firmy X dostępny jest tylko panel firmy X (i lista firm z samą
 * firmą X oraz wylogowaniem). Panel operatora, zakładanie nowej firmy i panel
 * innej firmy — nie. To druga warstwa obok
 * ciasteczek przypisanych do hosta i RLS.
 */
export function tenantRoute(pathname: string, tenantCompanyId: string): TenantRoute {
  if (!UUID.test(tenantCompanyId)) return { kind: 'not_found' };
  const home = `/dashboard/${tenantCompanyId}`;
  const path = pathname.toLowerCase();
  if (path === '/operator' || path.startsWith('/operator/')) return { kind: 'not_found' };
  if (path === '/onboarding' || path.startsWith('/onboarding/')) return { kind: 'redirect', location: home };
  // '/dashboard' stays reachable (it lists only this company and holds the logout button).
  if (path.startsWith('/dashboard/')) {
    const segment = path.slice('/dashboard/'.length).split('/')[0];
    if (segment !== tenantCompanyId.toLowerCase()) return { kind: 'not_found' };
  }
  return { kind: 'continue' };
}

/** Ciasteczka sesji zawsze tylko dla bieżącego hosta (bez atrybutu Domain). */
export function hostOnlyCookieOptions<T extends { domain?: string } | undefined>(options: T): T {
  if (!options || options.domain === undefined) return options;
  const copy = { ...options };
  delete copy.domain;
  return copy;
}

/** Zaufany origin domeny firmy dla adresów zwrotnych logowania (tylko z nagłówka proxy). */
export function tenantOriginFromHeader(value: string | null): string | null {
  return value && isValidHostname(value) ? `https://${value}` : null;
}

export type TenantDecision =
  | { kind: 'disabled' }
  | { kind: 'bad_host' }
  | { kind: 'platform' }
  | { kind: 'unavailable' }
  | { kind: 'tenant'; companyId: string; hostname: string; route: TenantRoute };

/**
 * Cała decyzja proxy dla jednego żądania. `resolve` pyta bazę
 * (public.tenant_domain_resolve); brak wyniku = host bez firmy (zachowanie
 * platformy), nigdy zgadywanie firmy.
 *
 * SC-020-D: BŁĄD zapytania (baza niedostępna, zła odpowiedź) na hoście spoza
 * platformy kończy się 'unavailable' (proxy: 503), a nie zachowaniem
 * platformy. Inaczej chwilowa awaria zdejmowałaby z domeny firmy ograniczenie
 * tras (np. panel operatora na domenie klienta).
 */
export async function decideTenant(input: {
  host: string | null; forwardedHost: string | null; pathname: string;
  env: HostEnvironment & { readonly [key: string]: string | undefined };
  resolve: (hostname: string) => Promise<string | null>;
}): Promise<TenantDecision> {
  if (!tenantDomainsEnabled(input.env)) return { kind: 'disabled' };
  const parsed = parseRequestHost(input.host, input.forwardedHost);
  if (!parsed.ok) return { kind: 'bad_host' };
  // No shortcut for reserved suffixes: platform subdomains (<label>.<subdomain_base>, e.g. under skillcheck.pl)
  // are real tenants. Every platform alias must therefore be listed in platformHostnames (NEXT_PUBLIC_SITE_URL /
  // VERCEL_*) before white-label is switched on, or a failed lookup answers it with 503.
  if (platformHostnames(input.env).has(parsed.hostname) || !isValidHostname(parsed.hostname)) return { kind: 'platform' };
  let value: unknown;
  try {
    value = await input.resolve(parsed.hostname);
  } catch {
    return { kind: 'unavailable' };
  }
  if (value === null || value === undefined) return { kind: 'platform' };
  if (typeof value !== 'string' || !UUID.test(value)) return { kind: 'unavailable' };
  const companyId = value;
  return { kind: 'tenant', companyId, hostname: parsed.hostname, route: tenantRoute(input.pathname, companyId) };
}
