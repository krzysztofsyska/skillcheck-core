/**
 * SC-011-B5: once-only Retell create-phone-call worker on a dedicated trusted
 * server connection (db/isolated/sc011b5-voice-dispatch-worker.sql).
 * The HTTP transport is always injected: there is no default fetch, so nothing
 * here can place a call until a reviewed runtime supplies one.
 *
 * Retell deduplicates a repeated idempotency_key for up to one hour
 * (https://docs.retellai.com/api-references/create-phone-call). A claim may
 * therefore resend the same draft inside that window. After it, an unresolved
 * claim becomes `unknown`: no redial, the reservation stays until reconciled.
 */
import { createHash } from "node:crypto";
import type { SqlClient } from "./trusted-source-verifier.ts";
import { isCompiledRetellOutboundDraft, type RetellOutboundDraft } from "./retell-outbound-draft.ts";
import { recordRetellDispatch } from "./retell-dispatch-ledger.ts";

export type RetellDispatchTransport = (url: string, init: RequestInit) =>
  Promise<Pick<Response, "status" | "headers" | "body">>;
export type RetellDispatchResult = Readonly<
  | { state: "accepted"; attemptId: string }
  | { state: "rejected" }
  | { state: "retry_later" }
  | { state: "unknown" }
>;
export class RetellDispatchError extends Error {
  readonly code: "VOICE_DISPATCH_REJECTED" | "VOICE_DISPATCH_STALE_DRAFT" | "VOICE_DISPATCH_UNAVAILABLE";
  constructor(code: RetellDispatchError["code"]) { super(code); this.code = code; }
}
const fail = (code: RetellDispatchError["code"]): never => { throw new RetellDispatchError(code); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const callIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
/** Stays inside Retell's one-hour deduplication window with a safety margin. */
export const RETELL_RESEND_WINDOW_MS = 55 * 60 * 1000;
const maxAttempts = 10;
const maxResponseBytes = 64 * 1024;
// Retell will refuse the identical request again: release the reservation.
const definitive: Readonly<Record<number, "invalid_request" | "unprocessable">> =
  Object.freeze({ 400: "invalid_request", 422: "unprocessable" });

async function tx<T>(db: SqlClient, work: () => Promise<T>): Promise<T> {
  await db.query("begin isolation level read committed");
  try {
    await db.query("set local lock_timeout='2s'");
    const result = await work();
    await db.query("commit");
    return result;
  } catch (e) {
    try { await db.query("rollback"); } catch { /* report the original error */ }
    throw e;
  }
}
async function settle(db: SqlClient, companyId: string, operationId: string,
  state: "accepted" | "rejected" | "unknown", rejection: string | null): Promise<void> {
  await tx(db, () => db.query(
    "update private.sc011b_voice_dispatches set state=$3,rejection=$4 where company_id=$1 and preparation_id=$2 and state='sending'",
    [companyId, operationId, state, rejection]));
}
async function readCallId(result: Pick<Response, "headers" | "body">): Promise<string | null> {
  const declared = result.headers.get("content-length");
  if (declared !== null && (!/^\d{1,9}$/.test(declared) || Number(declared) > maxResponseBytes)) return null;
  if (!result.body) return null;
  const reader = result.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "", size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) { await reader.cancel(); return null; }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch { return null; }
  finally { reader.releaseLock(); }
  try {
    const parsed: unknown = JSON.parse(text);
    const id = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).call_id : undefined;
    return typeof id === "string" && callIdPattern.test(id) ? id : null;
  } catch { return null; }
}

/**
 * Sends one prepared draft at most once per Retell deduplication window.
 * `draft` must be the freshly compiled draft of `operationId` (its 30-second
 * agent proof still valid). The destination number is never persisted.
 */
export async function dispatchRetellCall(
  db: SqlClient,
  input: Readonly<{ companyId: string; operationId: string; draft: RetellOutboundDraft; apiKey: string }>,
  http: RetellDispatchTransport,
  nowMs: number,
): Promise<RetellDispatchResult> {
  const { companyId, operationId, draft, apiKey } = input ?? ({} as typeof input);
  if (typeof companyId !== "string" || !uuid.test(companyId) ||
      typeof operationId !== "string" || !uuid.test(operationId) ||
      typeof apiKey !== "string" || apiKey.length < 16 || /[\r\n]/.test(apiKey) ||
      typeof http !== "function" || !isCompiledRetellOutboundDraft(draft) || draft.preflightOnly !== true ||
      draft.endpoint !== "https://api.retellai.com/v2/create-phone-call" || draft.method !== "POST")
    return fail("VOICE_DISPATCH_REJECTED");
  const body = JSON.stringify(draft.payload);
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  // The key digest must match the preparation (DB guard); the payload digest
  // pins every resend to the identical request.
  const keyDigest = digest(draft.payload.idempotency_key), payloadDigest = digest(body);
  if (!Number.isFinite(nowMs) || nowMs > draft.expiresAtMs || nowMs < draft.verifiedAtMs)
    return fail("VOICE_DISPATCH_STALE_DRAFT");

  // COMMIT runs the SC-010-C currentness check queued by the claim guard; a
  // revoked permission, expired contact or changed plan aborts before any POST.
  let claim: { state: string };
  try { claim = await tx(db, async () => {
    const fresh = (await db.query([
      "insert into private.sc011b_voice_dispatches(company_id,preparation_id,provider_key_digest,payload_sha256)",
      "values($1,$2,$3,$4) on conflict (company_id,preparation_id) do nothing returning 1",
    ].join(" "), [companyId, operationId, keyDigest, payloadDigest])).rows.length === 1;
    const rows = (await db.query([
      "select state,attempts,provider_key_digest,payload_sha256,",
      "extract(epoch from (clock_timestamp()-started_at))*1000 as age_ms",
      "from private.sc011b_voice_dispatches where company_id=$1 and preparation_id=$2 for update",
    ].join(" "), [companyId, operationId])).rows;
    if (rows.length !== 1) return fail("VOICE_DISPATCH_UNAVAILABLE");
    const row = rows[0];
    if (row.provider_key_digest !== keyDigest || row.payload_sha256 !== payloadDigest)
      return fail("VOICE_DISPATCH_REJECTED");
    if (row.state !== "sending") return { state: String(row.state) };
    // A call id recorded before a crash settles the claim: never resend it.
    const recorded = (await db.query(
      "select 1 from private.sc011b_voice_attempts where company_id=$1 and preparation_id=$2",
      [companyId, operationId])).rows.length === 1;
    if (recorded) {
      await db.query(
        "update private.sc011b_voice_dispatches set state='accepted' where company_id=$1 and preparation_id=$2",
        [companyId, operationId]);
      return { state: "accepted" };
    }
    if (!fresh) {
      if (Number(row.age_ms) > RETELL_RESEND_WINDOW_MS || Number(row.attempts) >= maxAttempts) {
        await db.query(
          "update private.sc011b_voice_dispatches set state='unknown' where company_id=$1 and preparation_id=$2",
          [companyId, operationId]);
        return { state: "unknown" };
      }
      await db.query(
        "update private.sc011b_voice_dispatches set attempts=attempts+1 where company_id=$1 and preparation_id=$2",
        [companyId, operationId]);
    }
    return { state: "send" };
  }); } catch (e) {
    if (e instanceof RetellDispatchError) throw e;
    // 42501: the guard refused a draft that does not belong to this preparation.
    const code = e && typeof e === "object" && "code" in e ? String(e.code) : "";
    return fail(code === "42501" ? "VOICE_DISPATCH_REJECTED" : "VOICE_DISPATCH_UNAVAILABLE");
  }
  if (claim.state === "accepted") {
    const attempt = (await db.query(
      "select id from private.sc011b_voice_attempts where company_id=$1 and preparation_id=$2",
      [companyId, operationId])).rows[0];
    return attempt ? Object.freeze({ state: "accepted", attemptId: String(attempt.id) })
      : fail("VOICE_DISPATCH_UNAVAILABLE");
  }
  if (claim.state === "rejected" || claim.state === "unknown")
    return Object.freeze({ state: claim.state });

  let response: Pick<Response, "status" | "headers" | "body">;
  try {
    response = await http(draft.endpoint, {
      method: "POST", redirect: "error", cache: "no-store",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body,
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return Object.freeze({ state: "retry_later" });
  }
  if (response.status === 201 || response.status === 200) {
    const providerCallId = await readCallId(response);
    // Accepted without a readable id: resend later with the same key.
    if (!providerCallId) return Object.freeze({ state: "retry_later" });
    const { attemptId } = await recordRetellDispatch(db, {
      companyId, operationId, providerCallId, agentId: draft.payload.override_agent_id,
    });
    await settle(db, companyId, operationId, "accepted", null);
    return Object.freeze({ state: "accepted", attemptId });
  }
  try { await response.body?.cancel(); } catch { /* body is never read */ }
  const rejection = definitive[response.status];
  if (rejection) {
    await settle(db, companyId, operationId, "rejected", rejection);
    return Object.freeze({ state: "rejected" });
  }
  // 401/402 (configuration or billing), 429 and 5xx keep the reservation.
  return Object.freeze({ state: "retry_later" });
}
