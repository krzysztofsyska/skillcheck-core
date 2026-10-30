/**
 * SC-011-B2 HTTP boundary for Retell webhooks. The route answers 404 until a
 * reviewed runtime is composed (see resolveRetellWebhookRuntime). Responses
 * carry no body: nothing about the call, tenant or error reaches the caller.
 */
import type { SqlClient } from "./trusted-source-verifier.ts";
import { ingestRetellWebhook } from "./retell-dispatch-ledger.ts";
import { RETELL_WEBHOOK_MAX_BYTES, RetellWebhookError, type RetellWebhookConfig } from "./retell-webhook.ts";

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
    try {
      const { outcome } = await runtime.withClient(db => ingestRetellWebhook(
        db, body, request.headers.get("x-retell-signature"), runtime.config, runtime.now()));
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

/** Intentional deployment gate, like resolveSc19PaymentRuntime. Replace only
 * after the dispatch schema is a reviewed migration with erasure adapters, the
 * webhook key is a server secret and a scoped database role exists. */
export async function resolveRetellWebhookRuntime(): Promise<RetellWebhookRuntime | null> {
  return null;
}
