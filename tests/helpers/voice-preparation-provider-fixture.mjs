import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {verifyRetellOutboundAgent} from "../../lib/voice/retell-outbound-draft.ts";

const flowId = "conversation_flow_abcdefghijklmnop";
const flow = {
  conversation_flow_id: flowId, version: 3,
  global_prompt: "Read {{skillcheck_notice_version}} and ask {{skillcheck_interview_script}}. " +
    "Never ask about health, medical information or special-category personal data. " +
    "Nie zadawaj pytań ani dopytań dotyczących następujących tematów: stan zdrowia; religia; poglądy polityczne; życie prywatne.",
};
const agent = {
  agent_id: "agent_1234567890abcdef", version: 2, is_published: true,
  assigned_tags: ["skillcheck_mvp"], enable_dnc_detection: true,
  data_storage_setting: "basic_attributes_only", data_storage_retention_days: 14,
  max_call_duration_ms: 480000, language: "pl-PL",
  response_engine: {type: "conversation-flow", conversation_flow_id: flowId, version: 3},
};
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function syntheticRetellProof(change = {}) {
  const retell = {
    agentId: agent.agent_id, agentVersionTag: "skillcheck_mvp", agentVersion: 2,
    approvedAssistantVersion: "skillcheck-agent-approved-v2", noticeVersion: "notice-pl-202610",
    fromNumberE164: "+48581234567", maxBudgetSeconds: 480,
    approvedFlowSha256: hash(flow), approvedAgentSha256: hash(agent), ...change,
  };
  const calls = [];
  const verifiedAgent = await verifyRetellOutboundAgent(retell, "synthetic-only-never-a-real-api-key", async (url, init) => {
    assert.equal(init.method, "GET"); assert.equal(init.body, undefined);
    calls.push({url, method: init.method});
    let body;
    if (url === "https://api.retellai.com/get-agent/" + agent.agent_id + "?version=skillcheck_mvp") body = agent;
    else if (url === "https://api.retellai.com/get-conversation-flow/" + flowId + "?version=3") body = flow;
    else throw new Error("Unexpected synthetic endpoint");
    return new Response(JSON.stringify(body), {status: 200, headers: {"content-type": "application/json"}});
  });
  return {retell, verifiedAgent, calls};
}
