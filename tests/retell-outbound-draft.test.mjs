import test from 'node:test';
import assert from 'node:assert/strict';
import { behaviorAreas } from '../lib/position-fields.ts';
import {
  SC012_INTRODUCTION_VERSION, SC012_PROHIBITED_TOPICS,
  buildInterviewPlan, reviewInterviewPlan, releaseInterviewPlan,
} from '../lib/voice/interview-plan.ts';
import { voiceScenarioFromApprovedPlan } from '../lib/voice/mvp-package-gate.ts';
import {
  TRUSTED_RETELL_CAPABILITY, isRetellAgentId, makeRetellOutboundDraft,
} from '../lib/voice/retell-outbound-draft.ts';

const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const releasedScenario = () => {
  const draft = buildInterviewPlan({
    companyId: uuid(1), applicationId: uuid(2),
    positionRevision: 'pos-v001', analysisRevision: 'ai-v001', reviewRevision: 'review-v001',
    screeningReviewed: true, screeningCurrent: true,
    position: {
      title: 'Przedstawiciel handlowy', tasks: ['Pozyskiwanie klientów'], kpis: ['Nowe umowy'],
      requiredCompetencies: ['Negocjacje'],
      requiredBehaviors: behaviorAreas.map(([, label], i) => label + ': ' + (i < 2 ? 'Krytyczny' : 'Standardowy')),
    },
    gaps: [{ criterionId: 'kpi:1', kind: 'kpi', reason: 'missing_evidence' }],
  });
  const approved = reviewInterviewPlan(draft, {
    expectedRevision: 1, expectedSourceFingerprint: draft.sourceFingerprint, reviewerId: uuid(10),
    reviewedAt: '2026-10-12T10:00:00.000Z',
  });
  const released = releaseInterviewPlan(approved, {
    expectedRevision: 2, expectedSourceFingerprint: approved.sourceFingerprint, releasedBy: uuid(11),
    releasedAt: '2026-10-12T10:01:00.000Z',
  });
  return voiceScenarioFromApprovedPlan(released);
};
const request = scenario => ({
  externalCorrelationId: uuid(2), destinationE164: '+48123456789',
  publishedAssistantVersion: TRUSTED_RETELL_CAPABILITY.publishedAssistantVersion,
  providerIdempotencyKey: '12345678901',
  recordingAllowed: false, callTimeoutSeconds: 600, scenario,
});
const route = () => ({ fromNumber: '+48111122233' });
const binding = () => ({ companyId: uuid(1), applicationId: uuid(2) });
const retryKey = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('Retell draft uses the sealed capability, a random retry key, and no application id', () => {
  const scenario = releasedScenario();
  const one = makeRetellOutboundDraft(request(scenario), route(), binding());
  const two = makeRetellOutboundDraft({
    ...request(scenario), providerIdempotencyKey: 'synthetic.request.001',
  }, route(), binding());
  const { idempotency_key: firstKey, ...firstRest } = one;
  const { idempotency_key: secondKey, ...secondRest } = two;
  assert.deepEqual(firstRest, secondRest);
  assert.match(firstKey, retryKey);
  assert.match(secondKey, retryKey);
  assert.notEqual(firstKey, secondKey);
  assert.notEqual(firstKey, '12345678901');
  assert.notEqual(secondKey, 'synthetic.request.001');
  assert.deepEqual(Object.keys(one).sort(), [
    'agent_override', 'from_number', 'honor_internal_dnc', 'idempotency_key',
    'override_agent_id', 'override_agent_version', 'retell_llm_dynamic_variables', 'to_number',
  ].sort());
  assert.deepEqual(Object.keys(one.agent_override.agent).sort(), [
    'data_storage_retention_days', 'data_storage_setting', 'enable_dnc_detection', 'max_call_duration_ms',
  ].sort());
  assert.equal(one.honor_internal_dnc, true);
  assert.equal(one.agent_override.agent.data_storage_setting, 'basic_attributes_only');
  assert.equal(one.agent_override.agent.data_storage_retention_days, 30);
  assert.equal(one.agent_override.agent.enable_dnc_detection, true);
  assert.equal(one.agent_override.agent.max_call_duration_ms, 600_000);
  assert.equal(one.override_agent_id, TRUSTED_RETELL_CAPABILITY.agentId);
  assert.equal(one.override_agent_version, TRUSTED_RETELL_CAPABILITY.agentVersion);
  assert.equal(one.retell_llm_dynamic_variables.sc_notice_version, SC012_INTRODUCTION_VERSION);
  assert.equal(one.retell_llm_dynamic_variables.sc_max_seconds, '600');
  assert.equal(one.retell_llm_dynamic_variables.sc_prohibited_topics, SC012_PROHIBITED_TOPICS.join(' | '));
  assert.equal(scenario.questions.length, 5);
  const payload = JSON.stringify(one);
  assert.ok(!payload.includes('12345678901'));
  assert.ok(!payload.includes('synthetic.request.001'));
  assert.ok(!payload.includes(uuid(1)));
  assert.ok(!payload.includes(uuid(2)));
  assert.ok(!payload.includes('Pozyskiwanie klientów'));
  assert.ok(!JSON.stringify(one.retell_llm_dynamic_variables).includes('+48123456789'));
  assert.ok(Object.isFrozen(one.agent_override.agent));
});

test('Documented opaque agent ids match the sealed id rule and callers cannot retarget the agent', () => {
  assert.equal(isRetellAgentId('oBeDLoLOeuAbiuaMFXRtDOLriTJ5tSxD'), true);
  assert.equal(isRetellAgentId(TRUSTED_RETELL_CAPABILITY.agentId), true);
  assert.equal(isRetellAgentId('agent_'), false);
  assert.equal(isRetellAgentId('not an agent'), false);
  const scenario = releasedScenario();
  const draft = makeRetellOutboundDraft(request(scenario), route(), binding());
  assert.equal(draft.override_agent_id, TRUSTED_RETELL_CAPABILITY.agentId);
  assert.notEqual(draft.override_agent_id, 'oBeDLoLOeuAbiuaMFXRtDOLriTJ5tSxD');
});

test('Reject caller-supplied agents, short calls, foreign applications and untrusted prompts', () => {
  const scenario = releasedScenario();
  const base = request(scenario);
  const call = (nextRequest, nextRoute = route(), nextBinding = binding()) =>
    makeRetellOutboundDraft(nextRequest, nextRoute, nextBinding);
  for (const badRoute of [
    { fromNumber: '1234' },
    { fromNumber: '+48111122233', agentId: 'oBeDLoLOeuAbiuaMFXRtDOLriTJ5tSxD' },
    { fromNumber: '+48111122233', agentVersion: 7 },
    { fromNumber: '+48111122233', publishedAssistantVersion: 'assistant-v999' },
    { fromNumber: '+48111122233', enforcedProhibitedTopics: [...SC012_PROHIBITED_TOPICS] },
    { fromNumber: '+48111122233', apiKey: 'secret' },
  ]) assert.throws(() => call(base, badRoute), /RETELL_OFFLINE_ROUTING_INVALID/);
  assert.throws(() => call({ ...base, recordingAllowed: true }), /RETELL_OFFLINE_ROUTING_INVALID/);
  assert.throws(() => call({ ...base, callTimeoutSeconds: 60 }), /RETELL_OFFLINE_ROUTING_INVALID/);
  assert.throws(() => call({ ...base, callTimeoutSeconds: 180 }), /RETELL_OFFLINE_ROUTING_INVALID/);
  assert.throws(() => call({ ...base, publishedAssistantVersion: 'assistant-v999' }), /RETELL_OFFLINE_ROUTING_INVALID/);
  assert.throws(() => call(base, route(), { companyId: uuid(9), applicationId: uuid(2) }), /RETELL_UNTRUSTED_SCENARIO/);
  assert.throws(() => call(base, route(), { companyId: uuid(1), applicationId: uuid(8) }), /RETELL_UNTRUSTED_SCENARIO/);
  assert.throws(() => call({ ...base, externalCorrelationId: 'synthetic-application-001' }), /RETELL_UNTRUSTED_SCENARIO/);
  assert.throws(() => call({ ...base, scenario: structuredClone(scenario) }), /RETELL_UNTRUSTED_SCENARIO/);
  assert.throws(() => call({ ...base, rawCv: 'sensitive CV text' }));
  assert.throws(() => call(base, new Proxy(route(), {})));
  for (const scenarioOverride of [
    { questions: scenario.questions.map((q, index) => index === 0 ? { ...q, prompt: 'CV: Jan Kowalski, telefon +48111222333' } : q) },
    { questions: scenario.questions.map((q, index) => index === 4 ? { ...q, followUps: ['Podaj numer PESEL i adres.'] } : q) },
    { constraints: { ...scenario.constraints, prohibitedTopics: ['zdrowie'] } },
    { introductionVersion: 'notice-v001-custom' },
  ]) assert.throws(() => call({ ...base, scenario: { ...scenario, ...scenarioOverride } }), /RETELL_UNTRUSTED_SCENARIO/);
});
