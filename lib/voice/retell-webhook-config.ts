/**
 * R6-1e: when the Retell webhook runtime may be composed at all, from the
 * environment only. Fail closed: every condition below must hold, otherwise the
 * route keeps answering 404 exactly as before this change.
 *
 *   1. RETELL_WEBHOOK_ENABLED === 'true' (explicit switch, default off);
 *   2. a Vercel Preview build of `integration` on the test project
 *      skillcheck-preview. Production is refused here on purpose: opening the
 *      webhook in production is a separate reviewed change (AGENTS.md gates);
 *   3. RETELL_WEBHOOK_KEY: the webhook-enabled Retell API key (server only);
 *   4. RETELL_AGENT_ID and RETELL_AGENT_VERSION: the single pinned agent;
 *   5. RETELL_WEBHOOK_DATABASE_URL: the webhook's own restricted database login
 *      `retell_webhook.<preview ref>` on the transaction pooler — never a
 *      service key, never `postgres`. See lib/sc19-payment-preview.ts.
 *
 * Values are never returned in a refusal or logged: a refusal names the
 * variable and, for a secret, only its length.
 */
import { publicShape, restrictedDatabaseUrl } from '../sc19-payment-preview.ts';
import type { RetellWebhookConfig } from './retell-webhook.ts';

const previewRef = 'orbyscrupgnupifzlqxp';
/** The scoped database role the webhook connects as (see the PR's blocker note). */
export const RETELL_WEBHOOK_DATABASE_ROLE = 'retell_webhook';
const agentIdPattern = /^(?:agent_[A-Za-z0-9]{16,64}|[A-Za-z0-9]{32})$/;
const keyPattern = /^[\x21-\x7E]{16,256}$/;

export type RetellWebhookDeployment = Readonly<{
  deployment: 'preview'; databaseUrl: string; webhook: RetellWebhookConfig;
}>;
export type RetellWebhookGate =
  | Readonly<{ ok: true; config: RetellWebhookDeployment }>
  | Readonly<{ ok: false; reason: string; shape: string }>;

const refuse = (reason: string, shape: string): RetellWebhookGate => Object.freeze({ ok: false, reason, shape });
const secretShape = (value: string | undefined) =>
  value === undefined ? 'missing' : value === '' ? 'empty' : `length:${value.length}`;

export function retellWebhookGate(env: Readonly<Record<string, string | undefined>>): RetellWebhookGate {
  if (env.RETELL_WEBHOOK_ENABLED !== 'true') return refuse('disabled', publicShape(env.RETELL_WEBHOOK_ENABLED));
  if (env.VERCEL !== '1') return refuse('not_vercel', publicShape(env.VERCEL));
  if (env.VERCEL_ENV !== 'preview') return refuse('vercel_env', publicShape(env.VERCEL_ENV));
  if (env.VERCEL_GIT_COMMIT_REF !== 'integration') return refuse('git_ref', publicShape(env.VERCEL_GIT_COMMIT_REF));
  if (env.NEXT_PUBLIC_SUPABASE_URL !== `https://${previewRef}.supabase.co`)
    return refuse('supabase_url', publicShape(env.NEXT_PUBLIC_SUPABASE_URL));
  const key = env.RETELL_WEBHOOK_KEY;
  if (typeof key !== 'string' || !keyPattern.test(key)) return refuse('webhook_key', secretShape(key));
  const agentId = env.RETELL_AGENT_ID;
  if (typeof agentId !== 'string' || !agentIdPattern.test(agentId)) return refuse('agent_id', secretShape(agentId));
  const version = env.RETELL_AGENT_VERSION;
  if (typeof version !== 'string' || !/^(?:0|[1-9]\d{0,5})$/.test(version))
    return refuse('agent_version', publicShape(version, 8));
  const db = restrictedDatabaseUrl(env.RETELL_WEBHOOK_DATABASE_URL, RETELL_WEBHOOK_DATABASE_ROLE, previewRef);
  if (!db.url) return refuse('database_url', db.shape);
  return Object.freeze({ ok: true, config: Object.freeze({
    deployment: 'preview', databaseUrl: db.url,
    webhook: Object.freeze({ webhookKey: key, agentId, agentVersion: Number(version) }),
  }) });
}
