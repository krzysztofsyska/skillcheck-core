import { createHmac, randomUUID } from 'node:crypto';
import { screeningEvidenceAiContract } from './screening-ai.ts';
import { bulkMailEnabled, bulkPricing, sendBulkEmail, type BulkNotify } from './cv-bulk.ts';

// Pump: settle finished analyses, start queued files within the parallel
// limits (enforced in SQL), dispatch the signed attempts and send the batch
// e-mail once. Used by uploads, the progress page and the scheduler route.

export type PumpResult = { dispatch: string[]; notify: BulkNotify | null };
type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
export type PumpDeps = {
  rpc: Rpc;
  dispatch: (attemptId: string) => Promise<{ accepted: boolean }>;
  aiEnabled: boolean;
  origin: () => string;
  env?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function bulkContract(aiEnabled: boolean) {
  if (!aiEnabled) return null;
  const c = screeningEvidenceAiContract;
  return { payload_schema_version: c.payload_schema_version, result_schema_version: c.result_schema_version,
    prompt_version: c.prompt_version, provider: c.provider, model: c.model, model_revision: c.model_revision };
}

export function parsePump(value: unknown): PumpResult {
  const v = (value ?? {}) as { dispatch?: unknown; notify?: unknown };
  const dispatch = Array.isArray(v.dispatch) ? v.dispatch.filter((x): x is string => typeof x === 'string' && uuid.test(x)) : [];
  const n = v.notify as BulkNotify | null | undefined;
  return { dispatch, notify: n && typeof n === 'object' && typeof n.batch_id === 'string' && uuid.test(n.batch_id) ? n : null };
}

async function deliver(deps: PumpDeps, result: PumpResult, finish: (batch: string, outcome: 'sent' | 'failed' | 'skipped') => Promise<void>) {
  // Dispatch failures are retried by the pump (pending attempts are re-sent after 3 min).
  await Promise.all(result.dispatch.map(id => deps.dispatch(id).catch(() => ({ accepted: false }))));
  if (result.notify) {
    const env = deps.env ?? process.env;
    let outcome: 'sent' | 'failed' | 'skipped' = 'skipped';
    if (bulkMailEnabled(env)) {
      try { outcome = await sendBulkEmail(result.notify, deps.origin(), env.RESEND_API_KEY!, deps.fetcher); }
      catch { outcome = 'failed'; }
    }
    await finish(result.notify.batch_id, outcome);
  }
}

/** Pump one batch as the signed-in recruiter. */
export async function pumpBatch(deps: PumpDeps, batchId: string) {
  const env = deps.env ?? process.env;
  const { data, error } = await deps.rpc('cv_bulk_pump', { target_batch: batchId, contract: bulkContract(deps.aiEnabled), pricing: bulkPricing(env) });
  if (error) throw new Error('cv_bulk_pump_failed');
  const result = parsePump(data);
  await deliver(deps, result, async (batch, outcome) => { await deps.rpc('cv_bulk_finish_notification', { target_batch: batch, outcome }); });
  return result;
}

export function bulkWorkerSignature(secret: string, op: 'pump' | 'notify', requestId: string, stamp: number, target: string | null, extra: string | null) {
  return createHmac('sha256', secret).update(['cv-bulk-v1', op, requestId, String(stamp), target ?? '-', extra ?? '-'].join('\n')).digest('hex');
}

/**
 * Scheduler pump without a user session: every call is signed with the worker secret. The SQL pump has already
 * counted a re-send / e-mail attempt for every batch it returns, so every returned batch is delivered: all
 * batches in parallel, each bounded by the dispatch (15 s) and e-mail (10 s) timeouts, so the route stays
 * inside maxDuration 60 s however many batches (at most 20) come back.
 */
export async function pumpAllSigned(deps: PumpDeps & { secret: string; digest: (text: string) => string }) {
  const env = deps.env ?? process.env;
  const contract = bulkContract(deps.aiEnabled), pricing = bulkPricing(env);
  const requestId = randomUUID(), stamp = Date.now();
  // sha256 over the same canonical text as (contract::text || '|' || pricing::text) in SQL (jsonb canonical form).
  const extra = deps.digest(`${canonicalJsonb(contract)}|${canonicalJsonb(pricing)}`);
  const { data, error } = await deps.rpc('cv_bulk_worker_pump', { request_id: requestId, issued_at_ms: stamp,
    request_signature: bulkWorkerSignature(deps.secret, 'pump', requestId, stamp, null, extra), contract, pricing });
  if (error) throw new Error('cv_bulk_worker_pump_failed');
  const batches = Array.isArray(data) ? data : [];
  await Promise.all(batches.map(one => deliver(deps, parsePump(one), async (batch, outcome) => {
    const id = randomUUID(), at = Date.now();
    await deps.rpc('cv_bulk_finish_notification', { target_batch: batch, outcome, request_id: id, issued_at_ms: at,
      request_signature: bulkWorkerSignature(deps.secret, 'notify', id, at, batch, outcome) });
  }).catch(() => undefined)));
  return batches.length;
}

/** PostgreSQL jsonb::text rendering for flat objects of strings/numbers: keys by length then bytes, ", " and ": " separators. */
export function canonicalJsonb(value: Record<string, string | number | null> | null) {
  if (value === null) return '';
  const keys = Object.keys(value).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  return '{' + keys.map(k => `${JSON.stringify(k)}: ${JSON.stringify(value[k])}`).join(', ') + '}';
}
