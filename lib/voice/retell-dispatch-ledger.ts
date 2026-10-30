/**
 * SC-011-B2: provider call ledger and Retell webhook ingestion on a dedicated,
 * trusted server PostgreSQL connection (db/isolated/sc011b2-voice-dispatch.sql).
 * No provider call happens here. The future SC-010-C worker records the call id
 * returned by create-phone-call; webhooks only update that recorded attempt.
 * Transcripts are NOT stored yet (SC-011-B3, 90-day retention after the
 * recruitment closes): they are dropped after authentication.
 */
import type { SqlClient } from "./trusted-source-verifier.ts";
import { projectVoiceProviderEvent } from "./provider-event-contract.ts";
import {
  readRetellWebhook, retellProviderEvent, RetellWebhookError,
  type RetellWebhookConfig, type RetellWebhookResult,
} from "./retell-webhook.ts";

export class RetellLedgerError extends Error {
  readonly code: "VOICE_ATTEMPT_REJECTED" | "VOICE_ATTEMPT_CONFLICT" | "VOICE_LEDGER_UNAVAILABLE";
  constructor(code: RetellLedgerError["code"]) { super(code); this.code = code; }
}
const fail = (code: RetellLedgerError["code"]): never => { throw new RetellLedgerError(code); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const callId = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

function databaseError(error: unknown): RetellLedgerError {
  if (error instanceof RetellLedgerError) return error;
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (["PT409", "23505", "40001", "40P01", "55P03"].includes(code))
    return new RetellLedgerError("VOICE_ATTEMPT_CONFLICT");
  if (["42501", "PT422", "23514"].includes(code)) return new RetellLedgerError("VOICE_ATTEMPT_REJECTED");
  return new RetellLedgerError("VOICE_LEDGER_UNAVAILABLE");
}
async function transaction<T>(db: SqlClient, work: () => Promise<T>): Promise<T> {
  try { await db.query("begin isolation level read committed"); } catch (e) { throw databaseError(e); }
  try {
    await db.query("set local statement_timeout='8s'");
    await db.query("set local lock_timeout='2s'");
    const result = await work();
    await db.query("commit");
    return result;
  } catch (e) {
    try { await db.query("rollback"); } catch { /* the original error is reported */ }
    throw e instanceof RetellWebhookError ? e : databaseError(e);
  }
}

/**
 * Records the provider call id for a prepared operation once the provider has
 * accepted the call. Replaying the same call id returns the same attempt; a
 * different call id for the same preparation is a conflict, never a redial.
 */
export async function recordRetellDispatch(
  db: SqlClient,
  input: Readonly<{ companyId: string; operationId: string; providerCallId: string; agentId: string }>,
): Promise<Readonly<{ attemptId: string; replayed: boolean }>> {
  if (!input || typeof input.companyId !== "string" || !uuid.test(input.companyId) ||
      typeof input.operationId !== "string" || !uuid.test(input.operationId) ||
      typeof input.providerCallId !== "string" || !callId.test(input.providerCallId) ||
      typeof input.agentId !== "string") return fail("VOICE_ATTEMPT_REJECTED");
  return transaction(db, async () => {
    const existing = (await db.query(
      "select id,provider_call_id,provider_account_id from private.sc011b_voice_attempts where company_id=$1 and preparation_id=$2",
      [input.companyId, input.operationId])).rows;
    if (existing.length) {
      if (existing[0].provider_call_id !== input.providerCallId ||
          existing[0].provider_account_id !== input.agentId) return fail("VOICE_ATTEMPT_CONFLICT");
      return Object.freeze({ attemptId: String(existing[0].id), replayed: true });
    }
    const inserted = (await db.query([
      "insert into private.sc011b_voice_attempts(company_id,preparation_id,candidate_id,provider_account_id,provider_call_id)",
      "select company_id,id,candidate_id,$3,$4 from private.sc010c_voice_preparations where company_id=$1 and id=$2",
      "returning id",
    ].join(" "), [input.companyId, input.operationId, input.agentId, input.providerCallId])).rows;
    if (inserted.length !== 1) return fail("VOICE_ATTEMPT_REJECTED");
    return Object.freeze({ attemptId: String(inserted[0].id), replayed: false });
  });
}

export type RetellIngestOutcome =
  "applied" | "duplicate_status" | "ignored_terminal" | "out_of_order" |
  "recorded" | "ignored" | "uncorrelated" | "duplicate_delivery";

/**
 * Authenticates and applies one Retell delivery. Throws RetellWebhookError
 * (401/400) before touching the database; a database failure throws
 * RetellLedgerError so the caller answers 5xx and Retell retries.
 */
export async function ingestRetellWebhook(
  db: SqlClient, rawBody: Uint8Array, signature: string | null,
  config: RetellWebhookConfig, nowMs: number,
): Promise<Readonly<{ outcome: RetellIngestOutcome }>> {
  const result: RetellWebhookResult = readRetellWebhook(rawBody, signature, config, nowMs);
  return transaction(db, async () => {
    const receipt = async (event: string, outcome: RetellIngestOutcome, attempt?: { company_id: string; id: string }) => {
      const written = (await db.query([
        "insert into private.sc011b_voice_webhook_receipts(receipt_id,company_id,attempt_id,event,result)",
        "values($1,$2,$3,$4,$5) on conflict (receipt_id) do nothing returning receipt_id",
      ].join(" "), [result.receiptId, attempt?.company_id ?? null, attempt?.id ?? null, event, outcome])).rows;
      return Object.freeze({ outcome: written.length ? outcome : "duplicate_delivery" as const });
    };
    if (result.kind === "ignored") return receipt("other", "ignored");
    // Serializes all deliveries for one call before the duplicate check.
    const attempts = (await db.query(
      "select * from private.sc011b_voice_attempts where provider_call_id=$1 for update",
      [result.providerCallId])).rows;
    const seen = (await db.query(
      "select 1 from private.sc011b_voice_webhook_receipts where receipt_id=$1", [result.receiptId])).rows;
    if (seen.length) return Object.freeze({ outcome: "duplicate_delivery" as const });
    if (attempts.length !== 1) return receipt(result.event, "uncorrelated");
    const row = attempts[0];
    const attempt = { company_id: String(row.company_id), id: String(row.id) };
    if (row.provider_account_id !== config.agentId) return fail("VOICE_ATTEMPT_REJECTED");
    if (result.status === null) return receipt(result.event, "recorded", attempt);
    const transition = projectVoiceProviderEvent({
      providerAccountId: row.provider_account_id, providerCallId: row.provider_call_id,
      attemptId: attempt.id, status: row.status,
    }, retellProviderEvent(result, config, attempt.id));
    if (transition.outcome === "applied") {
      await db.query([
        "update private.sc011b_voice_attempts set status=$3,",
        "outcome=coalesce($4,outcome),dnc_requested=dnc_requested or $5",
        "where company_id=$1 and id=$2",
      ].join(" "), [attempt.company_id, attempt.id, transition.state.status,
        result.outcome, result.outcome === "dnc_requested"]);
    }
    return receipt(result.event, transition.outcome, attempt);
  });
}
