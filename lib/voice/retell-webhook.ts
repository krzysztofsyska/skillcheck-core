/**
 * SC-011-B1: Retell webhook authentication and minimization. Offline module:
 * no HTTP route, database write, secret loading or provider call lives here.
 *
 * Retell signs `X-Retell-Signature: v=<unix ms>,d=<hex>` where d is
 * HMAC-SHA256(raw body + v) keyed with the webhook-enabled API key
 * (https://docs.retellai.com/features/secure-webhook). Retell retries a
 * delivery up to 3 times, so the same event may arrive more than once.
 *
 * The caller (a future route + SC-010-C ledger) must pass the exact raw bytes,
 * load the key server-side, deduplicate by `receiptId`, and correlate
 * `providerCallId` with the call id recorded at dispatch before any write.
 * Retell keeps no transcript under `basic_attributes_only`: this webhook is the
 * only copy, so only speaker role and utterance text survive minimization.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  parseVoiceProviderEvent, type VoiceProviderEvent, type VoiceProviderEventStatus,
} from "./provider-event-contract.ts";

export type RetellWebhookConfig = Readonly<{
  /** Webhook-enabled Retell API key, server-side only. */
  webhookKey: string;
  /** The single SkillCheck agent and pinned published version. */
  agentId: string;
  agentVersion: number;
}>;
export type RetellCallOutcome =
  "completed" | "dnc_requested" | "no_answer" | "busy" | "voicemail" | "provider_error" | "other";
export type RetellUtterance = Readonly<{ speaker: "agent" | "candidate"; text: string }>;
export type RetellWebhookResult =
  | Readonly<{ kind: "ignored"; receiptId: string }>
  | Readonly<{
      kind: "call";
      event: "call_started" | "call_ended" | "call_analyzed";
      receiptId: string;
      providerCallId: string;
      occurredAt: string;
      /** Status for the SC-011 projection; null for analysis-only events. */
      status: VoiceProviderEventStatus | null;
      outcome: RetellCallOutcome | null;
      /** Only on call_ended; null when the payload carries no transcript. */
      transcript: readonly RetellUtterance[] | null;
    }>;

export class RetellWebhookError extends Error {
  readonly code: "RETELL_WEBHOOK_UNAUTHENTICATED" | "RETELL_WEBHOOK_REJECTED";
  constructor(code: RetellWebhookError["code"]) { super(code); this.code = code; }
}
const unauthenticated = (): never => { throw new RetellWebhookError("RETELL_WEBHOOK_UNAUTHENTICATED"); };
const rejected = (): never => { throw new RetellWebhookError("RETELL_WEBHOOK_REJECTED"); };

export const RETELL_WEBHOOK_MAX_BYTES = 2 * 1024 * 1024;
const signatureWindowMs = 5 * 60 * 1000;
const signatureHeader = /^v=(\d{1,16}),d=([0-9a-f]{64})$/;
const agentIdPattern = /^(?:agent_[A-Za-z0-9]{16,64}|[A-Za-z0-9]{32})$/;
const callIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const handledEvents = new Set(["call_started", "call_ended", "call_analyzed"]);
// https://docs.retellai.com/api-references/get-call (disconnection_reason)
const completedReasons = new Set(["user_hangup", "agent_hangup", "max_duration_reached", "inactivity"]);
const outcomeByReason: Readonly<Record<string, RetellCallOutcome>> = Object.freeze({
  user_requested_dnc: "dnc_requested",
  dial_no_answer: "no_answer", user_declined: "no_answer",
  dial_busy: "busy",
  voicemail_reached: "voicemail",
  dial_failed: "provider_error", invalid_destination: "provider_error",
  telephony_provider_permission_denied: "provider_error",
  telephony_provider_unavailable: "provider_error", sip_routing_error: "provider_error",
  concurrency_limit_reached: "provider_error", no_valid_payment: "provider_error",
});
const maxUtterances = 400;
const maxUtteranceChars = 4000;
const maxTranscriptChars = 60000;

/** Authenticates the exact raw bytes. Throws RETELL_WEBHOOK_UNAUTHENTICATED. */
export function verifyRetellWebhookSignature(
  rawBody: Uint8Array, header: string | null, key: string, nowMs: number,
): void {
  if (!(rawBody instanceof Uint8Array) || rawBody.byteLength > RETELL_WEBHOOK_MAX_BYTES ||
      typeof key !== "string" || key.length < 16 || /[\r\n]/.test(key) ||
      typeof header !== "string" || header.length > 128 || !Number.isFinite(nowMs))
    return unauthenticated();
  const match = signatureHeader.exec(header);
  if (!match) return unauthenticated();
  const sentAt = Number(match[1]);
  if (!Number.isSafeInteger(sentAt) || Math.abs(nowMs - sentAt) > signatureWindowMs)
    return unauthenticated();
  const expected = createHmac("sha256", key).update(rawBody).update(match[1], "utf8").digest();
  if (!timingSafeEqual(expected, Buffer.from(match[2], "hex"))) return unauthenticated();
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const iso = (ms: unknown): string | undefined =>
  Number.isSafeInteger(ms) && (ms as number) > 0 ? new Date(ms as number).toISOString() : undefined;

function minimizeTranscript(value: unknown): readonly RetellUtterance[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > maxUtterances) return rejected();
  let total = 0;
  const utterances: RetellUtterance[] = [];
  for (const item of value) {
    if (!isObject(item) || (item.role !== "agent" && item.role !== "user") ||
        typeof item.content !== "string") return rejected();
    // Words, timings, tool calls and any other provider field are dropped.
    const text = item.content.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/ {2,}/g, " ").trim();
    if (text.length > maxUtteranceChars) return rejected();
    total += text.length;
    if (total > maxTranscriptChars) return rejected();
    if (text) utterances.push(Object.freeze({ speaker: item.role === "agent" ? "agent" : "candidate", text }));
  }
  return Object.freeze(utterances);
}

/**
 * Verifies the signature, then reduces an authentic SkillCheck call event to the
 * minimal allowlisted result. Events Retell may add later are acknowledged as
 * `ignored`; anything not bound to the configured outbound agent is rejected.
 */
export function readRetellWebhook(
  rawBody: Uint8Array, header: string | null, config: RetellWebhookConfig, nowMs: number,
): RetellWebhookResult {
  if (!isObject(config) || typeof config.agentId !== "string" || !agentIdPattern.test(config.agentId) ||
      !Number.isInteger(config.agentVersion) || config.agentVersion < 0) return rejected();
  verifyRetellWebhookSignature(rawBody, header, config.webhookKey, nowMs);
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)); }
  catch { return rejected(); }
  if (!isObject(payload) || typeof payload.event !== "string" || payload.event.length > 64) return rejected();
  const call = payload.call;
  if (!isObject(call) || typeof call.call_id !== "string" || !callIdPattern.test(call.call_id))
    return rejected();
  const receiptId = createHash("sha256")
    .update(JSON.stringify(["RETELL_WEBHOOK_V1", payload.event, call.call_id])).digest("hex");
  if (!handledEvents.has(payload.event)) return Object.freeze({ kind: "ignored", receiptId });
  if (call.agent_id !== config.agentId || call.agent_version !== config.agentVersion ||
      call.call_type !== "phone_call" || call.direction !== "outbound") return rejected();

  const event = payload.event as "call_started" | "call_ended" | "call_analyzed";
  let status: VoiceProviderEventStatus | null = null;
  let outcome: RetellCallOutcome | null = null;
  let occurredAt: string | undefined;
  let transcript: readonly RetellUtterance[] | null = null;
  if (event === "call_started") {
    status = "connected";
    occurredAt = iso(call.start_timestamp);
  } else {
    const reason = call.disconnection_reason;
    if (typeof reason !== "string") return rejected();
    outcome = completedReasons.has(reason) ? "completed" : outcomeByReason[reason] ??
      (reason.startsWith("error_") ? "provider_error" : "other");
    occurredAt = iso(call.end_timestamp);
    if (event === "call_ended") {
      status = outcome === "completed" || outcome === "dnc_requested" ? "completed" : "failed";
      transcript = minimizeTranscript(call.transcript_object);
    }
  }
  if (!occurredAt) return rejected();
  return Object.freeze({
    kind: "call", event, receiptId, providerCallId: call.call_id, occurredAt, status, outcome, transcript,
  });
}

/** SC-011 projection input for a status-bearing event correlated to a dispatch attempt. */
export function retellProviderEvent(
  result: RetellWebhookResult, config: Pick<RetellWebhookConfig, "agentId">, attemptId: string,
): VoiceProviderEvent {
  if (result.kind !== "call" || result.status === null) return rejected();
  // Retell sends no account id; the configured agent is the bound provider account.
  return parseVoiceProviderEvent({
    schemaVersion: 1, providerAccountId: config.agentId, providerCallId: result.providerCallId,
    attemptId, eventId: result.event + ":" + result.providerCallId,
    occurredAt: result.occurredAt, status: result.status,
  });
}
