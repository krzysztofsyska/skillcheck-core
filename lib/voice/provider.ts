/** SC-011-A: synthetic-only voice transport contract. Never grants dispatch. */
export type VoiceScenario = Readonly<{
  schemaVersion: 1; language: "pl-PL"; introductionVersion: string;
  questions: readonly Readonly<{ id: string; prompt: string; followUps: readonly string[] }>[];
  constraints: Readonly<{ maxSeconds: 600; prohibitedTopics: readonly string[] }>;
}>;
export type VoiceCallRequest = Readonly<{
  externalCorrelationId: string; destinationE164: string; publishedAssistantVersion: string;
  scenario: VoiceScenario; recordingAllowed: boolean; callTimeoutSeconds: number;
  providerIdempotencyKey: string;
}>;
export type VoiceCallAcceptance = Readonly<{ acceptance: "accepted"; providerCallId: string }>;
export type VoiceCallLookup =
  | Readonly<{ state: "found"; providerCallId: string; status: "accepted" | "cancelled" }>
  | Readonly<{ state: "not_found" | "unsupported" }>;
export interface VoiceProvider {
  initiateOutbound(request: VoiceCallRequest): Promise<VoiceCallAcceptance>;
  getCallByIdempotencyKey(key: string): Promise<VoiceCallLookup>;
  cancelCall(providerCallId: string): Promise<void>;
}
export class VoiceProviderUncertainError extends Error {
  readonly code = "VOICE_PROVIDER_RESULT_UNKNOWN";
  constructor() { super("VOICE_PROVIDER_RESULT_UNKNOWN"); }
}
export class VoiceProviderValidationError extends Error {
  readonly code = "VOICE_PROVIDER_INVALID_REQUEST";
  constructor() { super("VOICE_PROVIDER_INVALID_REQUEST"); }
}
const opaque = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const e164 = /^\+[1-9]\d{7,14}$/;
const validId = (x: unknown): x is string => typeof x === "string" && opaque.test(x);
const validPhone = (x: unknown): x is string => typeof x === "string" && e164.test(x);
const safeText = (x: unknown, max: number): x is string =>
  typeof x === "string" && x.trim().length > 0 && x.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(x);
const reject = (): never => { throw new VoiceProviderValidationError(); };

/** Fail closed on extra keys including candidate/CV data and avoid JS string coercion. */
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const actual = Reflect.ownKeys(obj);
  return actual.length === keys.length &&
    actual.every(k => typeof k === "string" && keys.includes(k));
}
/** Array.every silently skips holes. Check every index as own enumerable data. */
function denseArray(value: unknown, min: number, max: number): value is unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max ||
      Object.keys(value).length !== value.length) return false;
  for (let i = 0; i < value.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(value, i)) return false;
  }
  return true;
}

export function validateVoiceCallRequest(value: VoiceCallRequest): void {
  if (!exactKeys(value, ["externalCorrelationId", "destinationE164", "publishedAssistantVersion",
    "scenario", "recordingAllowed", "callTimeoutSeconds", "providerIdempotencyKey"]) ||
    !validId(value.externalCorrelationId) || !validId(value.providerIdempotencyKey) ||
    !validId(value.publishedAssistantVersion) || !validPhone(value.destinationE164) ||
    typeof value.recordingAllowed !== "boolean" || !Number.isInteger(value.callTimeoutSeconds) ||
    value.callTimeoutSeconds < 60 || value.callTimeoutSeconds > 600) reject();

  const s = value.scenario;
  if (!exactKeys(s, ["schemaVersion", "language", "introductionVersion", "questions", "constraints"]) ||
    s.schemaVersion !== 1 || s.language !== "pl-PL" || !validId(s.introductionVersion) ||
    !exactKeys(s.constraints, ["maxSeconds", "prohibitedTopics"]) ||
    s.constraints.maxSeconds !== 600 ||
    !denseArray(s.constraints.prohibitedTopics, 0, 20) ||
    !s.constraints.prohibitedTopics.every((t: unknown) => safeText(t, 100)) ||
    !denseArray(s.questions, 1, 8)) reject();

  const ids = new Set<string>();
  for (const q of s.questions) {
    if (!exactKeys(q, ["id", "prompt", "followUps"]) ||
        !validId(q.id) || ids.has(q.id) || !safeText(q.prompt, 1000) ||
        !denseArray(q.followUps, 0, 2) ||
        !q.followUps.every((t: unknown) => safeText(t, 500))) reject();
    ids.add(q.id);
  }
}

/** The only safe boundary for serialization and fingerprints.
 * Reconstruct a fixed-order allowlist so insertion order never changes identity.
 */
export function canonicalVoiceCallRequest(value: VoiceCallRequest): VoiceCallRequest {
  validateVoiceCallRequest(value);
  return {
    externalCorrelationId: value.externalCorrelationId,
    destinationE164: value.destinationE164,
    publishedAssistantVersion: value.publishedAssistantVersion,
    scenario: {
      schemaVersion: 1,
      language: "pl-PL",
      introductionVersion: value.scenario.introductionVersion,
      questions: value.scenario.questions.map(q => ({
        id: q.id, prompt: q.prompt, followUps: [...q.followUps],
      })),
      constraints: {
        maxSeconds: 600,
        prohibitedTopics: [...value.scenario.constraints.prohibitedTopics],
      },
    },
    recordingAllowed: value.recordingAllowed,
    callTimeoutSeconds: value.callTimeoutSeconds,
    providerIdempotencyKey: value.providerIdempotencyKey,
  };
}
