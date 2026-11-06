// The only supported deployment for this adapter. Vercel injects the deployment
// identity; never derive it, a callback origin or a database host from headers.
const ref = 'orbyscrupgnupifzlqxp';
const role = 'sc19_p24_preview';
const positiveId = (value: string | undefined) =>
  value && /^[1-9][0-9]{0,9}$/.test(value) ? Number(value) : null;

export function sc19PreviewPaymentConfig(env: NodeJS.ProcessEnv, requestOrigin?: string) {
  if (env.VERCEL !== '1' || env.VERCEL_ENV !== 'preview' ||
      env.VERCEL_GIT_COMMIT_REF !== 'integration' || env.P24_SANDBOX !== 'true' ||
      env.NEXT_PUBLIC_SUPABASE_URL !== `https://${ref}.supabase.co`) return null;

  const hosts = [env.VERCEL_BRANCH_URL, env.VERCEL_URL].filter(
    (host): host is string => !!host && /^[a-z0-9-]+\.vercel\.app$/.test(host));
  const origins = hosts.map(host => 'https://' + host);
  const appOrigin = requestOrigin ?? origins[0];
  if (!appOrigin || !origins.includes(appOrigin)) return null;

  const merchantId = positiveId(env.P24_MERCHANT_ID);
  const posId = positiveId(env.P24_POS_ID);
  const crc = env.P24_CRC, apiKey = env.P24_API_KEY;
  if (!merchantId || !posId || !crc || crc.length < 8 || !apiKey || apiKey.length < 16) return null;
  try {
    const db = new URL(env.SC19_P24_PREVIEW_DATABASE_URL ?? '');
    if (db.protocol !== 'postgresql:' || db.username !== role + '.' + ref || !db.password ||
        !/^aws-[0-9]+-eu-west-1\.pooler\.supabase\.com$/.test(db.hostname) ||
        db.port !== '6543' || db.pathname !== '/postgres' || db.search || db.hash) return null;
    return { appOrigin, databaseUrl: db.href, merchantId, posId, crc, apiKey };
  } catch { return null; }
}
