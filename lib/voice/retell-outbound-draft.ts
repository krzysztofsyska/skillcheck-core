/**
 * SC-011-C Retell outbound compiler and server-only READ-ONLY provider gate.
 * No POST/fetch in the compiler; there is NO live dialer in this PR.
 * A future SC-010-C transaction MUST independently authorize contact,
 * validate tenant-specific current DB revisions, lock once-only dispatch,
 * enforce cost limits, and reconcile unknown results before any HTTP POST.
 */
import { createHash } from "node:crypto";
import { canonicalVoiceCallRequest, type VoiceCallRequest } from "./provider.ts";
import { isAuthenticallyReleasedInterviewPlan, type InterviewPlan } from "./interview-plan.ts";

export type RetellOutboundConfig = Readonly<{
  agentId: string;
  /** Exact Retell published tag (never "latest"/"latest_published"). */
  agentVersionTag: string;
  /** Revision to which that exact tag must resolve. */
  agentVersion: number;
  approvedAssistantVersion: string;
  noticeVersion: string;
  /** Verified Zadarma caller ID, provisioned separately. */
  fromNumberE164: string;
  maxBudgetSeconds: number;
  /** Immutable SHA-256 of reviewed exact Retell flow response; owner-approved source. */
  approvedFlowSha256: string;
  /** Independently reviewed exact complete Retell agent response digest. */
  approvedAgentSha256: string;
}>;

export type RetellOutboundDraft = Readonly<{
  endpoint: "https://api.retellai.com/v2/create-phone-call";
  method: "POST";
  payload: Readonly<{
    from_number: string;
    to_number: string;
    idempotency_key: string;
    honor_internal_dnc: true;
    override_agent_id: string;
    override_agent_version: string;
    retell_llm_dynamic_variables: Readonly<{
      skillcheck_interview_script: string;
      skillcheck_notice_version: string;
      skillcheck_language: "pl-PL";
    }>;
  }>;
  /** Not a Retell time limit: verified agent-side max must be <= this. */
  requestedMaxSeconds: number;
  /** Diagnostic proof only. DOES NOT authorize a provider POST. */
  agentRevisionSha256: string;
  verifiedAtMs: number;
  expiresAtMs: number;
  preflightOnly: true;
}>;

export class RetellOutboundDraftError extends Error {
  readonly code = "RETELL_DRAFT_REJECTED";
  constructor() { super("RETELL_DRAFT_REJECTED"); }
}
const reject = (): never => { throw new RetellOutboundDraftError(); };
const phone = /^\+[1-9]\d{7,14}$/;
// Retell accepts [A-Za-z0-9_-]; require non-PII randomly generated UUID v4 form.
const idempotencyUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256 = /^[0-9a-f]{64}$/;
const agentId = /^(?:agent_[A-Za-z0-9]{16,64}|[A-Za-z0-9]{32})$/;
const revision = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const tag = /^(?!latest$|latest_published$|v\d+$)[a-z][a-z0-9_-]{0,19}$/;
const flowId = /^[A-Za-z0-9_]{12,100}$/;
const configFields = ["agentId","agentVersionTag","agentVersion","approvedAssistantVersion",
  "noticeVersion","fromNumberE164","maxBudgetSeconds","approvedFlowSha256","approvedAgentSha256"] as const;

function isPlainExact(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (Object.getPrototypeOf(o) !== Object.prototype && Object.getPrototypeOf(o) !== null) return false;
  const actual = Reflect.ownKeys(o);
  return actual.length === keys.length &&
    actual.every(k => typeof k === "string" && keys.includes(k));
}
function validatedConfig(input: RetellOutboundConfig): RetellOutboundConfig {
  let c: RetellOutboundConfig;
  try { c = structuredClone(input); } catch { return reject(); }
  if (!isPlainExact(c, configFields) ||
    typeof c.agentId !== "string" || !agentId.test(c.agentId) ||
    typeof c.agentVersionTag !== "string" || !tag.test(c.agentVersionTag) ||
    !Number.isInteger(c.agentVersion) || c.agentVersion < 0 || c.agentVersion > 9999 ||
    typeof c.approvedAssistantVersion !== "string" || !revision.test(c.approvedAssistantVersion) ||
    typeof c.noticeVersion !== "string" || !revision.test(c.noticeVersion) ||
    typeof c.fromNumberE164 !== "string" || !phone.test(c.fromNumberE164) ||
    !Number.isInteger(c.maxBudgetSeconds) ||
    c.maxBudgetSeconds < 420 || c.maxBudgetSeconds > 600 ||
    typeof c.approvedFlowSha256 !== "string" || !sha256.test(c.approvedFlowSha256) ||
    typeof c.approvedAgentSha256 !== "string" || !sha256.test(c.approvedAgentSha256)
  ) return reject();
  return c;
}
type AgentFetch = (url: string, init: RequestInit) =>
  Promise<Pick<Response, "status" | "headers" | "body">>;
const providerJsonMaxBytes = 256 * 1024;
const policyGuardrail = "Never ask about health, medical information or special-category personal data.";

/** No response.json(): enforce a decompressed streaming byte limit first. */
async function readBoundedJson(result: Pick<Response, "headers" | "body">): Promise<Record<string, unknown>> {
  const contentLength = result.headers.get("content-length");
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > providerJsonMaxBytes)
      return reject();
  }
  if (!result.body) return reject();
  const reader = result.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  let completed = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > providerJsonMaxBytes) return reject();
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    completed = true;
  } catch { return reject(); }
  finally {
    if (!completed) { try { await reader.cancel(); } catch { /* fail closed */ } }
    reader.releaseLock();
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return reject(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return reject();
  return parsed as Record<string, unknown>;
}
const verified = new WeakSet<object>();
export type RetellVerifiedAgent = Readonly<{
  agentId: string; agentVersionTag: string; agentVersion: number;
  maxCallDurationMs: number; checkedAtMs: number; flowSha256: string;
  agentSha256: string;
}>;

/** Server side GET-only gate for exact tag/revision, privacy and flow prompt.
 * NEVER call this with user-supplied credentials, config or HTTP injection.
 * This capability is in-process only; it expires after 30 seconds. The
 * persistent worker must recheck the vendor version before live dispatch.
 */
export async function verifyRetellOutboundAgent(
  config: RetellOutboundConfig,
  key: string,
  http: AgentFetch = fetch,
): Promise<RetellVerifiedAgent> {
  const c = validatedConfig(config);
  if (typeof key !== "string" || key.length < 16 || /[\r\n]/.test(key))
    return reject();
  const init: RequestInit = {
    method: "GET", cache: "no-store", redirect: "error",
    headers: { Authorization: "Bearer " + key, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  };
  const fetchJson = async (url: string): Promise<Record<string, unknown>> => {
    let raw: unknown;
    try {
      const result = await http(url, init);
      if (result.status !== 200) return reject();
      raw = await readBoundedJson(result);
    } catch { return reject(); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return reject();
    return raw as Record<string, unknown>;
  };
  const a = await fetchJson("https://api.retellai.com/get-agent/" +
    c.agentId + "?version=" + c.agentVersionTag);
  const langs = a.language;
  if (a.agent_id !== c.agentId || a.version !== c.agentVersion ||
    a.is_published !== true ||
    !Array.isArray(a.assigned_tags) || !a.assigned_tags.includes(c.agentVersionTag) ||
    a.data_storage_setting !== "basic_attributes_only" ||
    !Number.isInteger(a.data_storage_retention_days) ||
    (a.data_storage_retention_days as number) < 1 ||
    (a.data_storage_retention_days as number) > 30 ||
    !Number.isInteger(a.max_call_duration_ms) ||
    (a.max_call_duration_ms as number) < 420000 ||
    (a.max_call_duration_ms as number) > c.maxBudgetSeconds * 1000 ||
    !(langs === "pl-PL" || (Array.isArray(langs) && langs.includes("pl-PL"))))
    return reject();
  // Pin ALL returned agent revision fields, not only the nested conversation flow.
  // This binds pre/post-session tools, webhooks, memory and future vendor fields
  // to the independently reviewed immutable configuration digest.
  let agentDigest: string;
  try { agentDigest = createHash("sha256").update(JSON.stringify(a)).digest("hex"); }
  catch { return reject(); }
  if (agentDigest !== c.approvedAgentSha256) return reject();

  const engine = a.response_engine;
  if (!engine || typeof engine !== "object" || Array.isArray(engine)) return reject();
  const e = engine as Record<string, unknown>;
  if (e.type !== "conversation-flow" ||
      typeof e.conversation_flow_id !== "string" || !flowId.test(e.conversation_flow_id) ||
      !Number.isInteger(e.version) || (e.version as number) < 0)
    return reject();
  const flow = await fetchJson("https://api.retellai.com/get-conversation-flow/" +
    e.conversation_flow_id + "?version=" + e.version);
  if (flow.conversation_flow_id !== e.conversation_flow_id ||
      flow.version !== e.version) return reject();
  // Exact-reviewed flow hash covers nested tools, custom function nodes,
  // transfer/SMS settings and all other side effects. Any drift fails closed.
  // The trusted SC-010 worker must obtain this digest from a reviewed,
  // immutable configuration record, not from a candidate request.
  let digest: string;
  try { digest = createHash("sha256").update(JSON.stringify(flow)).digest("hex"); }
  catch { return reject(); }
  if (digest !== c.approvedFlowSha256) return reject();

  // Mandatory GLOBAL instructions, not incidental text on an unreachable node.
  const globalPrompt = flow.global_prompt;
  if (typeof globalPrompt !== "string" ||
      !globalPrompt.includes("{{skillcheck_interview_script}}") ||
      !globalPrompt.includes("{{skillcheck_notice_version}}") ||
      !globalPrompt.includes(policyGuardrail))
    return reject();

  const proof: RetellVerifiedAgent = Object.freeze({
    agentId: c.agentId, agentVersionTag: c.agentVersionTag,
    agentVersion: c.agentVersion,
    maxCallDurationMs: a.max_call_duration_ms as number,
    checkedAtMs: Date.now(), flowSha256: digest, agentSha256: agentDigest,
  });
  verified.add(proof);
  return proof;
}

/** Offline ONLY. Requires a genuine in-process SC-012 released plan and
 * fresh vendor verification of the exact published tag and flow. A forged
 * "released" object, freeform questions or a spoofed proof fail closed.
 * This function never contacts anyone and does not authorize a call. */
export function compileRetellOutboundDraft(
  request: VoiceCallRequest,
  configInput: RetellOutboundConfig,
  releasedPlan: InterviewPlan,
  provider: RetellVerifiedAgent,
): RetellOutboundDraft {
  const c = validatedConfig(configInput);
  let call: VoiceCallRequest;
  try { call = canonicalVoiceCallRequest(request); } catch { return reject(); }
  if (!isAuthenticallyReleasedInterviewPlan(releasedPlan) ||
      !verified.has(provider) ||
      provider.agentId !== c.agentId ||
      provider.agentVersionTag !== c.agentVersionTag ||
      provider.agentVersion !== c.agentVersion ||
      provider.flowSha256 !== c.approvedFlowSha256 ||
      provider.agentSha256 !== c.approvedAgentSha256 ||
      !Number.isFinite(provider.checkedAtMs) ||
      Date.now() - provider.checkedAtMs < 0 ||
      Date.now() - provider.checkedAtMs > 30000 ||
      call.publishedAssistantVersion !== c.approvedAssistantVersion ||
      call.scenario.introductionVersion !== c.noticeVersion ||
      call.callTimeoutSeconds > c.maxBudgetSeconds ||
      call.callTimeoutSeconds < releasedPlan.durationTargetSeconds ||
      provider.maxCallDurationMs < releasedPlan.durationTargetSeconds * 1000 ||
      !idempotencyUuid.test(call.providerIdempotencyKey) ||
      provider.maxCallDurationMs > call.callTimeoutSeconds * 1000 ||
      call.recordingAllowed !== false ||
      releasedPlan.recordingDefault !== false ||
      releasedPlan.noticeRequired !== true ||
      releasedPlan.templateVersion !== "skillcheck-voice-plan-v1" ||
      call.scenario.questions.length !== releasedPlan.questions.length ||
      // Only this audited policy is currently supported; no arbitrary topics
      // may be interpolated into Retell's provider prompt.
      call.scenario.constraints.prohibitedTopics.length !== 1 ||
      call.scenario.constraints.prohibitedTopics[0] !== "zdrowie")
    return reject();

  for (let i = 0; i < call.scenario.questions.length; i++) {
    const q = call.scenario.questions[i];
    const approved = releasedPlan.questions[i];
    if (q.id !== approved.id || q.prompt !== approved.text ||
        q.followUps.length !== approved.followUps.length ||
        q.followUps.some((v,j) => v !== approved.followUps[j]))
      return reject();
  }
  // Deterministic, versioned templates only. No name/CV/contact data here.
  const script = call.scenario.questions.map((q, i) =>
    String(i + 1) + ". [Limit: " + releasedPlan.questions[i].maxSeconds +
      " sekund] " + q.prompt +
      (q.followUps.length ? " | Dopytania: " + q.followUps.join(" / ") : "")
  ).join("\n");
  if (script.length > 13500) return reject();

  const payload = Object.freeze({
    from_number: c.fromNumberE164,
    to_number: call.destinationE164,
    idempotency_key: call.providerIdempotencyKey,
    honor_internal_dnc: true as const,
    override_agent_id: c.agentId,
    override_agent_version: c.agentVersionTag,
    retell_llm_dynamic_variables: Object.freeze({
      skillcheck_interview_script: script,
      skillcheck_notice_version: c.noticeVersion,
      skillcheck_language: "pl-PL" as const,
    }),
  });
  return Object.freeze({
    endpoint: "https://api.retellai.com/v2/create-phone-call" as const,
    method: "POST" as const, payload,
    requestedMaxSeconds: call.callTimeoutSeconds,
    agentRevisionSha256: provider.agentSha256,
    verifiedAtMs: provider.checkedAtMs,
    expiresAtMs: provider.checkedAtMs + 30000,
    preflightOnly: true as const,
  });
}
