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
//
// SC-P24-DIAG-001: the gate now returns WHY it refused, not just null. The
// decision itself is unchanged and is written exactly once, here: the two
// `…PaymentConfig()` functions are thin wrappers that drop the reason, so an
// operator diagnostic can never report a different verdict than the runtime
// actually took. A reason is a condition NAME plus a non-reversible shape hint
// (missing / empty / length) — never a key, a password or a connection string.
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

/** Every condition the gate can refuse on, as a stable machine name. */
export type Sc19GateReason =
  | 'not_vercel' | 'vercel_env' | 'git_ref' | 'sandbox_flag' | 'supabase_url'
  | 'site_url' | 'deployment_host' | 'request_origin'
  | 'p24_merchant_id' | 'p24_pos_id' | 'p24_crc' | 'p24_api_key' | 'database_url';
export type Sc19GateRefusal = Readonly<{ reason: Sc19GateReason; shape: string }>;
export type Sc19SandboxConfig = Readonly<{
  appOrigin: string; databaseUrl: string;
  merchantId: number; posId: number; crc: string; apiKey: string;
}>;
export type Sc19SandboxGate =
  | Readonly<{ ok: true; config: Sc19SandboxConfig }>
  | Readonly<{ ok: false; refusal: Sc19GateRefusal }>;

const refuse = (reason: Sc19GateReason, shape: string): Sc19SandboxGate =>
  ({ ok: false, refusal: { reason, shape } });
/** Shape of a SECRET value: presence and length only, never any character of it. */
const secretShape = (value: string | undefined) =>
  value === undefined ? 'missing' : value === '' ? 'empty' : `length:${value.length}`;
/** Shape of a value that is public by construction (deployment identity, a
 * NEXT_PUBLIC_* address, an on/off flag): the value itself names the typo, which
 * is the whole point of the diagnostic. Anything long enough to be a key or a
 * password is reported by length instead, so a value pasted into the wrong
 * variable is never echoed back. */
const publicShape = (value: string | undefined, max = 64) =>
  value === undefined ? 'missing' : value === '' ? 'empty' :
    value.length > max || !/^[\x20-\x7E]*$/.test(value) ? `length:${value.length}` : `value:${value}`;

function przelewy24Keys(env: NodeJS.ProcessEnv): Sc19GateRefusal | Readonly<{
  merchantId: number; posId: number; crc: string; apiKey: string;
}> {
  const merchantId = positiveId(env.P24_MERCHANT_ID);
  if (!merchantId) return { reason: 'p24_merchant_id', shape: secretShape(env.P24_MERCHANT_ID) };
  const posId = positiveId(env.P24_POS_ID);
  if (!posId) return { reason: 'p24_pos_id', shape: secretShape(env.P24_POS_ID) };
  const crc = env.P24_CRC, apiKey = env.P24_API_KEY;
  if (!crc || crc.length < 8) return { reason: 'p24_crc', shape: secretShape(crc) };
  if (!apiKey || apiKey.length < 16) return { reason: 'p24_api_key', shape: secretShape(apiKey) };
  return { merchantId, posId, crc, apiKey };
}
const isRefusal = (value: object): value is Sc19GateRefusal => 'reason' in value;

/** The adapter's own restricted login: a Supabase transaction-pooler URL whose user
 * is exactly <role>.<project ref> on port 6543. Nothing else is accepted, so the
 * variable cannot be pointed at another cluster, another database, another role,
 * or weakened with connection options (`?sslmode=disable`).
 *
 * On refusal it names the PARTS that disagree — protocol, username, password,
 * host, port, path, query — and never a part's value. */
function restrictedDatabaseUrl(value: string | undefined, expectedRole: string, expectedRef: string) {
  if (!value) return { url: null, shape: value === '' ? 'empty' : 'missing' };
  let db: URL;
  try { db = new URL(value); } catch { return { url: null, shape: `not_a_url,length:${value.length}` }; }
  const wrong: string[] = [];
  if (db.protocol !== 'postgresql:') wrong.push('protocol');
  if (db.username !== expectedRole + '.' + expectedRef) wrong.push('username');
  if (!db.password) wrong.push('password');
  if (!/^aws-[0-9]+-eu-west-1\.pooler\.supabase\.com$/.test(db.hostname)) wrong.push('host');
  if (db.port !== '6543') wrong.push('port');
  if (db.pathname !== '/postgres') wrong.push('path');
  if (db.search || db.hash) wrong.push('query');
  return wrong.length ? { url: null, shape: 'wrong:' + wrong.join('+') } : { url: db.href, shape: 'ok' };
}

/** The `integration` Preview on the test project, with the reason it refused. */
export function sc19PreviewPaymentGate(env: NodeJS.ProcessEnv, requestOrigin?: string): Sc19SandboxGate {
  if (env.VERCEL !== '1') return refuse('not_vercel', publicShape(env.VERCEL));
  if (env.VERCEL_ENV !== 'preview') return refuse('vercel_env', publicShape(env.VERCEL_ENV));
  if (env.VERCEL_GIT_COMMIT_REF !== 'integration') return refuse('git_ref', publicShape(env.VERCEL_GIT_COMMIT_REF));
  if (env.P24_SANDBOX !== 'true') return refuse('sandbox_flag', publicShape(env.P24_SANDBOX, 16));
  if (env.NEXT_PUBLIC_SUPABASE_URL !== `https://${ref}.supabase.co`)
    return refuse('supabase_url', publicShape(env.NEXT_PUBLIC_SUPABASE_URL));

  const hosts = [env.VERCEL_BRANCH_URL, env.VERCEL_URL].filter(
    (host): host is string => !!host && /^[a-z0-9-]+\.vercel\.app$/.test(host));
  const origins = hosts.map(host => 'https://' + host);
  const appOrigin = requestOrigin ?? origins[0];
  if (!appOrigin) return refuse('deployment_host', publicShape(env.VERCEL_BRANCH_URL ?? env.VERCEL_URL));
  if (!origins.includes(appOrigin)) return refuse('request_origin', publicShape(appOrigin));

  const keys = przelewy24Keys(env);
  if (isRefusal(keys)) return { ok: false, refusal: keys };
  const database = restrictedDatabaseUrl(env.SC19_P24_PREVIEW_DATABASE_URL, role, ref);
  if (!database.url) return refuse('database_url', database.shape);
  return { ok: true, config: { appOrigin, databaseUrl: database.url, ...keys } };
}

/** The same SANDBOX checkout, served from the production domain on the production
 * project, with the reason it refused. Everything is pinned: the deployment
 * environment and branch, the Supabase project, the sandbox flag, the adapter's
 * own restricted login, and the origin, which is this file's constant and never a
 * request header. A request that arrives under any other host (a *.vercel.app
 * deployment URL, for example) gets no configuration at all, so no order can be
 * created whose payment callback would point somewhere else. */
export function sc19ProductionSandboxPaymentGate(env: NodeJS.ProcessEnv, requestOrigin?: string): Sc19SandboxGate {
  if (env.VERCEL !== '1') return refuse('not_vercel', publicShape(env.VERCEL));
  if (env.VERCEL_ENV !== 'production') return refuse('vercel_env', publicShape(env.VERCEL_ENV));
  if (env.VERCEL_GIT_COMMIT_REF !== 'main') return refuse('git_ref', publicShape(env.VERCEL_GIT_COMMIT_REF));
  if (env.P24_SANDBOX !== 'true') return refuse('sandbox_flag', publicShape(env.P24_SANDBOX, 16));
  if (env.NEXT_PUBLIC_SUPABASE_URL !== `https://${productionRef}.supabase.co`)
    return refuse('supabase_url', publicShape(env.NEXT_PUBLIC_SUPABASE_URL));

  // The configured site address must be the one this file knows, with no path,
  // query or fragment. A single trailing slash is the only tolerated difference.
  const site = env.NEXT_PUBLIC_SITE_URL;
  if (site !== productionOrigin && site !== productionOrigin + '/')
    return refuse('site_url', publicShape(site));
  const appOrigin = productionOrigin;
  if (requestOrigin !== undefined && requestOrigin !== appOrigin)
    return refuse('request_origin', publicShape(requestOrigin));

  const keys = przelewy24Keys(env);
  if (isRefusal(keys)) return { ok: false, refusal: keys };
  const database = restrictedDatabaseUrl(env.SC19_P24_CHECKOUT_DATABASE_URL, productionRole, productionRef);
  if (!database.url) return refuse('database_url', database.shape);
  return { ok: true, config: { appOrigin, databaseUrl: database.url, ...keys } };
}

/** Whichever of the two sandbox deployments this is, with the reason it refused.
 * The two cases are mutually exclusive by VERCEL_ENV, so the reported reason is
 * the one from the branch this deployment actually belongs to; a deployment that
 * is neither gets the production branch's answer, which names VERCEL_ENV. */
export function sc19SandboxPaymentGate(env: NodeJS.ProcessEnv, requestOrigin?: string): Sc19SandboxGate {
  const preview = sc19PreviewPaymentGate(env, requestOrigin);
  if (preview.ok) return preview;
  const production = sc19ProductionSandboxPaymentGate(env, requestOrigin);
  return production.ok || env.VERCEL_ENV === 'production' ? production : preview;
}

export function sc19PreviewPaymentConfig(env: NodeJS.ProcessEnv, requestOrigin?: string) {
  const gate = sc19PreviewPaymentGate(env, requestOrigin);
  return gate.ok ? gate.config : null;
}
export function sc19ProductionSandboxPaymentConfig(env: NodeJS.ProcessEnv, requestOrigin?: string) {
  const gate = sc19ProductionSandboxPaymentGate(env, requestOrigin);
  return gate.ok ? gate.config : null;
}
/** The only entry point callers use: whichever of the two sandbox deployments this
 * is, or null. The two cases are mutually exclusive by VERCEL_ENV. */
export function sc19SandboxPaymentConfig(env: NodeJS.ProcessEnv, requestOrigin?: string) {
  const gate = sc19SandboxPaymentGate(env, requestOrigin);
  return gate.ok ? gate.config : null;
}
