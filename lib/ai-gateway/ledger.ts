// SC-021-B: durable ledger of physical AI attempts (`ai_ledger.attempts`, migration
// 20261109200000_sc021_ai_ledger.sql). Server-only; bundled into the screening worker (Deno),
// so no Node-only APIs here.
//
// The hook never sends a prompt, CV text or provider body: only identifiers, model, outcome,
// billing certainty, token counts and latency. The database derives the company, process and
// candidate reference from trusted state (the screening attempt / the generation reservation)
// and only checks `company_id` from this payload for consistency.
import { AiGatewayError, type BillingCertainty } from './contract.ts';
import type { AttemptRecord } from './gateway.ts';

/** Exactly the keys `ai_ledger.record_attempt` accepts; anything else is refused by the database. */
export type LedgerAttemptPayload = {
  attempt_id: string;
  operation_id: string;
  company_id: string;
  task: AttemptRecord['task'];
  attempt: number;
  provider: AttemptRecord['provider'];
  model: string;
  model_revision: string | null;
  model_key: string;
  policy_version: string;
  outcome: AttemptRecord['outcome'];
  billing: AttemptRecord['billing'];
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  provider_request_id: string | null;
  latency_ms: number;
};

/** Writes one payload durably (RPC). Must resolve only once the row is committed or replayed. */
export type LedgerWriter = (payload: LedgerAttemptPayload) => Promise<void>;

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function ledgerPayload(record: AttemptRecord): LedgerAttemptPayload {
  return {
    attempt_id: record.attemptId,
    operation_id: record.operationId,
    company_id: record.companyId,
    task: record.task,
    attempt: record.attempt,
    provider: record.provider,
    model: record.model,
    model_revision: record.revision,
    model_key: record.modelKey,
    policy_version: record.policyVersion,
    outcome: record.outcome,
    billing: record.billing,
    input_tokens: record.usage?.inputTokens ?? null,
    cached_input_tokens: record.usage?.cachedInputTokens ?? null,
    output_tokens: record.usage?.outputTokens ?? null,
    // Never for screening: the provider-side record of a CV request is erasure-inventory data
    // (public.screening_analysis_attempts). Unexpected shapes are dropped, not sent.
    provider_request_id: record.task !== 'cv_screening' && record.providerRequestId !== null
      && REQUEST_ID.test(record.providerRequestId) ? record.providerRequestId : null,
    latency_ms: Math.min(3_600_000, Math.max(0, Math.round(record.latencyMs))),
  };
}

/**
 * Billing certainty to report when an attempt could not be recorded. An answered attempt
 * (`billed`) that is missing from the ledger may still be charged: it is `maybe_billed`, never
 * `not_billed`. Only an attempt the provider refused before running stays `not_billed`.
 */
export function unrecordedBilling(billing: AttemptRecord['billing']): BillingCertainty {
  return billing === 'not_billed' ? 'not_billed' : 'maybe_billed';
}

/** `onAttempt` hook writing every physical attempt to the ledger; any failure is `ledger_error`. */
export function createLedgerHook(write: LedgerWriter) {
  if (typeof write !== 'function') throw new Error('SC021_LEDGER_WRITER_REQUIRED');
  return async function recordAttempt(record: AttemptRecord): Promise<void> {
    try {
      await write(ledgerPayload(record));
    } catch {
      // The writer's error may carry database text; only the code leaves this function.
      throw new AiGatewayError('ledger_error', unrecordedBilling(record.billing));
    }
  };
}
