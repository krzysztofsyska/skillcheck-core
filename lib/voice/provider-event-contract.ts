/**
 * SC-011-B PREPARATION: synthetic, provider-independent event boundary.
 * parseVoiceProviderEvent only checks an untrusted object's shape. It is not a
 * signature verifier, webhook endpoint, source authenticator, or permission to call.
 * A future vendor adapter must authenticate raw bytes, signed headers, replay and
 * account binding in its own module BEFORE any database write. Do not add that
 * authentication here. Persistent deduplication, RLS and fencing belong to SC-010-C.
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
const MONTH_LENGTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function leapYear(year: number): boolean {
  return year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
}
/** Civil timestamp. Calendar fields are authoritative; Date.parse alone is not,
 * because this runtime normalizes overflow dates such as 2026-02-30. */
function time(x: unknown): x is string {
  if (typeof x !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-](\d{2}):(\d{2}))$/.exec(x);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7];
  const zone = match[8];
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const monthLength = month === 2 && leapYear(year) ? 29 : MONTH_LENGTH[month];
  if (day < 1 || day > monthLength) return false;
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const zoneHour = Number(match[9]);
    const zoneMinute = Number(match[10]);
    if (zoneHour > 23 || zoneMinute > 59) return false;
    offsetMinutes = (zone[0] === "-" ? -1 : 1) * (zoneHour * 60 + zoneMinute);
  }
  const parsed = Date.parse(x);
  if (!Number.isFinite(parsed)) return false;
  const wall = new Date(parsed + offsetMinutes * 60_000);
  const millis = fraction === undefined ? 0 : Number(fraction.padEnd(3, "0").slice(0, 3));
  return wall.getUTCFullYear() === year && wall.getUTCMonth() + 1 === month &&
    wall.getUTCDate() === day && wall.getUTCHours() === hour &&
    wall.getUTCMinutes() === minute && wall.getUTCSeconds() === second &&
    wall.getUTCMilliseconds() === millis;
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
/**
 * Parse one untrusted object into the allowlisted envelope.
 * Extra fields, including signature, source, headers and secrets, are rejected.
 * A successful parse does not authenticate a webhook or establish a provider source.
 */
export function parseVoiceProviderEvent(untrusted: unknown): VoiceProviderEvent {
  const x=snapshot(untrusted);
  if (validEvent(x)) {
    // No contact, candidate identity, prompts, transcript or arbitrary provider metadata.
    return Object.freeze({
      schemaVersion:1,providerAccountId:x.providerAccountId,providerCallId:x.providerCallId,
      attemptId:x.attemptId,eventId:x.eventId,occurredAt:x.occurredAt,status:x.status,
    });
  }
  return invalid();
}
/** Same parser. The returned envelope is still unauthenticated. */
export function normalizeVoiceProviderEvent(untrusted: unknown): VoiceProviderEvent {
  return parseVoiceProviderEvent(untrusted);
}
export function voiceProviderReceiptHash(event: unknown): string {
  const x=parseVoiceProviderEvent(event);
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
 * Pure status projection. Parses `untrustedEvent` and does not authenticate it,
 * verify a signature, deduplicate receipts, or commit a database write.
 */
export function projectVoiceProviderEvent(
  persisted: unknown, untrustedEvent: unknown,
): VoiceEventTransition {
  const copied=snapshot(persisted);
  const next=parseVoiceProviderEvent(untrustedEvent);
  if (!validState(copied)) return invalid();
  const old=copied;
  if (old.providerAccountId!==next.providerAccountId ||
      old.providerCallId!==next.providerCallId || old.attemptId!==next.attemptId) return invalid();
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
