/**
 * SC-011 Retell: PURE, offline request construction only. No HTTP call,
 * credentials, webhook, telephony or billing side effects.
 *
 * Future trusted worker must verify the signed DB lease, consent, credits,
 * candidate erasure state and fresh SC-012 plan BEFORE invoking Retell.
 * Retell agent must use the pinned prompt placeholders below; this file
 * must never be called from a browser.
 *
 * API fields verified against https://docs.retellai.com/api-references/create-phone-call
 */
import { canonicalVoiceCallRequest, type VoiceCallRequest } from "./provider.ts";

export type RetellRouting = Readonly<{
  fromNumber: string; agentId: string; agentVersion: number;
}>;
export type RetellOutboundDraft = Readonly<{
  from_number: string;
  to_number: string;
  idempotency_key: string;
  override_agent_id: string;
  override_agent_version: number;
  retell_llm_dynamic_variables: Readonly<Record<string,string>>;
}>;
const phone = /^\+[1-9]\d{7,14}$/;
const agent = /^agent_[A-Za-z0-9]{8,100}$/;

/**
 * Takes SC-011 validated E.164 and approved controlled-question scenario only.
 * The real Retell conversation flow/LLM has to reference the exact
 * sc_question_N and sc_followup_N_M variables; an agent that does not is
 * not suitable for activation. Never include raw CV, recruiter notes or PII.
 */
export function makeRetellOutboundDraft(
  request: VoiceCallRequest, route: RetellRouting,
): RetellOutboundDraft {
  const canonical = canonicalVoiceCallRequest(request);
  const safeRoute = structuredClone(route);
  if (!safeRoute || typeof safeRoute !== "object" || Array.isArray(safeRoute) ||
      Reflect.ownKeys(safeRoute).length !== 3 ||
      !("fromNumber" in safeRoute) || !("agentId" in safeRoute) ||
      !("agentVersion" in safeRoute) ||
      typeof safeRoute.fromNumber !== "string" || !phone.test(safeRoute.fromNumber) ||
      typeof safeRoute.agentId !== "string" || !agent.test(safeRoute.agentId) ||
      !Number.isSafeInteger(safeRoute.agentVersion) ||
      safeRoute.agentVersion < 0 || safeRoute.agentVersion > 1_000_000 ||
      canonical.recordingAllowed)
    throw new Error("RETELL_OFFLINE_ROUTING_INVALID");

  const variables: Record<string,string> = Object.create(null);
  variables.sc_notice_version = canonical.scenario.introductionVersion;
  variables.sc_language = "pl-PL";
  variables.sc_max_seconds = String(canonical.callTimeoutSeconds);
  variables.sc_question_count = String(canonical.scenario.questions.length);
  canonical.scenario.questions.forEach((q,index) => {
    const i = index + 1;
    variables["sc_question_"+i] = q.prompt;
    for(let j=0;j<q.followUps.length;j++)
      variables["sc_followup_"+i+"_"+(j+1)] = q.followUps[j];
  });
  return Object.freeze({
    from_number: safeRoute.fromNumber,
    to_number: canonical.destinationE164,
    idempotency_key: canonical.providerIdempotencyKey,
    override_agent_id: safeRoute.agentId,
    override_agent_version: safeRoute.agentVersion,
    retell_llm_dynamic_variables: Object.freeze(variables),
  });
}
