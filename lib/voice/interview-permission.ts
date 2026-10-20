/**
 * SC-010-C isolated interview-permission boundary. No route, provider or dispatch.
 * A B2 verification_invitation receipt is only the bound contact-control evidence.
 * This separately signed proof attests receipt of the precise interview notice
 * and explicit permission for a voice_interview with recording disabled.
 * Context and issuer keys MUST come from trusted server configuration/current DB
 * state. The executor uses only the dormant voice_permission_verifier capability.
 */
import { createPublicKey, verify } from "node:crypto";

export const VOICE_INTERVIEW_PERMISSION_DOMAIN =
  "SC010C_VOICE_INTERVIEW_PERMISSION_AND_NOTICE_RECEIVED_V1\0";
export const VOICE_INTERVIEW_PERMISSION_PROOF_TYPE =
  "voice_interview_permission_and_notice_received_v1" as const;
const SQL = "select private.ingest_voice_interview_permission_receipt($1::jsonb) as receipt_id";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_AGE_MS = 15 * 60 * 1000;
const revisionFields = [
  "contact_version", "global_permission_revision", "scoped_permission_revision", "preference_revision",
] as const;
const contextFields = [
  "company_id", "candidate_id", "recruitment_id", "application_id", "contact_receipt_id",
  "channel", "purpose", "recording_allowed", ...revisionFields, "notice_version", "policy_sha256",
] as const;
const receiptFields = [
  ...contextFields, "schema_version", "proof_type", "receipt_id", "issuer_id", "key_id", "nonce",
  "notice_received_at", "interview_permission_granted_at", "issued_at", "expires_at",
] as const;

export type VoiceInterviewPermissionContext = Readonly<{
  company_id: string; candidate_id: string; recruitment_id: string; application_id: string;
  contact_receipt_id: string; contact_version: number;
  global_permission_revision: number; scoped_permission_revision: number; preference_revision: number;
  channel: "voice"; purpose: "voice_interview"; recording_allowed: false;
  notice_version: string; policy_sha256: string;
}>;
export type SignedVoiceInterviewPermissionReceipt = VoiceInterviewPermissionContext & Readonly<{
  schema_version: 1; proof_type: typeof VOICE_INTERVIEW_PERMISSION_PROOF_TYPE;
  receipt_id: string; issuer_id: string; key_id: string; nonce: string;
  notice_received_at: string; interview_permission_granted_at: string;
  issued_at: string; expires_at: string;
}>;
export type VoiceInterviewPermissionConfig = Readonly<{
  issuers: readonly Readonly<{
    company_id: string; issuer_id: string; key_id: string; publicKeyPem: string;
  }>[];
}>;
export type VoiceInterviewPermissionExecutor = (sql: string, parameters: readonly [string]) => Promise<unknown>;
export class VoiceInterviewPermissionError extends Error {
  readonly code: "VOICE_INTERVIEW_PERMISSION_REJECTED" | "VOICE_INTERVIEW_PERMISSION_NOT_ACCEPTED";
  constructor(code: VoiceInterviewPermissionError["code"]) { super(code); this.code = code; }
}
function reject(): never { throw new VoiceInterviewPermissionError("VOICE_INTERVIEW_PERMISSION_REJECTED"); }
function exactObject(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === fields.length && actual.every(key => {
    if (typeof key !== "string" || !fields.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value");
  });
}
function base64url(value: unknown, maximum: number): Buffer {
  if (typeof value !== "string" || value.length > maximum || !/^[A-Za-z0-9_-]+$/.test(value)) reject();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) reject();
  return decoded;
}
function instant(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) reject();
  const result = Date.parse(value);
  if (!Number.isFinite(result) || new Date(result).toISOString() !== value) reject();
  return result;
}
function contextValid(value: Record<string, unknown>): void {
  for (const name of ["company_id", "candidate_id", "recruitment_id", "application_id", "contact_receipt_id"])
    if (typeof value[name] !== "string" || !UUID.test(value[name])) reject();
  for (const name of revisionFields) {
    const revision = value[name];
    if (!Number.isSafeInteger(revision) || Number(revision) < (name === "contact_version" ? 1 : 0) ||
        Number(revision) >= Number.MAX_SAFE_INTEGER) reject();
  }
  if (value.channel !== "voice" || value.purpose !== "voice_interview" || value.recording_allowed !== false ||
      typeof value.notice_version !== "string" || !ID.test(value.notice_version) ||
      typeof value.policy_sha256 !== "string" || !SHA256.test(value.policy_sha256)) reject();
}

/**
 * No I/O until the exact schema, explicit event chronology, bound server context
 * and pinned Ed25519 signature pass. SQL independently rechecks expiry, replay,
 * current contact/revisions and erasure under candidate/registry locks.
 * Returns only the executor's opaque result; errors never echo signed input.
 */
export async function ingestVoiceInterviewPermission(input: {
  attestation: Readonly<{ payload: string; signature: string }>;
  context: VoiceInterviewPermissionContext; config: VoiceInterviewPermissionConfig;
  execute: VoiceInterviewPermissionExecutor; now?: Date;
}): Promise<unknown> {
  let receiptJson: string;
  try {
    if (typeof window !== "undefined" || !input || typeof input.execute !== "function" ||
        !exactObject(input.context, contextFields) || !exactObject(input.config, ["issuers"]) ||
        !Array.isArray(input.config.issuers) || input.config.issuers.length < 1 || input.config.issuers.length > 100 ||
        !exactObject(input.attestation, ["payload", "signature"])) reject();
    contextValid(input.context);
    const bytes = base64url(input.attestation.payload, 16000);
    const signature = base64url(input.attestation.signature, 100);
    if (signature.length !== 64) reject();
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!exactObject(parsed, receiptFields) || JSON.stringify(parsed) !== bytes.toString("utf8")) reject();
    contextValid(parsed);
    for (const name of contextFields) if (parsed[name] !== input.context[name]) reject();
    for (const name of ["receipt_id", "nonce"])
      if (typeof parsed[name] !== "string" || !UUID.test(parsed[name])) reject();
    for (const name of ["issuer_id", "key_id"])
      if (typeof parsed[name] !== "string" || !ID.test(parsed[name])) reject();
    if (parsed.schema_version !== 1 || parsed.proof_type !== VOICE_INTERVIEW_PERMISSION_PROOF_TYPE) reject();
    const matching = input.config.issuers.filter(issuer => {
      if (!exactObject(issuer, ["company_id", "issuer_id", "key_id", "publicKeyPem"]) ||
          typeof issuer.company_id !== "string" || !UUID.test(issuer.company_id) ||
          typeof issuer.issuer_id !== "string" || !ID.test(issuer.issuer_id) ||
          typeof issuer.key_id !== "string" || !ID.test(issuer.key_id) ||
          typeof issuer.publicKeyPem !== "string" || issuer.publicKeyPem.length > 4096) reject();
      return issuer.company_id === parsed.company_id && issuer.issuer_id === parsed.issuer_id && issuer.key_id === parsed.key_id;
    });
    if (matching.length !== 1) reject();
    const key = createPublicKey(matching[0].publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519" ||
        !verify(null, Buffer.concat([Buffer.from(VOICE_INTERVIEW_PERMISSION_DOMAIN), bytes]), key, signature)) reject();
    const now = (input.now ?? new Date()).getTime();
    const noticed = instant(parsed.notice_received_at), granted = instant(parsed.interview_permission_granted_at);
    const issued = instant(parsed.issued_at), expiry = instant(parsed.expires_at);
    if (!Number.isFinite(now) || noticed > granted || granted > issued || issued > now || expiry <= now ||
        expiry <= issued || expiry - issued > MAX_AGE_MS || issued - noticed > MAX_AGE_MS) reject();
    receiptJson = JSON.stringify(parsed);
  } catch { return reject(); }
  try { return await input.execute(SQL, [receiptJson]); }
  catch { throw new VoiceInterviewPermissionError("VOICE_INTERVIEW_PERMISSION_NOT_ACCEPTED"); }
}
