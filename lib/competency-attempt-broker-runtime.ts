/**
 * SC-014-B3 deployment adapter. Importing this module creates no pool.
 * Production requires explicit enablement and all trust dependencies.
 */
import { createCompetencyBroker, competencyBrokerMethodDenied, type GatewayLease } from './competency-attempt-broker.ts';
import { createRedisRestLimiter, type SharedRateLimiter } from './competency-broker-limiter.ts';
import { verifyCompetencyGateway } from './competency-broker-role.ts';

const HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin'
};
const disabled = (): Response => Response.json({ error: 'unavailable' }, { status: 503, headers: HEADERS });
function key(name: string): Buffer {
  const value = process.env[name] || '';
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error('Missing broker key');
  return Buffer.from(value, 'hex');
}
function databaseUrl(): string {
  const raw = process.env.COMPETENCY_BROKER_GATEWAY_DATABASE_URL;
  if (!raw) throw new Error('No dedicated gateway login');
  const parsed = new URL(raw);
  if (!['postgres:','postgresql:'].includes(parsed.protocol) ||
      !parsed.hostname || !/^competency_gateway_[a-z0-9_]{1,40}$/.test(parsed.username) ||
      !parsed.password || parsed.search || parsed.hash ||
      ['localhost','127.0.0.1','::1'].includes(parsed.hostname))
    throw new Error('Unsafe gateway DSN');
  return parsed.toString();
}

export interface CompetencyGatewayPoolClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(destroy?: boolean): void;
}
export interface CompetencyGatewayPool {
  waitingCount: number;
  connect(): Promise<CompetencyGatewayPoolClient>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}
export interface CompetencyGatewayRuntime {
  expectedOrigin: string;
  expectedUser: string;
  csrfKey: Buffer;
  sourceKey: Buffer;
  limiter: SharedRateLimiter;
  pool: CompetencyGatewayPool;
  trustedSource(request: Request): string | null;
  onConnection?(): void; // test-only observation hook; no PII
}

const registered = new WeakSet<CompetencyGatewayPool>();
/**
 * The SAME enabled adapter is used by production and disposable PG16/HTTPS
 * integration tests. Only the pool and trusted ingress are injected for
 * isolated tests; role/logging checks, query transport and HTTP remain real.
 */
export function createCompetencyGatewayRuntime(options: CompetencyGatewayRuntime):
  (request: Request) => Promise<Response> {
  if (!registered.has(options.pool)) {
    // pg emits this for idle broken clients. Never allow an unhandled event to
    // crash the process or log connection error details/credentials.
    options.pool.on('error', () => { /* fail closed; pg discards idle client */ });
    registered.add(options.pool);
  }
  return createCompetencyBroker({
    enabled: true,
    expectedOrigin: options.expectedOrigin,
    csrfKey: options.csrfKey,
    sourceKey: options.sourceKey,
    limiter: options.limiter,
    trustedSource: options.trustedSource,
    acquire: async (): Promise<GatewayLease> => {
      if (options.pool.waitingCount >= 4) throw new Error('Gateway pool backpressure');
      const client = await options.pool.connect();
      try {
        // Always audit the real LOGIN on the exact pooled connection BEFORE
        // switching to competency_test_gateway inside a B2 transaction.
        await verifyCompetencyGateway(client, options.expectedUser);
        options.onConnection?.();
        return {
          query: (sql, args) => client.query(sql, args),
          release: destroy => client.release(!!destroy)
        };
      } catch {
        client.release(true);
        throw new Error('Gateway verification failed');
      }
    }
  });
}

type BrokerHandler = (request: Request) => Promise<Response>;
let ready: Promise<BrokerHandler> | undefined;

async function construct(): Promise<BrokerHandler> {
  const origin = process.env.COMPETENCY_BROKER_ORIGIN || '';
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('Origin not pinned');
  }
  const csrfKey = key('COMPETENCY_BROKER_CSRF_KEY');
  const sourceKey = key('COMPETENCY_BROKER_SOURCE_HMAC_KEY');
  const redisUrl = process.env.COMPETENCY_BROKER_LIMITER_REST_URL || '';
  const redisToken = process.env.COMPETENCY_BROKER_LIMITER_REST_TOKEN || '';
  const dsn = databaseUrl();
  const limiter = createRedisRestLimiter(redisUrl, redisToken);
  // No pool exists on default-disabled integration/preview/production builds.
  const pg = await import('pg');
  const pool = new pg.Pool({
    connectionString: dsn,
    ssl: { rejectUnauthorized: true },
    max: 4,
    maxUses: 100,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 5000,
    query_timeout: 7000, // client-side bound also covers unreachable COMMIT
    allowExitOnIdle: true,
    options: '-c statement_timeout=5000 -c lock_timeout=1500 -c idle_in_transaction_session_timeout=8000'
  });
  return createCompetencyGatewayRuntime({
    expectedOrigin: origin,
    expectedUser: new URL(dsn).username,
    csrfKey,
    sourceKey,
    limiter,
    pool,
    // Only Vercel ingress rewrites X-Forwarded-For. Reject untrusted local
    // headers and forwarding chains; never accept caller X-Real-IP.
    trustedSource(request) {
      if (process.env.VERCEL !== '1') return null;
      const source = request.headers.get('x-forwarded-for');
      return source && !source.includes(',') ? source : null;
    }
  });
}
export async function competencyBrokerPost(request: Request): Promise<Response> {
  if (process.env.COMPETENCY_BROKER_ENABLED !== 'true') return disabled();
  try {
    if (!ready) ready = construct();
    return await (await ready)(request);
  } catch {
    // Never forward/print a DSN, SQL provider error, or sensitive parameter.
    ready = undefined;
    return disabled();
  }
}
export function competencyBrokerOtherMethod(): Response {
  return competencyBrokerMethodDenied();
}
