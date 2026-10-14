/**
 * SC-011 Retell: PURE, offline request construction only. No HTTP call,
 * credentials, webhook, telephony or billing side effects.
 *
 * Future trusted worker must verify the signed DB lease, consent, credits,
 * candidate erasure state and fresh SC-012 plan BEFORE invoking Retell.
 * This mapper refuses arbitrary prompt text: questions, follow-ups and the
 * prohibited-topic list must match the closed SC-012 templates. The pinned
 * agent must reference sc_question_N, sc_followup_N_M and sc_prohibited_topics.
 * Retell has no custom-topic guardrail enum for health, religion, politics or
 * private life, so a draft is produced only when the trusted route attests that
 * the immutable agent version enforces that exact list.
 * This file must never be called from a browser.
 *
 * API fields verified against https://docs.retellai.com/api-references/create-phone-call
 * (idempotency_key, honor_internal_dnc, override_agent_id, agent_override
 * data_storage_setting, enable_dnc_detection, max_call_duration_ms).
 */
import {
  prohibitedTopicsAreCanonical, scenarioQuestionsAreControlled,
  SC012_INTRODUCTION_VERSION, SC012_PROHIBITED_TOPICS,
} from "./interview-plan.ts";
import { canonicalVoiceCallRequest, type VoiceCallRequest } from "./provider.ts";

export type RetellRouting = Readonly<{
  fromNumber: string;
  agentId: string;
  agentVersion: number;
  /** SkillCheck assistant version bound to this Retell agent id and version. */
  publishedAssistantVersion: string;
  /**
   * Exact prohibited-topic policy the immutable pinned agent version enforces.
   * Must equal the SC-012 canonical list or the draft is not dispatchable.
   */
  enforcedProhibitedTopics: readonly string[];
}>;
export type RetellOutboundDraft = Readonly<{
  from_number: string;
  to_number: string;
  idempotency_key: string;
  override_agent_id: string;
  override_agent_version: number;
  honor_internal_dnc: true;
  retell_llm_dynamic_variables: Readonly<Record<string, string>>;
  agent_override: Readonly<{
    agent: Readonly<{
      data_storage_setting: "basic_attributes_only";
      enable_dnc_detection: true;
      max_call_duration_ms: number;
    }>;
  }>;
}>;
const phone = /^\+[1-9]\d{7,14}$/;
/** Retell treats override_agent_id as an opaque string, including ids without an agent_ prefix. */
const agent = /^[A-Za-z0-9_-]{8,128}$/;
/** Create Phone Call rejects `.` and `:` even though SC-011 allows them. */
const retellIdempotency = /^[A-Za-z0-9_-]{5,255}$/;
const routeKeys = Object.freeze([
  "fromNumber", "agentId", "agentVersion", "publishedAssistantVersion", "enforcedProhibitedTopics",
]);
const invalid = (): never => { throw new Error("RETELL_OFFLINE_ROUTING_INVALID"); };
const untrusted = (): never => { throw new Error("RETELL_UNTRUSTED_SCENARIO"); };

/**
 * Takes an SC-011 request whose scenario text is exactly the SC-012 controlled
 * templates. The route must bind publishedAssistantVersion to the Retell agent
 * version and attest the canonical prohibited-topic policy. Never include raw
 * CV, recruiter notes or candidate PII.
 */
export function makeRetellOutboundDraft(
  request: VoiceCallRequest, route: RetellRouting,
): RetellOutboundDraft {
  const canonical = canonicalVoiceCallRequest(request);
  let safeRoute: RetellRouting;
  try {
    safeRoute = structuredClone(route);
  } catch {
    throw new Error("RETELL_OFFLINE_ROUTING_INVALID");
  }
  if (!safeRoute || typeof safeRoute !== "object" || Array.isArray(safeRoute) ||
      Object.getPrototypeOf(safeRoute) !== Object.prototype ||
      Reflect.ownKeys(safeRoute).length !== routeKeys.length ||
      !routeKeys.every(key => Reflect.ownKeys(safeRoute).includes(key)) ||
      typeof safeRoute.fromNumber !== "string" || !phone.test(safeRoute.fromNumber) ||
      typeof safeRoute.agentId !== "string" || !agent.test(safeRoute.agentId) ||
      !Number.isSafeInteger(safeRoute.agentVersion) ||
      safeRoute.agentVersion < 0 || safeRoute.agentVersion > 1_000_000 ||
      typeof safeRoute.publishedAssistantVersion !== "string" ||
      safeRoute.publishedAssistantVersion !== canonical.publishedAssistantVersion ||
      !prohibitedTopicsAreCanonical(safeRoute.enforcedProhibitedTopics) ||
      !retellIdempotency.test(canonical.providerIdempotencyKey) ||
      canonical.recordingAllowed) invalid();

  if (canonical.scenario.introductionVersion !== SC012_INTRODUCTION_VERSION ||
      !prohibitedTopicsAreCanonical(canonical.scenario.constraints.prohibitedTopics) ||
      !scenarioQuestionsAreControlled(canonical.scenario.questions)) untrusted();

  const variables: Record<string, string> = Object.create(null);
  variables.sc_notice_version = SC012_INTRODUCTION_VERSION;
  variables.sc_language = "pl-PL";
  variables.sc_max_seconds = String(canonical.callTimeoutSeconds);
  variables.sc_question_count = String(canonical.scenario.questions.length);
  variables.sc_prohibited_topics = SC012_PROHIBITED_TOPICS.join(" | ");
  canonical.scenario.questions.forEach((q, index) => {
    const i = index + 1;
    variables["sc_question_" + i] = q.prompt;
    variables["sc_followup_" + i + "_1"] = q.followUps[0];
  });
  return Object.freeze({
    from_number: safeRoute.fromNumber,
    to_number: canonical.destinationE164,
    idempotency_key: canonical.providerIdempotencyKey,
    override_agent_id: safeRoute.agentId,
    override_agent_version: safeRoute.agentVersion,
    honor_internal_dnc: true,
    retell_llm_dynamic_variables: Object.freeze(variables),
    agent_override: Object.freeze({
      agent: Object.freeze({
        data_storage_setting: "basic_attributes_only" as const,
        enable_dnc_detection: true as const,
        max_call_duration_ms: canonical.callTimeoutSeconds * 1000,
      }),
    }),
  });
}
