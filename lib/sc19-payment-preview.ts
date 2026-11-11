// The only supported deployments for this adapter. Vercel injects the deployment
// identity; never derive it, a callback origin or a database host from headers.
//
// TWO deployments, both PRZELEWY24 SANDBOX:
//   1. the `integration` Preview on the test project skillcheck-preview, and
//   2. the production domain https://skillcheck.pl on the production project,
//      with the sandbox keys, so a Przelewy24 verifier can walk the purchase path
//      to the payment page and pay with test money (owner decision, by voice,
//      2026-11-11).
// There is no third case and there is no live case: without P24_SANDBOX=true
// nothing here returns a configuration, and the runtime that consumes it is
// composed with mode 'test', liveApproved false and the sandbox checkout origin
// only (lib/sc19-payment-preview-runtime.ts). Turning Przelewy24 LIVE on is a
// separate, separately reviewed change plus an owner decision; it is deliberately
// not prepared, stubbed or half-wired here.
const ref = 'orbyscrupgnupifzlqxp';
const role = 'sc19_p24_preview';
const productionRef = 'wsvjawuikxfzjyivxgsu';
const productionRole = 'sc19_p24_checkout';
// The site's own origin, as a constant. The callback and return URLs a buyer and
// Przelewy24 are sent to must not depend on a Host/X-Forwarded-Host header or on
// a value someone can edit in a dashboard, so NEXT_PUBLIC_SITE_URL is only
// allowed to AGREE with this, never to choose it.
const productionOrigin = 'https://skillcheck.pl';
const positiveId = (value: string | undefined) =>
  value && /^[1-9][0-9]{0,9}$/.test(value) ? Number(value) : null;

function przelewy24Keys(env: NodeJS.ProcessEnv) {
  const merchantId = positiveId(env.P24_MERCHANT_ID);
  const posId = positiveId(env.P24_POS_ID);
  const crc = env.P24_CRC, apiKey = env.P24_API_KEY;
  if (!merchantId || !posId || !crc || crc.length < 8 || !apiKey || apiKey.length < 16) return null;
  return { merchantId, posId, crc, apiKey };
}

/** The adapter's own restricted login: a Supabase transaction-pooler URL whose user
 * is exactly <role>.<project ref> on port 6543. Nothing else is accepted, so the
 * variable cannot be pointed at another cluster, another database, another role,
 * or weakened with connection options (`?sslmode=disable`). */
function restrictedDatabaseUrl(value: string | undefined, expectedRole: string, expectedRef: string) {
  try {
    const db = new URL(value ?? '');
    if (db.protocol !== 'postgresql:' || db.username !== expectedRole + '.' + expectedRef || !db.password ||
        !/^aws-[0-9]+-eu-west-1\.pooler\.supabase\.com$/.test(db.hostname) ||
        db.port !== '6543' || db.pathname !== '/postgres' || db.search || db.hash) return null;
    return db.href;
  } catch { return null; }
}

export function sc19PreviewPaymentConfig(env: NodeJS.ProcessEnv, requestOrigin?: string) {
  if (env.VERCEL !== '1' || env.VERCEL_ENV !== 'preview' ||
      env.VERCEL_GIT_COMMIT_REF !== 'integration' || env.P24_SANDBOX !== 'true' ||
      env.NEXT_PUBLIC_SUPABASE_URL !== `https://${ref}.supabase.co`) return null;

  const hosts = [env.VERCEL_BRANCH_URL, env.VERCEL_URL].filter(
    (host): host is string => !!host && /^[a-z0-9-]+\.vercel\.app$/.test(host));
  const origins = hosts.map(host => 'https://' + host);
  const appOrigin = requestOrigin ?? origins[0];
  if (!appOrigin || !origins.includes(appOrigin)) return null;

  const keys = przelewy24Keys(env);
  if (!keys) return null;
  const databaseUrl = restrictedDatabaseUrl(env.SC19_P24_PREVIEW_DATABASE_URL, role, ref);
  if (!databaseUrl) return null;
  return { appOrigin, databaseUrl, ...keys };
}

/** The same SANDBOX checkout, served from the production domain on the production
 * project. Everything is pinned: the deployment environment and branch, the
 * Supabase project, the sandbox flag, the adapter's own restricted login, and the
 * origin, which is this file's constant and never a request header. A request that
 * arrives under any other host (a *.vercel.app deployment URL, for example) gets
 * no configuration at all, so no order can be created whose payment callback would
 * point somewhere else. */
export function sc19ProductionSandboxPaymentConfig(env: NodeJS.ProcessEnv, requestOrigin?: string) {
  if (env.VERCEL !== '1' || env.VERCEL_ENV !== 'production' ||
      env.VERCEL_GIT_COMMIT_REF !== 'main' || env.P24_SANDBOX !== 'true' ||
      env.NEXT_PUBLIC_SUPABASE_URL !== `https://${productionRef}.supabase.co`) return null;

  // The configured site address must be the one this file knows, with no path,
  // query or fragment. A single trailing slash is the only tolerated difference.
  const site = env.NEXT_PUBLIC_SITE_URL;
  if (site !== productionOrigin && site !== productionOrigin + '/') return null;
  const appOrigin = productionOrigin;
  if (requestOrigin !== undefined && requestOrigin !== appOrigin) return null;

  const keys = przelewy24Keys(env);
  if (!keys) return null;
  const databaseUrl = restrictedDatabaseUrl(env.SC19_P24_CHECKOUT_DATABASE_URL, productionRole, productionRef);
  if (!databaseUrl) return null;
  return { appOrigin, databaseUrl, ...keys };
}

/** The only entry point callers use: whichever of the two sandbox deployments this
 * is, or null. The two cases are mutually exclusive by VERCEL_ENV. */
export function sc19SandboxPaymentConfig(env: NodeJS.ProcessEnv, requestOrigin?: string) {
  return sc19PreviewPaymentConfig(env, requestOrigin) ?? sc19ProductionSandboxPaymentConfig(env, requestOrigin);
}
