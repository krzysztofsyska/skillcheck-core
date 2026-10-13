import test from "node:test";
import assert from "node:assert/strict";
import { compileRetellOutboundDraft, RetellOutboundDraftError } from "../lib/voice/retell-outbound-draft.ts";

const config = () => ({
  agentId: "agent_1234567890abcdef",
  agentVersion: 2,
  approvedAssistantVersion: "skillcheck-agent-approved-v2",
  fromNumberE164: "+48581234567",
  maxBudgetSeconds: 480,
});
const request = () => ({
  externalCorrelationId: "correlation-synthetic-001",
  destinationE164: "+48123456789",
  publishedAssistantVersion: "skillcheck-agent-approved-v2",
  recordingAllowed: false,
  callTimeoutSeconds: 480,
  providerIdempotencyKey: "idempotency-synthetic-001",
  scenario: {
    schemaVersion: 1,
    language: "pl-PL",
    introductionVersion: "notice-approved-v001",
    questions: [
      { id: "question-leadership", prompt: "Opisz trudna sytuacje zawodowa.", followUps: ["Jakie byly rezultaty?"] },
      { id: "question-decision", prompt: "Jak podejmowales decyzje?", followUps: [] },
    ],
    constraints: { maxSeconds: 600, prohibitedTopics: ["zdrowie"] },
  },
});

const denied = (r, c) => assert.throws(
  () => compileRetellOutboundDraft(r, c),
  e => e instanceof RetellOutboundDraftError && e.code === "RETELL_DRAFT_REJECTED",
);

test("SC-011-C compiles a finite, pinned, minimal Retell payload but NEVER dispatches", () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = () => { throw Error("Network attempt forbidden"); };
  try {
    const result = compileRetellOutboundDraft(request(), config());
    assert.equal(result.endpoint, "https://api.retellai.com/v2/create-phone-call");
    assert.equal(result.method, "POST");
    assert.equal(result.payload.from_number, "+48581234567");
    assert.equal(result.payload.to_number, "+48123456789");
    assert.equal(result.payload.override_agent_version, 2);
    assert.equal(result.payload.override_agent_id, "agent_1234567890abcdef");
    assert.equal(result.requestedMaxSeconds, 480);
    assert.match(result.payload.retell_llm_dynamic_variables.skillcheck_interview_script, /Opisz trudna sytuacje/);
    assert.equal(result.payload.metadata.skillcheck_correlation_id, "correlation-synthetic-001");
    assert.ok(!JSON.stringify(result).includes("zdrowie"));
    assert.ok(!Object.keys(result.payload).includes("recording_allowed"));
    assert.ok(Object.isFrozen(result.payload));
    assert.ok(Object.isFrozen(result.payload.retell_llm_dynamic_variables));
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("SC-011-C fails closed without owned caller, pinned version and approved recording policy", () => {
  const c = config(), r = request();
  for (const change of [
    { fromNumberE164: "12345" },
    { fromNumberE164: "" },
    { agentId: "../agent" },
    { agentVersion: 0 },
    { agentVersion: "latest" },
    { approvedAssistantVersion: "other-label" },
    { maxBudgetSeconds: 601 },
    { maxBudgetSeconds: 420 },
  ]) denied(r, { ...c, ...change });
  denied({...r, recordingAllowed: true}, c);
  denied({...r, callTimeoutSeconds: 600}, c);
  denied({...r, publishedAssistantVersion: "other-version"}, c);
  denied({...r, scenario: {...r.scenario, rawCv: "secret"}}, c);
  denied({...r, arbitraryCandidateName: "Jan"}, c);
});

test("SC-011-C refuses config extras, mutable accessors and prototypes", () => {
  const c = config(), r = request();
  denied(r, {...c, RETELL_API_KEY: "never forward keys"});
  const proto = Object.create(c);
  denied(r, proto);
  const bad = new Proxy(config(), {});
  denied(r, bad);
  const getter = { ...config() };
  let calls = 0;
  Object.defineProperty(getter, "fromNumberE164", {
    enumerable: true, get() {
      calls++;
      return calls === 1 ? "+48581234567" : "not-a-number";
    },
  });
  const result = compileRetellOutboundDraft(r, getter);
  assert.equal(calls, 1);
  assert.equal(result.payload.from_number, "+48581234567");
});

test("SC-011-C sends two different plan snapshots without mixing context", () => {
  const a = compileRetellOutboundDraft(request(), config());
  const b = compileRetellOutboundDraft({
    ...request(),
    externalCorrelationId: "correlation-synthetic-002",
    providerIdempotencyKey: "idempotency-synthetic-002",
    scenario: {
      ...request().scenario,
      questions: [{id:"question-finance",prompt:"Jak ustalasz budzet?",followUps:[]}],
    },
  }, config());
  assert.ok(!a.payload.retell_llm_dynamic_variables.skillcheck_interview_script.includes("budzet"));
  assert.ok(!b.payload.retell_llm_dynamic_variables.skillcheck_interview_script.includes("trudna"));
  assert.notEqual(a.payload.metadata.skillcheck_correlation_id,b.payload.metadata.skillcheck_correlation_id);
});
