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

// RPC envelope validation is strict even though parsePump intentionally skips individual
// invalid attempt IDs. A claimed scheduler batch must never disappear as a successful no-op.
/** Only a complete, tenant-bound database notification can be sent or acknowledged.
 * A damaged RPC response must keep the SQL lease retryable instead of mailing a broken link.
 */ 
function isBulkNotify(value: unknown): value is BulkNotify {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const n = value as Record<string, unknown>;
  if (!['batch_id', 'recruitment_id', 'company_id'].every(k =>
    typeof n[k] === 'string' && uuid.test(n[k] as string))) return false;
  if (n.email !== null && (typeof n.email !== 'string' || !n.email.trim())) return false;
  if (n.recruitment_name !== null && typeof n.recruitment_name !== 'string') return false;
  if (!['files', 'done', 'errors', 'passed', 'review', 'rejected'].every(k => {
    const count = n[k];
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
  })) return false;
  // A notification summarizes one completed batch. Never mail or acknowledge
  // impossible totals from a malformed SQL/RPC payload. Subtraction avoids
  // precision loss when the input contains large (but safe) integer counts.
  const files = n.files as number, done = n.done as number, errors = n.errors as number;
  const passed = n.passed as number, review = n.review as number, rejected = n.rejected as number;
  return done <= files && errors <= files - done &&
    passed <= done && review <= done - passed && rejected <= done - passed - review;
}

function isPumpEnvelope(value: unknown): value is { dispatch: unknown[]; notify: unknown } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as { dispatch?: unknown; notify?: unknown; error?: unknown };
  // SQL isolates batch failures and returns { dispatch: [], notify: null, error: sqlstate }.
  // Such a batch was not processed successfully and must remain visible as a failure.
  if (record.error !== undefined && record.error !== null) return false;
  if (!Array.isArray(record.dispatch) || !Object.prototype.hasOwnProperty.call(record, 'notify')) return false;
  const n = record.notify;
  return n === null || isBulkNotify(n);
}

export function parsePump(value: unknown): PumpResult {
  const v = (value ?? {}) as { dispatch?: unknown; notify?: unknown };
  // Prevent a malformed/retried pump response from dispatching the same attempt twice.
  // UUIDs are case-insensitive in PostgreSQL, so normalize before deduplication.
  const dispatch = Array.isArray(v.dispatch)
    ? Array.from(new Set(v.dispatch.filter((x): x is string => typeof x === 'string' && uuid.test(x)).map(id => id.toLowerCase())))
    : [];
  const n = v.notify as BulkNotify | null | undefined;
  return { dispatch, notify: isBulkNotify(n) ? n : null };
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
  // PostgreSQL always returns an object containing dispatch[] and notify (possibly null).
  // A null/partial successful RPC response must never be shown as an empty successful pump.
  if (!isPumpEnvelope(data)) throw new Error('cv_bulk_pump_invalid_response');
  const result = parsePump(data);
  // A session request is for one particular batch. Do not send a link or
  // acknowledge a lease for a different batch if the RPC response is mixed up.
  if (result.notify && result.notify.batch_id.toLowerCase() !== batchId.toLowerCase()) {
    throw new Error('cv_bulk_pump_invalid_response');
  }
  await deliver(deps, result, async (batch, outcome) => {
    const { data: acknowledged, error: finishError } = await deps.rpc('cv_bulk_finish_notification', { target_batch: batch, outcome });
    // SQL returns false when no sending lease was finalized; no RPC error is not enough.
    if (finishError || acknowledged !== true) throw new Error('cv_bulk_notification_finish_failed');
  });
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
  // Malformed RPC output must not look like an empty successful scheduler run.
  if (!Array.isArray(data)) throw new Error('cv_bulk_worker_pump_invalid_response');
  let malformed = false;
  // The SQL worker normally returns each attempt and notification lease once. A malformed
  // cross-batch response must not dispatch an attempt or finalize a notification twice.
  // Continue delivering unrelated claims, but report the invariant violation to the caller.
  const seenAttempts = new Set<string>(), seenNotifications = new Set<string>();
  const results = await Promise.allSettled(data.map(one => {
    if (!isPumpEnvelope(one)) {
      malformed = true;
      return Promise.reject(new Error('cv_bulk_worker_pump_invalid_response'));
    }
    const result = parsePump(one);
    result.dispatch = result.dispatch.filter(id => {
      if (seenAttempts.has(id)) { malformed = true; return false; }
      seenAttempts.add(id);
      return true;
    });
    if (result.notify) {
      const id = result.notify.batch_id.toLowerCase();
      if (seenNotifications.has(id)) {
        malformed = true;
        result.notify = null;
      } else seenNotifications.add(id);
    }
    return deliver(deps, result, async (batch, outcome) => {
      const id = randomUUID(), at = Date.now();
      const { data: acknowledged, error: finishError } = await deps.rpc('cv_bulk_finish_notification', { target_batch: batch, outcome, request_id: id, issued_at_ms: at,
        request_signature: bulkWorkerSignature(deps.secret, 'notify', id, at, batch, outcome) });
      if (finishError || acknowledged !== true) throw new Error('cv_bulk_notification_finish_failed');
    });
  }));
  // Do not let malformed claimed batches masquerade as success. Valid batches still
  // finish independently; never expose provider/DB contents in the error.
  if (malformed) throw new Error('cv_bulk_worker_pump_invalid_response');
  if (results.some(result => result.status === 'rejected')) throw new Error('cv_bulk_worker_delivery_failed');
  return data.length;
}

/** PostgreSQL jsonb::text rendering for flat objects of strings/numbers: keys by length then bytes, ", " and ": " separators. */
export function canonicalJsonb(value: Record<string, string | number | null> | null) {
  if (value === null) return '';
  const keys = Object.keys(value).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  return '{' + keys.map(k => `${JSON.stringify(k)}: ${JSON.stringify(value[k])}`).join(', ') + '}';
}
