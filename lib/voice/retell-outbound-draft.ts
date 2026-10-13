/**
 * SC-011-C: offline-only Retell outbound request compiler.
 *
 * DOES NOT dispatch: no fetch, no Retell SDK, no credentials and no I/O.
 * The future SC-010-C worker must independently prove, under DB transaction:
 * tenant ownership, lawful contact basis, candidate contact authorization,
 * approved and current SC-012 plan revision, once-only dispatch, spend caps,
 * caller ID ownership and a published compatible agent before transmitting.
 */
import { canonicalVoiceCallRequest, VoiceProviderValidationError, type VoiceCallRequest } from "./provider.ts";

export type RetellOutboundConfig = Readonly<{
  agentId: string;
  /** Pinned published Retell agent version, never implicitly "latest". */
  agentVersion: number;
  /** Version label approved by SkillCheck. */
  approvedAssistantVersion: string;
  /** Verified Zadarma number imported into Retell. Never taken from a user form. */
  fromNumberE164: string;
  /** Maximum duration approved by trusted business logic; Retell agent must
   * separately be configured with the same or lower provider-side cap. */
  maxBudgetSeconds: number;
}>;

export type RetellOutboundDraft = Readonly<{
  endpoint: "https://api.retellai.com/v2/create-phone-call";
  method: "POST";
  payload: Readonly<{
    from_number: string;
    to_number: string;
    override_agent_id: string;
    override_agent_version: number;
    retell_llm_dynamic_variables: Readonly<{
      skillcheck_interview_script: string;
      skillcheck_notice_version: string;
      skillcheck_language: "pl-PL";
    }>;
    metadata: Readonly<{
      skillcheck_correlation_id: string;
      skillcheck_idempotency_key: string;
    }>;
  }>;
  /** Advisory only. There is no time limit in this Retell request body. */
  requestedMaxSeconds: number;
}>;

export class RetellOutboundDraftError extends Error {
  readonly code = "RETELL_DRAFT_REJECTED";
  constructor() { super("RETELL_DRAFT_REJECTED"); }
}

const phone = /^\+[1-9]\d{7,14}$/;
const agent = /^agent_[A-Za-z0-9]{16,64}$/;
const revision = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const reject = (): never => { throw new RetellOutboundDraftError(); };

function exactConfig(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  if (Object.getPrototypeOf(obj) !== Object.prototype && Object.getPrototypeOf(obj) !== null) return false;
  const keys = Reflect.ownKeys(obj);
  return keys.length === 5 &&
    keys.every(k => typeof k === "string" &&
      ["agentId", "agentVersion", "approvedAssistantVersion", "fromNumberE164", "maxBudgetSeconds"].includes(k));
}

/**
 * IMPORTANT: Produces a request draft, not approval to place a call.
 * Question text may ONLY come from the reviewed, frozen SC-012 plan via a
 * trusted mapper; passing user-entered text directly is prohibited.
 *
 * Retell agent's published prompt must include {{skillcheck_interview_script}}
 * and {{skillcheck_notice_version}} before any live call is attempted.
 */
export function compileRetellOutboundDraft(
  request: VoiceCallRequest,
  providerConfig: RetellOutboundConfig,
): RetellOutboundDraft {
  let config: RetellOutboundConfig;
  try { config = structuredClone(providerConfig); } catch { return reject(); }
  if (!exactConfig(config) ||
    typeof config.agentId !== "string" || !agent.test(config.agentId) ||
    typeof config.fromNumberE164 !== "string" || !phone.test(config.fromNumberE164) ||
    typeof config.approvedAssistantVersion !== "string" || !revision.test(config.approvedAssistantVersion) ||
    !Number.isInteger(config.agentVersion) || config.agentVersion < 1 || config.agentVersion > 9999 ||
    !Number.isInteger(config.maxBudgetSeconds) ||
    config.maxBudgetSeconds < 60 || config.maxBudgetSeconds > 600
  ) return reject();

  let call: VoiceCallRequest;
  try { call = canonicalVoiceCallRequest(request); }
  catch (error) {
    if (error instanceof VoiceProviderValidationError) return reject();
    return reject();
  }
  if (call.publishedAssistantVersion !== config.approvedAssistantVersion ||
    call.callTimeoutSeconds > config.maxBudgetSeconds ||
    call.recordingAllowed !== false) return reject();

  // No names, phones, CV text, notes, or evaluation scores in prompt variables.
  // The strict SC-011-A request validator already caps counts and text sizes.
  const script = call.scenario.questions.map((q, index) =>
    String(index + 1) + ". " + q.prompt +
      (q.followUps.length ? " | Dopytania: " + q.followUps.join(" / ") : "")
  ).join("\n");
  if (script.length > 13500) return reject();

  const result: RetellOutboundDraft = {
    endpoint: "https://api.retellai.com/v2/create-phone-call",
    method: "POST",
    payload: {
      from_number: config.fromNumberE164,
      to_number: call.destinationE164,
      override_agent_id: config.agentId,
      override_agent_version: config.agentVersion,
      retell_llm_dynamic_variables: {
        skillcheck_interview_script: script,
        skillcheck_notice_version: call.scenario.introductionVersion,
        skillcheck_language: "pl-PL",
      },
      metadata: {
        skillcheck_correlation_id: call.externalCorrelationId,
        skillcheck_idempotency_key: call.providerIdempotencyKey,
      },
    },
    requestedMaxSeconds: call.callTimeoutSeconds,
  };
  return Object.freeze({
    ...result,
    payload: Object.freeze({
      ...result.payload,
      retell_llm_dynamic_variables: Object.freeze(result.payload.retell_llm_dynamic_variables),
      metadata: Object.freeze(result.payload.metadata),
    }),
  });
}
