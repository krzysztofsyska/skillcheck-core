/**
 * SC-011-B2 HTTP boundary for Retell webhooks. The route answers 404 unless a
 * runtime is composed (see resolveRetellWebhookRuntime; off by default). Responses
 * carry no body: nothing about the call, tenant or error reaches the caller.
 */
import type { SqlClient } from "./trusted-source-verifier.ts";
import { ingestRetellWebhook } from "./retell-dispatch-ledger.ts";
import {
  readRetellWebhook, RETELL_WEBHOOK_MAX_BYTES, RetellWebhookError, type RetellWebhookConfig,
} from "./retell-webhook.ts";
import { retellWebhookGate } from "./retell-webhook-config.ts";

export type RetellWebhookRuntime = Readonly<{
  config: RetellWebhookConfig;
  /** Lends a dedicated trusted connection for one transaction and releases it. */
  withClient<T>(work: (db: SqlClient) => Promise<T>): Promise<T>;
  now(): number;
}>;

async function readBounded(request: Request): Promise<Uint8Array | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d{1,9}$/.test(declared) || Number(declared) > RETELL_WEBHOOK_MAX_BYTES))
    return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RETELL_WEBHOOK_MAX_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

export function createRetellWebhookHttp(runtime: RetellWebhookRuntime | null) {
  return async function POST(request: Request): Promise<Response> {
    if (!runtime) return new Response(null, { status: 404 });
    const body = await readBounded(request);
    if (!body) return new Response(null, { status: 413 });
    const signature = request.headers.get("x-retell-signature");
    try {
      // Authenticate before borrowing a database connection: an unsigned or
      // forged delivery never reaches the pool. The ledger checks it again.
      readRetellWebhook(body, signature, runtime.config, runtime.now());
      const { outcome } = await runtime.withClient(db => ingestRetellWebhook(
        db, body, signature, runtime.config, runtime.now()));
      // An unknown call id may still be committing at dispatch: ask Retell to retry.
      return new Response(null, { status: outcome === "uncorrelated" ? 503 : 204 });
    } catch (error) {
      if (error instanceof RetellWebhookError)
        return new Response(null, { status: error.code === "RETELL_WEBHOOK_UNAUTHENTICATED" ? 401 : 400 });
      // Retell retries non-2xx deliveries; a ledger failure must not be acknowledged.
      return new Response(null, { status: 503 });
    }
  };
}

/** R6-1e deployment gate. Null (route answers 404) unless retellWebhookGate
 * accepts the environment: explicit RETELL_WEBHOOK_ENABLED=true, a Preview build
 * of `integration` on skillcheck-preview, the webhook key, the pinned agent and
 * the scoped `retell_webhook` database login. Production always gets null here.
 * The dispatch schema with erasure adapters is migration
 * 20261119180000_r6_voice_dispatch_r20.sql; the scoped role is a separate step. */
export async function resolveRetellWebhookRuntime(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RetellWebhookRuntime | null> {
  const gate = retellWebhookGate(env);
  if (!gate.ok) return null;
  const { composeRetellWebhookRuntime } = await import("./retell-webhook-runtime.ts");
  return composeRetellWebhookRuntime(gate.config);
}
