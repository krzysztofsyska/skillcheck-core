/**
 * SC-011 Retell interview configuration kept in the repository
 * (config/retell/<profile>/). Offline static check only: it never contacts
 * Retell. The authoritative gate stays verifyRetellOutboundAgent, which pins
 * the uploaded revisions by digest; this check catches a broken profile
 * before anyone uploads it.
 */
import { SC012_PROHIBITED_TOPICS_INSTRUCTION } from "./interview-plan.ts";
import {
  assertCompilerOwnedVariables, RETELL_DYNAMIC_VARIABLES, RetellOutboundDraftError,
} from "./retell-outbound-draft.ts";

const requiredGlobalText = Object.freeze([
  "{{skillcheck_interview_script}}",
  "{{skillcheck_notice_version}}",
  "{{skillcheck_company_name}}",
  "{{skillcheck_position_title}}",
  "Never ask about health, medical information or special-category personal data.",
  SC012_PROHIBITED_TOPICS_INSTRUCTION,
]);
const placeholderPrefix = "__";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** Problems found in a repository flow/agent pair; empty when the profile is consistent. */
export function checkRetellInterviewConfig(flow: unknown, agent: unknown): string[] {
  const problems: string[] = [];
  if (!isObject(flow) || !isObject(agent)) return ["flow and agent must be JSON objects"];
  try { assertCompilerOwnedVariables(agent, flow); }
  catch (e) {
    if (!(e instanceof RetellOutboundDraftError)) throw e;
    problems.push("only conversation/end nodes and the variables " +
      RETELL_DYNAMIC_VARIABLES.join(", ") + " are allowed");
  }
  const globalPrompt = typeof flow.global_prompt === "string" ? flow.global_prompt : "";
  for (const text of requiredGlobalText)
    if (!globalPrompt.includes(text)) problems.push("global_prompt is missing: " + text);
  if (flow.start_speaker !== "agent") problems.push("start_speaker must be agent");

  const nodes = Array.isArray(flow.nodes) ? flow.nodes.filter(isObject) : [];
  const ids = new Set(nodes.map(n => n.id));
  if (!nodes.length || ids.size !== nodes.length) problems.push("node ids must be present and unique");
  if (!ids.has(flow.start_node_id)) problems.push("start_node_id does not name a node");
  for (const node of nodes) {
    const edges = Array.isArray(node.edges) ? node.edges.filter(isObject) : [];
    for (const edge of edges)
      if (!ids.has(edge.destination_node_id))
        problems.push("edge " + String(edge.id) + " points to an unknown node");
    if (node.type === "conversation" && !edges.length)
      problems.push("conversation node " + String(node.id) + " has no way out");
    if (node.type === "end" && (node.speak_during_execution !== true ||
        !isObject(node.instruction) || node.instruction.type !== "static_text"))
      problems.push("end node " + String(node.id) + " must say a fixed goodbye");
  }

  const engine = isObject(agent.response_engine) ? agent.response_engine : {};
  if (engine.type !== "conversation-flow") problems.push("agent must use the conversation flow engine");
  if (agent.language !== "pl-PL") problems.push("agent language must be pl-PL");
  if (agent.enable_dnc_detection !== true) problems.push("agent must enable DNC detection");
  if (agent.data_storage_setting !== "basic_attributes_only")
    problems.push("agent must store basic attributes only");
  const retention = agent.data_storage_retention_days;
  if (!Number.isInteger(retention) || (retention as number) < 1 || (retention as number) > 30)
    problems.push("agent retention must be 1-30 days");
  const maxMs = agent.max_call_duration_ms;
  if (!Number.isInteger(maxMs) || (maxMs as number) < 420000 || (maxMs as number) > 600000)
    problems.push("agent max call duration must be 420-600 s");
  return problems;
}

/** Agent create payload with the uploaded flow and the chosen voice filled in. */
export function renderRetellAgent(
  agent: Json, input: Readonly<{ flowId: string; flowVersion: number; voiceId: string }>,
): Json {
  if (!/^[A-Za-z0-9_]{12,100}$/.test(input.flowId) ||
      !Number.isInteger(input.flowVersion) || input.flowVersion < 0 ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(input.voiceId))
    throw new Error("RETELL_CONFIG_INVALID_INPUT");
  const rendered = structuredClone(agent);
  rendered.voice_id = input.voiceId;
  rendered.response_engine = {
    ...(rendered.response_engine as Json),
    conversation_flow_id: input.flowId,
    version: input.flowVersion,
  };
  if (JSON.stringify(rendered).includes(placeholderPrefix))
    throw new Error("RETELL_CONFIG_UNFILLED_PLACEHOLDER");
  return rendered;
}
