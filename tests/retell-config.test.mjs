import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { behaviorAreas } from "../lib/position-fields.ts";
import {
  SC012_INTRODUCTION_VERSION, buildInterviewPlan, reviewInterviewPlan, releaseInterviewPlan,
  releasedApplicationBinding,
} from "../lib/voice/interview-plan.ts";
import { voiceScenarioFromApprovedPlan } from "../lib/voice/mvp-package-gate.ts";
import { compileRetellOutboundDraft, verifyRetellOutboundAgent } from "../lib/voice/retell-outbound-draft.ts";
import { checkRetellInterviewConfig, renderRetellAgent } from "../lib/voice/retell-config-profile.ts";

const dir = "config/retell/skillcheck-interview-v1/";
const flowFile = () => JSON.parse(readFileSync(dir + "conversation-flow.json", "utf8"));
const agentFile = () => JSON.parse(readFileSync(dir + "agent.json", "utf8"));
const uuid = n => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const flowId = "conversation_flow_abcdefghijklmnop";
const agentId = "agent_1234567890abcdef";
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const render = (text, values) => text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g,
  (_, key) => values[key.trim()] ?? "UNRESOLVED");

test("repository Retell profile passes the static profile check", () => {
  assert.deepEqual(checkRetellInterviewConfig(flowFile(), agentFile()), []);
});

test("profile check names missing guardrails, broken edges and unsafe settings", () => {
  const flow = flowFile(), agent = agentFile();
  flow.global_prompt = flow.global_prompt.replace("życie prywatne", "hobby");
  flow.nodes[0].edges[0].destination_node_id = "missing";
  flow.nodes.push({ id: "tool", type: "function", tool_id: "x" });
  agent.data_storage_setting = "everything";
  agent.enable_dnc_detection = false;
  const problems = checkRetellInterviewConfig(flow, agent).join("\n");
  for (const expected of ["global_prompt is missing", "unknown node", "conversation/end nodes",
    "basic attributes", "DNC"]) assert.match(problems, new RegExp(expected));
});

test("agent render fills the uploaded flow and voice, and refuses bad input", () => {
  const agent = renderRetellAgent(agentFile(), { flowId, flowVersion: 4, voiceId: "retell-Pl_Voice" });
  assert.deepEqual(agent.response_engine, { type: "conversation-flow", conversation_flow_id: flowId, version: 4 });
  assert.equal(agent.voice_id, "retell-Pl_Voice");
  assert.ok(!JSON.stringify(agent).includes("__"));
  for (const input of [{ flowId: "x", flowVersion: 1, voiceId: "v" },
    { flowId, flowVersion: -1, voiceId: "v" }, { flowId, flowVersion: 1, voiceId: "{{x}}" }])
    assert.throws(() => renderRetellAgent(agentFile(), input));
});

test("uploaded repository profile verifies, compiles and speaks the company and position", async () => {
  // Synthetic GET responses: the repository payloads plus fields Retell adds.
  const flow = { ...flowFile(), conversation_flow_id: flowId, version: 4 };
  const agent = { ...renderRetellAgent(agentFile(), { flowId, flowVersion: 4, voiceId: "retell-Pl" }),
    agent_id: agentId, version: 2, is_published: true, assigned_tags: ["skillcheck_mvp"] };
  const config = {
    agentId, agentVersionTag: "skillcheck_mvp", agentVersion: 2,
    approvedAssistantVersion: "skillcheck-agent-approved-v2", noticeVersion: SC012_INTRODUCTION_VERSION,
    fromNumberE164: "+48581234567", maxBudgetSeconds: 600,
    approvedFlowSha256: digest(flow), approvedAgentSha256: digest(agent),
  };
  const reply = data => new Response(JSON.stringify(data), { status: 200 });
  const proof = await verifyRetellOutboundAgent(config, "synthetic-test-api-key-123456", async url =>
    url.includes("/get-agent/") ? reply(agent) : reply(flow));

  const generated = buildInterviewPlan({
    companyId: uuid(1), applicationId: uuid(11),
    positionRevision: "position-v001", analysisRevision: "analysis-v001", reviewRevision: "review-v001",
    screeningReviewed: true, screeningCurrent: true,
    position: {
      title: "Specjalista ds. sprzedaży B2B", tasks: ["Obsługa klientów"], kpis: ["Sprzedaż miesięczna"],
      requiredCompetencies: ["Negocjacje"],
      requiredBehaviors: behaviorAreas.map(([, label], i) => label + ": " + (i < 2 ? "Krytyczny" : "Standardowy")),
    },
    gaps: [],
  });
  const reviewed = reviewInterviewPlan(generated, { expectedRevision: 1,
    expectedSourceFingerprint: generated.sourceFingerprint, reviewerId: uuid(91), reviewedAt: "2026-10-29T07:00:00.000Z" });
  const plan = releaseInterviewPlan(reviewed, { expectedRevision: 2,
    expectedSourceFingerprint: reviewed.sourceFingerprint, releasedBy: uuid(92), releasedAt: "2026-10-29T07:01:00.000Z" });
  const binding = releasedApplicationBinding(plan);
  const draft = compileRetellOutboundDraft({
    externalCorrelationId: binding.applicationId, destinationE164: "+48123456789",
    publishedAssistantVersion: config.approvedAssistantVersion, recordingAllowed: false,
    callTimeoutSeconds: 600, providerIdempotencyKey: uuid(501), scenario: voiceScenarioFromApprovedPlan(plan),
  }, config, plan, proof, {
    companyId: binding.companyId, applicationId: binding.applicationId, sourceFingerprint: plan.sourceFingerprint,
    destinationE164: "+48123456789", contactApproved: true, noticeDelivered: true,
  }, { companyId: binding.companyId, companyName: "Hurtownia „Północ” Sp. z o.o." });

  const vars = draft.payload.retell_llm_dynamic_variables;
  const spoken = Object.fromEntries(flow.nodes.filter(n => n.instruction?.type === "static_text")
    .map(n => [n.id, render(n.instruction.text, vars)]));
  assert.match(spoken.greeting, /firmy Hurtownia Północ Sp\. z o\.o\./);
  // The position is named only after the person confirms the application.
  assert.doesNotMatch(spoken.greeting, /Specjalista/);
  assert.match(spoken.notice, /stanowiska Specjalista ds\. sprzedaży B2B/);
  assert.match(spoken.notice, /programem komputerowym/);
  const prompt = render(flow.global_prompt, vars);
  for (const question of plan.questions) assert.ok(prompt.includes(question.text));
  for (const text of [prompt, ...Object.values(spoken), ...agent.boosted_keywords.map(k => render(k, vars))])
    assert.doesNotMatch(text, /UNRESOLVED|[{}]/);
});
