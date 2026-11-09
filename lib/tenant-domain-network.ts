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
import type { DnsTxtResolver, TlsReadinessChecker } from './tenant-domains.ts';
import type { VerifierStore } from './tenant-domain-verifier.ts';

export const systemDnsResolver: DnsTxtResolver = { resolveTxt: name => dns.resolveTxt(name) };

/** Adresy, z którymi serwer nigdy się nie łączy (sieci prywatne, pętla zwrotna, link-local, CGNAT, metadane). */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224);
  }
  if (version === 6) {
    const v = address.toLowerCase();
    if (v === '::' || v === '::1' || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')
      || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('ff')) return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    return mapped ? isPublicAddress(mapped[1]) : true;
  }
  return false;
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

/**
 * Magazyn przez osobne połączenie z rolą tenant_domain_verifier.
 * TENANT_DOMAIN_VERIFIER_DATABASE_URL nieustawione -> null (weryfikacja
 * niedostępna; nic nie omija tej roli). Login dla roli tworzy operator.
 */
export function verifierStoreFromEnv(env: { readonly [key: string]: string | undefined } = process.env): VerifierStore | null {
  const raw = env['TENANT_DOMAIN_VERIFIER_DATABASE_URL'];
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) return null;
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  const run = async <T>(sql: string, params: unknown[]): Promise<T> => {
    const pool = new Pool({
      connectionString: raw,
      // Loopback (tests, local dev) has no TLS; every remote database requires a verified certificate.
      ssl: (loopback ? false : { rejectUnauthorized: true }) as { rejectUnauthorized: boolean },
      max: 1, maxUses: 1, connectionTimeoutMillis: 5000, query_timeout: 10000, idleTimeoutMillis: 1000,
      allowExitOnIdle: true, options: '-c statement_timeout=10000',
    });
    pool.on('error', () => {});
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role tenant_domain_verifier');
      const result = await client.query(sql, params);
      await client.query('commit');
      return result.rows as T;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release(true);
      await pool.end().catch(() => {});
    }
  };
  return {
    async target(companyId, domainId) {
      const rows = await run<{ hostname: string; kind: string; status: string; verification_token: string }[]>(
        'select * from tenant_domains.verifier_target($1::uuid,$2::uuid)', [companyId, domainId]);
      return rows[0] ?? null;
    },
    async recordDns(companyId, domainId, token, ok) {
      return (await run<{ r: string }[]>('select tenant_domains.record_dns_check($1::uuid,$2::uuid,$3,$4) r', [companyId, domainId, token, ok]))[0].r;
    },
    async recordTls(companyId, domainId, token, ok) {
      return (await run<{ r: string }[]>('select tenant_domains.record_tls_check($1::uuid,$2::uuid,$3,$4) r', [companyId, domainId, token, ok]))[0].r;
    },
  };
}
