/**
 * SC-020-B — prawdziwe implementacje interfejsów DNS/TLS i magazynu
 * weryfikatora. Wyłącznie serwer. Testy używają atrap (lib/tenant-domain-verifier.ts).
 *
 * Bez zmian DNS, bez zakupów domen i bez API Vercel: tylko odczyt rekordu TXT
 * i próba uzgodnienia TLS z publicznym adresem hosta.
 */
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import tls from 'node:tls';
import { Pool } from 'pg';
import { previewPoolTls } from './sc19-payment-preview-tls.ts';
import type { DnsTxtResolver, TlsReadinessChecker } from './tenant-domains.ts';
import type { VerifierStore } from './tenant-domain-verifier.ts';
import type { ReverifyStore, ReverifyTarget } from './tenant-domain-reverify.ts';

export const systemDnsResolver: DnsTxtResolver = { resolveTxt: name => dns.resolveTxt(name) };

/** Adresy, z którymi serwer nigdy się nie łączy (sieci prywatne, pętla zwrotna, link-local, CGNAT,
 * metadane, adresy specjalne IETF oraz IPv6 z osadzonym IPv4: NAT64, 6to4, IPv4-compatible/mapped). */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
      || a >= 224);
  }
  if (version === 6) {
    const groups = expandIpv6(address);
    if (!groups) return false;
    const [g0, g1] = groups;
    if (groups.slice(0, 6).every(g => g === 0)) return false; // ::, ::1, ::/96 (IPv4-compatible)
    if (groups.slice(0, 5).every(g => g === 0) && groups[5] === 0xffff) {
      return isPublicAddress(`${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`);
    }
    if (g0 === 0x64 && g1 === 0xff9b) return false; // NAT64 64:ff9b::/96 i 64:ff9b:1::/48
    if (g0 === 0x2002) return false; // 6to4
    if (g0 === 0x2001 && g1 === 0) return false; // Teredo 2001::/32
    if (groups.slice(0, 4).every(g => g === 0) && groups[4] === 0xffff && groups[5] === 0) return false; // ::ffff:0:0:0/96 (IPv4-translated)
    if (g0 === 0x2001 && g1 === 0x0db8) return false; // dokumentacja
    if ((g0 & 0xfe00) === 0xfc00) return false; // ULA fc00::/7
    if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return false; // link-local, site-local
    if ((g0 & 0xff00) === 0xff00) return false; // multicast
    return true;
  }
  return false;
}

function expandIpv6(address: string): number[] | null {
  let value = address.toLowerCase().split('%')[0];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (v4) {
    const parts = v4[1].split('.').map(Number);
    if (parts.some(p => p > 255)) return null;
    value = value.slice(0, -v4[1].length) + ((parts[0] << 8) | parts[1]).toString(16) + ':' + ((parts[2] << 8) | parts[3]).toString(16);
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map(g => parseInt(g, 16));
  return groups.length === 8 && groups.every(g => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** TLS do bazy: zaufane korzenie Supabase dla hostowanych baz (jak broker SC-014 i płatności Preview). */
export function verifierDatabaseTls(url: URL): { rejectUnauthorized: true; ca?: string } {
  return /^db\.[a-z0-9]{20}\.supabase\.co$/.test(url.hostname) || /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname)
    ? { rejectUnauthorized: true, ca: previewPoolTls.ca }
    : { rejectUnauthorized: true };
}

/** TLS gotowy = poprawny, zaufany certyfikat dla tej nazwy na porcie 443 publicznego adresu. */
export const systemTlsChecker: TlsReadinessChecker = {
  async isReady(hostname) {
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    const target = addresses.find(entry => isPublicAddress(entry.address));
    if (!target || addresses.some(entry => !isPublicAddress(entry.address))) return false;
    return new Promise<boolean>(resolve => {
      const socket = tls.connect({ host: target.address, port: 443, servername: hostname, rejectUnauthorized: true, timeout: 5000 });
      const done = (value: boolean) => { socket.destroy(); resolve(value); };
      socket.once('secureConnect', () => done(socket.authorized));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
  },
};

type VerifierRun = <T>(sql: string, params: unknown[]) => Promise<T>;
type Environment = { readonly [key: string]: string | undefined };

type DatabaseConfig = { raw: string; url: URL; loopback: boolean };

/** Adres bazy z `variable`; null, gdy nieustawiony lub błędny (fail closed). */
function databaseConfig(env: Environment, variable: string): DatabaseConfig | null {
  const raw = env[variable];
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  // Parametry w adresie (np. sslmode) nadpisałyby ustawienia TLS w pg — odrzucamy je.
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash || !url.hostname) return null;
  return { raw, url, loopback: ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) };
}

function databasePool(config: DatabaseConfig, singleUse: boolean) {
  const pool = new Pool({
    connectionString: config.raw,
    // Loopback (tests, local dev) has no TLS; every remote database requires a verified certificate.
    ssl: (config.loopback ? false : verifierDatabaseTls(config.url)) as { rejectUnauthorized: boolean },
    max: 1, maxUses: singleUse ? 1 : Infinity, connectionTimeoutMillis: 5000, query_timeout: 10000,
    // A run's pool stays open between DNS checks; a single-use pool closes at once.
    idleTimeoutMillis: singleUse ? 1000 : 30000,
    allowExitOnIdle: true, options: '-c statement_timeout=10000',
  });
  pool.on('error', () => {});
  return pool;
}

/** Jedno zapytanie w transakcji z przełączeniem na `role` (rola bez dostępu do tabel). */
function runAs(pool: Pool, role: 'tenant_domain_verifier' | 'tenant_domain_reverifier'): VerifierRun {
  return async <T>(sql: string, params: unknown[]): Promise<T> => {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query('begin');
      await client.query(`set local role ${role}`);
      const result = await client.query(sql, params);
      await client.query('commit');
      return result.rows as T;
    } catch (error) {
      broken = true;
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      // `set local role` ends with the transaction; a connection that failed is never reused.
      client.release(broken);
    }
  };
}

/**
 * Połączenie z rolą tenant_domain_verifier (osobne, krótkotrwałe: nowa pula na
 * każde zapytanie, zamykana od razu). TENANT_DOMAIN_VERIFIER_DATABASE_URL
 * nieustawione lub błędne -> null (weryfikacja niedostępna; nic nie omija tej
 * roli). Login dla roli tworzy operator.
 */
function verifierRunFromEnv(env: Environment): VerifierRun | null {
  const config = databaseConfig(env, 'TENANT_DOMAIN_VERIFIER_DATABASE_URL');
  if (!config) return null;
  return async <T>(sql: string, params: unknown[]): Promise<T> => {
    const pool = databasePool(config, true);
    try {
      return await runAs(pool, 'tenant_domain_verifier')<T>(sql, params);
    } finally {
      await pool.end().catch(() => {});
    }
  };
}

/** Magazyn weryfikacji zleconej przez właściciela (SC-020-B). */
export function verifierStoreFromEnv(env: Environment = process.env): VerifierStore | null {
  const run = verifierRunFromEnv(env);
  if (!run) return null;
  return {
    async target(companyId, domainId) {
      const rows = await run<{ hostname: string; kind: string; status: string; verification_token: string }[]>(
        'select * from tenant_domains.verifier_target($1::uuid,$2::uuid)', [companyId, domainId]);
      return rows[0] ?? null;
    },
    async recordDns(companyId, domainId, token, ok, actingOwner) {
      return (await run<{ r: string }[]>('select tenant_domains.record_dns_check($1::uuid,$2::uuid,$3,$4,$5::uuid) r', [companyId, domainId, token, ok, actingOwner]))[0].r;
    },
    async recordTls(companyId, domainId, token, ok, actingOwner) {
      return (await run<{ r: string }[]>('select tenant_domains.record_tls_check($1::uuid,$2::uuid,$3,$4,$5::uuid) r', [companyId, domainId, token, ok, actingOwner]))[0].r;
    },
  };
}

/**
 * SC-020-D: magazyn zadania cyklicznej weryfikacji. OSOBNA rola
 * `tenant_domain_reverifier` i OSOBNY adres TENANT_DOMAIN_REVERIFY_DATABASE_URL
 * (nie poświadczenie aplikacji webowej). Jedna pula na cały przebieg; zamyka ją
 * `close()` (wywołuje je reverifyDueDomains). Nieustawione -> null.
 */
export function reverifyStoreFromEnv(env: Environment = process.env): ReverifyStore | null {
  const config = databaseConfig(env, 'TENANT_DOMAIN_REVERIFY_DATABASE_URL');
  if (!config) return null;
  const pool = databasePool(config, false);
  const run = runAs(pool, 'tenant_domain_reverifier');
  return {
    async due(limit) {
      return run<ReverifyTarget[]>('select company_id::text, domain_id::text, hostname, verification_token from tenant_domains.reverify_due($1::integer)', [limit]);
    },
    async record(companyId, domainId, token, ok) {
      return (await run<{ r: string }[]>('select tenant_domains.record_scheduled_dns_check($1::uuid,$2::uuid,$3,$4) r', [companyId, domainId, token, ok]))[0].r;
    },
    async close() {
      await pool.end().catch(() => {});
    },
  };
}
