/**
 * SC-014-B3 deployment adapter. Importing this module creates no pool.
 * Production requires explicit enablement and all trust dependencies.
 */
import { createCompetencyBroker, competencyBrokerMethodDenied, type GatewayLease } from './competency-attempt-broker.ts';
import { createRedisRestLimiter, type SharedRateLimiter } from './competency-broker-limiter.ts';
import { verifyCompetencyGateway } from './competency-broker-role.ts';
import { createPostgresSharedLimiter } from './competency-postgres-limiter.ts';
import { competencyGatewayTls } from './competency-broker-tls.ts';
import { competencyDiagnosticDetail, logCompetencyBrokerUnavailable, tagCompetencyDiagnostic,
  type CompetencyBrokerUnavailableReason } from './competency-broker-diagnostics.ts';

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
const GATEWAY_ROLE = /^competency_gateway_[a-z0-9_]{1,40}$/;
const SUPABASE_DIRECT_HOST = /^db\.([a-z0-9]{20})\.supabase\.co$/;
/** Supavisor shared pooler hosts only (IPv4-reachable). Kept identical to the TLS pin scope. */
export const SUPABASE_POOLER_HOST = /^aws-[0-9]+-[a-z]{2}-[a-z]+-[0-9]+\.pooler\.supabase\.com$/;

export interface CompetencyGatewayConnection {
  /** DSN handed to pg; for the pooler the username is `<role>.<project ref>`. */
  connectionString: string;
  /** Bare LOGIN role; PostgreSQL reports it as session_user in both modes. */
  expectedUser: string;
}
/**
 * Validates the dedicated gateway DSN and, when a pooler host is configured,
 * routes it through the Supavisor SESSION pooler (port 5432, never the 6543
 * transaction pooler: the broker relies on session settings and SET LOCAL ROLE
 * inside explicit transactions). The pooler host is a non-secret value, so it
 * can only pick one of Supabase's own pooler hostnames; credentials, role and
 * database still come only from the owner-entered secret. Errors carry no value.
 */
export function competencyGatewayConnection(raw: string | undefined, poolerHost?: string): CompetencyGatewayConnection {
  if (!raw) throw new Error('No dedicated gateway login');
  const parsed = new URL(raw);
  if (!['postgres:','postgresql:'].includes(parsed.protocol) ||
      !parsed.hostname || !GATEWAY_ROLE.test(parsed.username) ||
      !parsed.password || parsed.search || parsed.hash ||
      ['localhost','127.0.0.1','::1'].includes(parsed.hostname))
    throw new Error('Unsafe gateway DSN');
  const expectedUser = parsed.username;
  if (poolerHost === undefined || poolerHost === '') return { connectionString: parsed.toString(), expectedUser };
  const ref = SUPABASE_DIRECT_HOST.exec(parsed.hostname)?.[1];
  if (!ref || !SUPABASE_POOLER_HOST.test(poolerHost) || !['', '5432'].includes(parsed.port))
    throw new Error('Unsafe gateway pooler route');
  parsed.hostname = poolerHost;
  parsed.port = '5432';
  parsed.username = `${expectedUser}.${ref}`;
  return { connectionString: parsed.toString(), expectedUser };
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
  postgresLimiter?:boolean;
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
    onUnavailable: logCompetencyBrokerUnavailable,
    acquire: async (): Promise<GatewayLease> => {
      if (options.pool.waitingCount >= 4)
        throw tagCompetencyDiagnostic(new Error('Gateway pool backpressure'), 'pool_backpressure');
      let client: CompetencyGatewayPoolClient;
      try { client = await options.pool.connect(); }
      catch { throw tagCompetencyDiagnostic(new Error('Gateway connection failed'), 'connect'); }
      try {
        // Audit both the real LOGIN and the gateway permissions it will acquire
        // on this exact connection before any capability-bearing B2 query.
        await verifyCompetencyGateway(client, options.expectedUser,{postgresLimiter:options.postgresLimiter});
        options.onConnection?.();
        return {
          query: (sql, args) => client.query(sql, args),
          release: destroy => client.release(!!destroy)
        };
      } catch (error) {
        client.release(true);
        throw tagCompetencyDiagnostic(new Error('Gateway verification failed'),
          competencyDiagnosticDetail(error) ?? 'verify_query');
      }
    }
  });
}

type BrokerHandler = (request: Request) => Promise<Response>;
let ready: Promise<BrokerHandler> | undefined;
let disabledLogged = false;

/** Carries only a fixed diagnostic code; the original error text is dropped. */
class BrokerConfigError extends Error {
  readonly reason: CompetencyBrokerUnavailableReason;
  constructor(reason: CompetencyBrokerUnavailableReason) { super('Broker configuration unavailable'); this.reason = reason; }
}
function configStep<T>(reason: CompetencyBrokerUnavailableReason, step: () => T): T {
  try { return step(); } catch { throw new BrokerConfigError(reason); }
}

async function construct(): Promise<BrokerHandler> {
  const origin = process.env.COMPETENCY_BROKER_ORIGIN || '';
  configStep('config_origin', () => {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
      throw new Error('Origin not pinned');
    }
  });
  const csrfKey = configStep('config_keys', () => key('COMPETENCY_BROKER_CSRF_KEY'));
  const sourceKey = configStep('config_keys', () => key('COMPETENCY_BROKER_SOURCE_HMAC_KEY'));
  const redisUrl = process.env.COMPETENCY_BROKER_LIMITER_REST_URL || '';
  const redisToken = process.env.COMPETENCY_BROKER_LIMITER_REST_TOKEN || '';
  const gateway = configStep('config_dsn', () => competencyGatewayConnection(
    process.env.COMPETENCY_BROKER_GATEWAY_DATABASE_URL, process.env.COMPETENCY_BROKER_GATEWAY_POOLER_HOST));
  const dsn = gateway.connectionString;
  const limiterKind=process.env.COMPETENCY_BROKER_LIMITER;
  if(limiterKind!=='postgres'&&limiterKind!=='redis')throw new BrokerConfigError('config_limiter');
  // No pool exists on default-disabled integration/preview/production builds.
  const pg = await import('pg');
  const pool = new pg.Pool({
    connectionString: dsn,
    ssl: competencyGatewayTls(dsn),
    max: 4,
    maxUses: 100,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 5000,
    query_timeout: 7000, // client-side bound also covers unreachable COMMIT
    allowExitOnIdle: true,
    options: '-c statement_timeout=5000 -c lock_timeout=1500 -c idle_in_transaction_session_timeout=8000'
  });
  const limiter = configStep('config_limiter', () => limiterKind==='postgres'
    ?createPostgresSharedLimiter(pool,gateway.expectedUser):createRedisRestLimiter(redisUrl,redisToken));
  return createCompetencyGatewayRuntime({
    expectedOrigin: origin,
    expectedUser: gateway.expectedUser,
    csrfKey,
    sourceKey,
    limiter,
    pool,
    postgresLimiter:limiterKind==='postgres',
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
  if (process.env.COMPETENCY_BROKER_ENABLED !== 'true') {
    // Intentionally off in production: log once per instance, not per request.
    if (!disabledLogged) { disabledLogged = true; logCompetencyBrokerUnavailable('disabled'); }
    return disabled();
  }
  let constructing = true;
  try {
    if (!ready) ready = construct();
    const handler = await ready;
    constructing = false;
    return await handler(request);
  } catch (error) {
    // Never forward/print a DSN, SQL provider error, or sensitive parameter:
    // only a fixed code reaches the log, the response stays generic.
    ready = undefined;
    logCompetencyBrokerUnavailable(!constructing ? 'internal'
      : error instanceof BrokerConfigError ? error.reason : 'config_runtime');
    return disabled();
  }
}
export function competencyBrokerOtherMethod(): Response {
  return competencyBrokerMethodDenied();
}
