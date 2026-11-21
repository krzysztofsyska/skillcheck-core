/** R7: when the Stripe checkout may be composed at all, from the environment only.
 *
 * Two deployments, the same two the payment adapter already knows:
 *   1. the `integration` Preview on the test project skillcheck-preview — TEST keys only;
 *   2. https://skillcheck.pl on the production project.
 * Everything is pinned as in lib/sc19-payment-preview.ts: deployment environment and
 * branch, Supabase project, the adapter's restricted database login, and the origin.
 * A request under any other host gets no configuration.
 *
 * Keys: STRIPE_SECRET_KEY (mode from its prefix sk_/rk_ + live/test) and
 * STRIPE_WEBHOOK_SECRET. Values are never returned in a refusal or logged.
 *
 * LIVE: this file may return a live configuration (the key decides the mode), but
 * the runtime is composed with liveApproved=false and the database policies accept
 * only mode='test' orders, so a live key cannot open a checkout or create an order.
 * Opening live payments is a separate reviewed change after the owner's decision
 * (AGENTS.md, „Continuous release policy”, payment path).
 */
import type { PaymentMode } from './sc19-payments.ts';
import { publicShape, restrictedDatabaseUrl } from './sc19-payment-preview.ts';
import { stripeModeOf } from './sc19-stripe-provider.ts';

const previewRef = 'orbyscrupgnupifzlqxp';
const productionRef = 'wsvjawuikxfzjyivxgsu';
const productionOrigin = 'https://skillcheck.pl';

export type Sc19StripeConfig = Readonly<{
  deployment: 'preview' | 'production'; appOrigin: string; databaseUrl: string;
  secretKey: string; webhookSecret: string; mode: PaymentMode;
}>;
export type Sc19StripeGate =
  | Readonly<{ ok: true; config: Sc19StripeConfig }>
  | Readonly<{ ok: false; reason: string; shape: string }>;
const refuse = (reason: string, shape: string): Sc19StripeGate => ({ ok: false, reason, shape });
const secretShape = (value: string | undefined) =>
  value === undefined ? 'missing' : value === '' ? 'empty' : `length:${value.length}`;

function keys(env: NodeJS.ProcessEnv) {
  const mode = stripeModeOf(env.STRIPE_SECRET_KEY);
  if (!mode) return refuse('stripe_secret_key', secretShape(env.STRIPE_SECRET_KEY));
  if (!/^whsec_[A-Za-z0-9]{16,}$/.test(env.STRIPE_WEBHOOK_SECRET ?? ''))
    return refuse('stripe_webhook_secret', secretShape(env.STRIPE_WEBHOOK_SECRET));
  return { secretKey: env.STRIPE_SECRET_KEY as string, webhookSecret: env.STRIPE_WEBHOOK_SECRET as string, mode };
}

export function sc19StripeGate(env: NodeJS.ProcessEnv, requestOrigin?: string): Sc19StripeGate {
  if (env.VERCEL !== '1') return refuse('not_vercel', publicShape(env.VERCEL));
  const k = keys(env);
  if ('ok' in k) return k;
  if (env.VERCEL_ENV === 'preview') {
    if (env.VERCEL_GIT_COMMIT_REF !== 'integration') return refuse('git_ref', publicShape(env.VERCEL_GIT_COMMIT_REF));
    if (env.NEXT_PUBLIC_SUPABASE_URL !== `https://${previewRef}.supabase.co`)
      return refuse('supabase_url', publicShape(env.NEXT_PUBLIC_SUPABASE_URL));
    // The test project never takes real money.
    if (k.mode !== 'test') return refuse('stripe_mode', 'live_key_on_preview');
    const origins = [env.VERCEL_BRANCH_URL, env.VERCEL_URL]
      .filter((h): h is string => !!h && /^[a-z0-9-]+\.vercel\.app$/.test(h)).map(h => 'https://' + h);
    const appOrigin = requestOrigin ?? origins[0];
    if (!appOrigin) return refuse('deployment_host', publicShape(env.VERCEL_BRANCH_URL ?? env.VERCEL_URL));
    if (!origins.includes(appOrigin)) return refuse('request_origin', publicShape(appOrigin));
    const db = restrictedDatabaseUrl(env.SC19_P24_PREVIEW_DATABASE_URL, 'sc19_p24_preview', previewRef);
    if (!db.url) return refuse('database_url', db.shape);
    return { ok: true, config: { deployment: 'preview', appOrigin, databaseUrl: db.url, ...k } };
  }
  if (env.VERCEL_ENV === 'production') {
    if (env.VERCEL_GIT_COMMIT_REF !== 'main') return refuse('git_ref', publicShape(env.VERCEL_GIT_COMMIT_REF));
    if (env.NEXT_PUBLIC_SUPABASE_URL !== `https://${productionRef}.supabase.co`)
      return refuse('supabase_url', publicShape(env.NEXT_PUBLIC_SUPABASE_URL));
    const site = env.NEXT_PUBLIC_SITE_URL;
    if (site !== productionOrigin && site !== productionOrigin + '/') return refuse('site_url', publicShape(site));
    if (requestOrigin !== undefined && requestOrigin !== productionOrigin)
      return refuse('request_origin', publicShape(requestOrigin));
    const db = restrictedDatabaseUrl(env.SC19_P24_CHECKOUT_DATABASE_URL, 'sc19_p24_checkout', productionRef);
    if (!db.url) return refuse('database_url', db.shape);
    return { ok: true, config: { deployment: 'production', appOrigin: productionOrigin, databaseUrl: db.url, ...k } };
  }
  return refuse('vercel_env', publicShape(env.VERCEL_ENV));
}

export function sc19StripeConfig(env: NodeJS.ProcessEnv, requestOrigin?: string): Sc19StripeConfig | null {
  const gate = sc19StripeGate(env, requestOrigin);
  return gate.ok ? gate.config : null;
}
