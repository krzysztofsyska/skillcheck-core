/**
 * SC-014-B3 deployment adapter. This is inert unless the explicit feature
 * switch AND all security dependencies exist. No remote DB action at import.
 */
import { createCompetencyBroker, competencyBrokerMethodDenied, type GatewayLease } from './competency-attempt-broker.ts';
import { createRedisRestLimiter } from './competency-broker-limiter.ts';

const headers = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin'
};
function disabled(): Response {
  return Response.json({ error: 'unavailable' }, { status: 503, headers });
}
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
      !parsed.hostname || !parsed.username.startsWith('competency_gateway_') ||
      !/^competency_gateway_[a-z0-9_]{1,40}$/.test(parsed.username) ||
      !parsed.password || parsed.search || parsed.hash ||
      ['localhost','127.0.0.1','::1'].includes(parsed.hostname))
    throw new Error('Unsafe gateway DSN');
  // Certificate verification is set explicitly on the pg Pool; never permit
  // sslmode=disable / no certificate checking from a connection string.
  return parsed.toString();
}
type BrokerHandler = (request: Request) => Promise<Response>;
let ready: Promise<BrokerHandler> | undefined;

async function construct(): Promise<BrokerHandler> {
  const origin = process.env.COMPETENCY_BROKER_ORIGIN || '';
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) throw new Error('Origin not pinned');
  const csrfKey = key('COMPETENCY_BROKER_CSRF_KEY');
  const sourceKey = key('COMPETENCY_BROKER_SOURCE_HMAC_KEY');
  const redisUrl = process.env.COMPETENCY_BROKER_LIMITER_REST_URL || '';
  const redisToken = process.env.COMPETENCY_BROKER_LIMITER_REST_TOKEN || '';
  const dsn = databaseUrl();
  const limiter = createRedisRestLimiter(redisUrl, redisToken);
  // Lazy import after all fail-closed checks. No Pool on disabled deployments.
  const pg = await import('pg');
  const pool = new pg.Pool({
    connectionString: dsn,
    ssl: { rejectUnauthorized: true },
    max: 4,
    maxUses: 100,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 5000,
    allowExitOnIdle: true,
    options: '-c statement_timeout=5000 -c lock_timeout=1500 -c idle_in_transaction_session_timeout=8000'
  });
  return createCompetencyBroker({
    enabled: true,
    expectedOrigin: origin,
    csrfKey,
    sourceKey,
    limiter,
    // Vercel overwrites X-Forwarded-For at ingress to prevent IP spoofing.
    // Do not accept client-supplied X-Real-IP, X-Vercel-IP, or arbitrary XFF
    // outside verified Vercel infrastructure. No untrusted proxy fallback.
    trustedSource(request) {
      if (process.env.VERCEL !== '1') return null;
      return request.headers.get('x-forwarded-for');
    },
    acquire: async (): Promise<GatewayLease> => {
      if (pool.waitingCount >= 4) throw new Error('Gateway pool backpressure');
      const client = await pool.connect();
      try {
        const result = await client.query(
          "select session_user as login, r.rolsuper, r.rolcreatedb, r.rolcreaterole, " +
          "r.rolbypassrls, r.rolinherit, r.rolcanlogin, " +
          "pg_has_role(session_user,'competency_test_gateway','member') as is_gateway, " +
          "has_table_privilege(session_user,'private.competency_test_grants','SELECT') as direct_read, " +
          "has_function_privilege(session_user,'public.create_competency_test_grant(uuid,uuid,timestamptz,uuid)','EXECUTE') as issuer " +
          "from pg_roles r where r.rolname=session_user"
        );
        const role = result.rows[0];
        const expectedUser = new URL(dsn).username;
        if (!role || role.login !== expectedUser || !role.rolcanlogin ||
            role.rolsuper || role.rolcreatedb || role.rolcreaterole ||
            role.rolbypassrls || role.rolinherit || !role.is_gateway ||
            role.direct_read || role.issuer) throw new Error('Unsafe dedicated gateway role');
        // Keep one connection leased for SET LOCAL ROLE, all SQL and COMMIT.
        return { query: (sql, args) => client.query(sql, args), release: destroy => client.release(!!destroy) };
      } catch {
        client.release(true);
        throw new Error('Gateway role verification failed');
      }
    }
  });
}
export async function competencyBrokerPost(request: Request): Promise<Response> {
  if (process.env.COMPETENCY_BROKER_ENABLED !== 'true') return disabled();
  try {
    if (!ready) ready = construct();
    return await (await ready)(request);
  } catch {
    // Configuration and adapter errors are never logged with DSNs or tokens.
    ready = undefined;
    return disabled();
  }
}
export function competencyBrokerOtherMethod(): Response {
  return competencyBrokerMethodDenied();
}
