/**
 * SC-011 Retell: PURE, offline request construction only. No HTTP call,
 * credentials, webhook, telephony or billing side effects.
 *
 * Agent id, agent version, assistant version, prohibited-topic policy,
 * duration and metadata retention come from the sealed capability below.
 * A caller cannot substitute them. The provider idempotency key is a fresh
 * random UUID, never the caller's key. The scenario must be the exact object
 * returned by voiceScenarioFromApprovedPlan for the same company and
 * application; those identifiers are checked and are not copied into Retell.
 *
 * This file must never be called from a browser.
 *
 * API fields verified against https://docs.retellai.com/api-references/create-phone-call
 * (idempotency_key, honor_internal_dnc, override_agent_id, agent_override
 * data_storage_setting, data_storage_retention_days, enable_dnc_detection,
 * max_call_duration_ms).
 */
import { randomUUID } from "node:crypto";
import {
  prohibitedTopicsAreCanonical, scenarioQuestionsAreControlled,
  SC012_INTRODUCTION_VERSION, SC012_PROHIBITED_TOPICS,
} from "./interview-plan.ts";
import { scenarioApplicationBinding } from "./mvp-package-gate.ts";
import { canonicalVoiceCallRequest, type VoiceCallRequest, type VoiceScenario } from "./provider.ts";

/**
 * Reviewed offline pin. Replacing the agent requires a code change, not a
 * caller argument. The id is a synthetic opaque value, not a live Retell agent.
 * metadataRetentionDays matches the candidate data-class horizon already used
 * by erasure preview (30). It is an offline ceiling, not a final DPA decision.
 */
export const TRUSTED_RETELL_CAPABILITY = Object.freeze({
  agentId: "skillcheckOfflineAgent000000000001",
  agentVersion: 1,
  publishedAssistantVersion: "assistant-v001",
  metadataRetentionDays: 30 as const,
  maxCallDurationMs: 600_000 as const,
});
export type RetellFromNumber = Readonly<{ fromNumber: string }>;
export type RetellApplicationBinding = Readonly<{ companyId: string; applicationId: string }>;
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
      data_storage_retention_days: 30;
      enable_dnc_detection: true;
      max_call_duration_ms: 600_000;
    }>;
  }>;
}>;
const phone = /^\+[1-9]\d{7,14}$/;
/** Retell treats override_agent_id as an opaque string, including ids without an agent_ prefix. */
const agentIdPattern = /^[A-Za-z0-9_-]{8,128}$/;
/** Create Phone Call accepts only this alphabet. Generated keys use it; caller keys are not forwarded. */
const retellIdempotency = /^[A-Za-z0-9_-]{5,255}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const routeKeys = Object.freeze(["fromNumber"]);
const bindingKeys = Object.freeze(["companyId", "applicationId"]);
const invalid = (): never => { throw new Error("RETELL_OFFLINE_ROUTING_INVALID"); };
const untrusted = (): never => { throw new Error("RETELL_UNTRUSTED_SCENARIO"); };

export function isRetellAgentId(value: string): boolean {
  return agentIdPattern.test(value);
}
if (!isRetellAgentId(TRUSTED_RETELL_CAPABILITY.agentId) ||
    !Number.isSafeInteger(TRUSTED_RETELL_CAPABILITY.agentVersion) ||
    TRUSTED_RETELL_CAPABILITY.metadataRetentionDays < 1 ||
    TRUSTED_RETELL_CAPABILITY.metadataRetentionDays > 730 ||
    TRUSTED_RETELL_CAPABILITY.maxCallDurationMs !== 600_000)
  throw new Error("RETELL_OFFLINE_ROUTING_INVALID");

function sameControlledScenario(branded: VoiceScenario, snapshot: VoiceScenario): boolean {
  if (branded.introductionVersion !== snapshot.introductionVersion ||
      branded.questions.length !== snapshot.questions.length) return false;
  if (branded.constraints.prohibitedTopics.length !== snapshot.constraints.prohibitedTopics.length)
    return false;
  if (!branded.constraints.prohibitedTopics.every((topic, index) =>
    topic === snapshot.constraints.prohibitedTopics[index])) return false;
  return branded.questions.every((question, index) => {
    const other = snapshot.questions[index];
    return !!other && question.id === other.id && question.prompt === other.prompt &&
      question.followUps.length === other.followUps.length &&
      question.followUps.every((followUp, followIndex) => followUp === other.followUps[followIndex]);
  });
}
function freshRetryKey(): string {
  const key = randomUUID();
  if (!retellIdempotency.test(key)) invalid();
  return key;
}

/**
 * Builds a dispatch-shaped DTO. Does not call Retell. fromNumber is the only
 * caller route field; agent, policy, duration and retention are sealed.
 */
export function makeRetellOutboundDraft(
  request: VoiceCallRequest,
  route: RetellFromNumber,
  application: RetellApplicationBinding,
): RetellOutboundDraft {
  const brandedScenario = request?.scenario;
  const bound = scenarioApplicationBinding(brandedScenario);
  let safeRoute: RetellFromNumber;
  let safeApplication: RetellApplicationBinding;
  try {
    safeRoute = structuredClone(route);
    safeApplication = structuredClone(application);
  } catch {
    throw new Error("RETELL_OFFLINE_ROUTING_INVALID");
  }
  if (!safeRoute || typeof safeRoute !== "object" || Array.isArray(safeRoute) ||
      Object.getPrototypeOf(safeRoute) !== Object.prototype ||
      Reflect.ownKeys(safeRoute).length !== routeKeys.length ||
      !routeKeys.every(key => Reflect.ownKeys(safeRoute).includes(key)) ||
      typeof safeRoute.fromNumber !== "string" || !phone.test(safeRoute.fromNumber)) invalid();
  if (!safeApplication || typeof safeApplication !== "object" || Array.isArray(safeApplication) ||
      Object.getPrototypeOf(safeApplication) !== Object.prototype ||
      Reflect.ownKeys(safeApplication).length !== bindingKeys.length ||
      !bindingKeys.every(key => Reflect.ownKeys(safeApplication).includes(key)) ||
      typeof safeApplication.companyId !== "string" || !uuid.test(safeApplication.companyId) ||
      typeof safeApplication.applicationId !== "string" || !uuid.test(safeApplication.applicationId))
    untrusted();

  const canonical = canonicalVoiceCallRequest(request);
  if (!bound ||
      bound.companyId !== safeApplication.companyId ||
      bound.applicationId !== safeApplication.applicationId ||
      canonical.externalCorrelationId !== bound.applicationId ||
      !brandedScenario || !sameControlledScenario(brandedScenario, canonical.scenario))
    untrusted();
  if (canonical.publishedAssistantVersion !== TRUSTED_RETELL_CAPABILITY.publishedAssistantVersion ||
      canonical.callTimeoutSeconds !== 600 ||
      canonical.recordingAllowed) invalid();
  if (canonical.scenario.introductionVersion !== SC012_INTRODUCTION_VERSION ||
      !prohibitedTopicsAreCanonical(canonical.scenario.constraints.prohibitedTopics) ||
      !scenarioQuestionsAreControlled(canonical.scenario.questions)) untrusted();

  const retryKey = freshRetryKey();
  const variables: Record<string, string> = Object.create(null);
  variables.sc_notice_version = SC012_INTRODUCTION_VERSION;
  variables.sc_language = "pl-PL";
  variables.sc_max_seconds = "600";
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
    idempotency_key: retryKey,
    override_agent_id: TRUSTED_RETELL_CAPABILITY.agentId,
    override_agent_version: TRUSTED_RETELL_CAPABILITY.agentVersion,
    honor_internal_dnc: true,
    retell_llm_dynamic_variables: Object.freeze(variables),
    agent_override: Object.freeze({
      agent: Object.freeze({
        data_storage_setting: "basic_attributes_only" as const,
        data_storage_retention_days: TRUSTED_RETELL_CAPABILITY.metadataRetentionDays,
        enable_dnc_detection: true as const,
        max_call_duration_ms: TRUSTED_RETELL_CAPABILITY.maxCallDurationMs,
      }),
    }),
  });
}
