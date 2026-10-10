/** SC-011-A: offline typed transport. No real network adapter or dispatch permission. */
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
const safeText = (x: unknown, max: number): x is string =>
  typeof x === "string" && x.trim().length > 0 && x.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(x);
export function validateVoiceCallRequest(value: VoiceCallRequest): void {
  if (!value || typeof value !== "object" ||
      !opaque.test(value.externalCorrelationId) || !opaque.test(value.providerIdempotencyKey) ||
      !opaque.test(value.publishedAssistantVersion) || !e164.test(value.destinationE164) ||
      typeof value.recordingAllowed !== "boolean" || !Number.isInteger(value.callTimeoutSeconds) ||
      value.callTimeoutSeconds < 60 || value.callTimeoutSeconds > 600) throw new VoiceProviderValidationError();
  const s = value.scenario;
  if (!s || s.schemaVersion !== 1 || s.language !== "pl-PL" ||
      !opaque.test(s.introductionVersion) || s.constraints?.maxSeconds !== 600 ||
      !Array.isArray(s.constraints?.prohibitedTopics) || s.constraints.prohibitedTopics.length > 20 ||
      !s.constraints.prohibitedTopics.every(t => safeText(t, 100)) ||
      !Array.isArray(s.questions) || s.questions.length < 1 || s.questions.length > 8) throw new VoiceProviderValidationError();
  const ids = new Set<string>();
  for (const q of s.questions) {
    if (!q || !opaque.test(q.id) || ids.has(q.id) || !safeText(q.prompt, 1000) ||
        !Array.isArray(q.followUps) || q.followUps.length > 2 ||
        !q.followUps.every(t => safeText(t, 500))) throw new VoiceProviderValidationError();
    ids.add(q.id);
  }
}
