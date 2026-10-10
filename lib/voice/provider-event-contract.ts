/**
 * SC-011-B PREPARATION: synthetic, provider-independent event boundary.
 * This is NOT a signature verifier, webhook endpoint or authorization to call.
 * A future selected vendor adapter MUST authenticate raw bytes, signed headers,
 * timestamp/replay/account BEFORE passing any data to this normalizer.
 * Persistent event deduplication, RLS and fencing belong to SC-010-C.
 */
import { createHash } from "node:crypto";

export type VoiceProviderEventStatus =
  "accepted" | "ringing" | "connected" | "completed" | "failed" | "cancelled";
export type VoiceAttemptStatus = VoiceProviderEventStatus | "unknown";
export type VoiceProviderEvent = Readonly<{
  schemaVersion: 1;
  providerAccountId: string;
  providerCallId: string;
  attemptId: string;
  eventId: string;
  occurredAt: string;
  status: VoiceProviderEventStatus;
}>;
export type VoiceAttemptProjection = Readonly<{
  providerAccountId: string;
  providerCallId: string;
  attemptId: string;
  status: VoiceAttemptStatus;
}>;
export type VoiceEventTransition = Readonly<{
  state: VoiceAttemptProjection;
  outcome: "applied" | "duplicate_status" | "ignored_terminal" | "out_of_order";
}>;

export class VoiceEventContractError extends Error {
  readonly code = "VOICE_EVENT_INVALID";
  constructor() { super("VOICE_EVENT_INVALID"); }
}
const invalid = (): never => { throw new VoiceEventContractError(); };
const opaque = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const statuses: readonly VoiceProviderEventStatus[] =
  ["accepted","ringing","connected","completed","failed","cancelled"];
const attemptStatuses: readonly VoiceAttemptStatus[] = [...statuses,"unknown"];
function exactFields(x: unknown, names: readonly string[]): x is Record<string,unknown> {
  return x !== null && typeof x==="object" && !Array.isArray(x) &&
    Object.getPrototypeOf(x)===Object.prototype &&
    Reflect.ownKeys(x).length===names.length &&
    names.every(n=>Object.prototype.hasOwnProperty.call(x,n));
}
function snapshot<T>(x:T):T {
  try {
    const copy=structuredClone(x);
    if (JSON.stringify(copy).length>4096) invalid();
    return copy;
  } catch { return invalid(); }
}
function time(x:unknown): x is string {
  return typeof x==="string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(x) &&
    Number.isFinite(Date.parse(x));
}
function validEvent(v:unknown):v is VoiceProviderEvent {
  if (!exactFields(v,["schemaVersion","providerAccountId","providerCallId",
      "attemptId","eventId","occurredAt","status"])) return false;
  return v.schemaVersion===1 && typeof v.providerAccountId==="string" &&
    opaque.test(v.providerAccountId) && typeof v.providerCallId==="string" &&
    opaque.test(v.providerCallId) && typeof v.attemptId==="string" &&
    uuid.test(v.attemptId) && typeof v.eventId==="string" && opaque.test(v.eventId) &&
    time(v.occurredAt) && typeof v.status==="string" &&
    statuses.includes(v.status as VoiceProviderEventStatus);
}
export function normalizeVoiceProviderEvent(untrusted: VoiceProviderEvent): VoiceProviderEvent {
  const x=snapshot(untrusted);
  if (!validEvent(x)) invalid();
  // No contact, candidate identity, prompts, transcript or arbitrary provider metadata.
  return Object.freeze({
    schemaVersion:1,providerAccountId:x.providerAccountId,providerCallId:x.providerCallId,
    attemptId:x.attemptId,eventId:x.eventId,occurredAt:x.occurredAt,status:x.status,
  });
}
export function voiceProviderReceiptHash(event: VoiceProviderEvent): string {
  const x=normalizeVoiceProviderEvent(event);
  return createHash("sha256").update(JSON.stringify(x)).digest("hex");
}
function validState(v:unknown): v is VoiceAttemptProjection {
  if (!exactFields(v,["providerAccountId","providerCallId","attemptId","status"])) return false;
  return typeof v.providerAccountId==="string" && opaque.test(v.providerAccountId) &&
    typeof v.providerCallId==="string" && opaque.test(v.providerCallId) &&
    typeof v.attemptId==="string" && uuid.test(v.attemptId) &&
    typeof v.status==="string" && attemptStatuses.includes(v.status as VoiceAttemptStatus);
}
/**
 * Pure state projection for an ALREADY-authenticated, DB-deduplicated event.
 * Never use this function alone to authenticate callbacks or commit DB writes.
 */
export function projectVoiceProviderEvent(
  persisted: VoiceAttemptProjection, verifiedByExternalAdapter: VoiceProviderEvent,
): VoiceEventTransition {
  const old=snapshot(persisted);
  const next=normalizeVoiceProviderEvent(verifiedByExternalAdapter);
  if (!validState(old) || old.providerAccountId!==next.providerAccountId ||
      old.providerCallId!==next.providerCallId || old.attemptId!==next.attemptId) invalid();
  if (old.status===next.status)
    return {state:Object.freeze(old),outcome:"duplicate_status"};
  if (["completed","failed","cancelled"].includes(old.status))
    return {state:Object.freeze(old),outcome:"ignored_terminal"};
  const rank:Readonly<Record<VoiceAttemptStatus,number>>={
    unknown:0,accepted:1,ringing:2,connected:3,completed:4,failed:4,cancelled:4,
  };
  if (next.status!=="failed" && next.status!=="cancelled" &&
      rank[next.status]<rank[old.status])
    return {state:Object.freeze(old),outcome:"out_of_order"};
  return {state:Object.freeze({...old,status:next.status}),outcome:"applied"};
}
