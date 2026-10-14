import test from 'node:test';
import assert from 'node:assert/strict';
import { behaviorAreas } from '../lib/position-fields.ts';
import {
  SC012_INTRODUCTION_VERSION, SC012_PROHIBITED_TOPICS,
  buildInterviewPlan, reviewInterviewPlan, releaseInterviewPlan,
} from '../lib/voice/interview-plan.ts';
import { voiceScenarioFromApprovedPlan } from '../lib/voice/mvp-package-gate.ts';
import { makeRetellOutboundDraft } from '../lib/voice/retell-outbound-draft.ts';

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
const request = () => ({
  externalCorrelationId: 'synthetic-application-001', destinationE164: '+48123456789',
  publishedAssistantVersion: 'assistant-v001', providerIdempotencyKey: 'synthetic-request-001',
  recordingAllowed: false, callTimeoutSeconds: 600, scenario: releasedScenario(),
});
const route = () => ({
  fromNumber: '+48111122233', agentId: 'agent_1234567890', agentVersion: 7,
  publishedAssistantVersion: 'assistant-v001',
  enforcedProhibitedTopics: [...SC012_PROHIBITED_TOPICS],
});

test('Retell pure request is deterministic, version-bound and contains only controlled templates', () => {
  const scenario = releasedScenario();
  const one = makeRetellOutboundDraft({ ...request(), scenario }, route());
  const two = makeRetellOutboundDraft({
    ...request(),
    scenario: {
      constraints: { prohibitedTopics: [...scenario.constraints.prohibitedTopics], maxSeconds: 600 },
      questions: scenario.questions.map(q => ({ followUps: [...q.followUps], prompt: q.prompt, id: q.id })),
      introductionVersion: scenario.introductionVersion, language: 'pl-PL', schemaVersion: 1,
    },
  }, route());
  assert.deepEqual(one, two);
  assert.deepEqual(Object.keys(one).sort(), [
    'agent_override', 'from_number', 'honor_internal_dnc', 'idempotency_key',
    'override_agent_id', 'override_agent_version', 'retell_llm_dynamic_variables', 'to_number',
  ].sort());
  assert.deepEqual(Object.keys(one.agent_override), ['agent']);
  assert.deepEqual(Object.keys(one.agent_override.agent).sort(), [
    'data_storage_setting', 'enable_dnc_detection', 'max_call_duration_ms',
  ].sort());
  assert.equal(one.honor_internal_dnc, true);
  assert.equal(one.agent_override.agent.data_storage_setting, 'basic_attributes_only');
  assert.equal(one.agent_override.agent.enable_dnc_detection, true);
  assert.equal(one.agent_override.agent.max_call_duration_ms, 600_000);
  assert.equal(one.override_agent_version, 7);
  assert.equal(one.idempotency_key, 'synthetic-request-001');
  const variables = { ...one.retell_llm_dynamic_variables };
  assert.equal(variables.sc_notice_version, SC012_INTRODUCTION_VERSION);
  assert.equal(variables.sc_language, 'pl-PL');
  assert.equal(variables.sc_max_seconds, '600');
  assert.equal(variables.sc_question_count, String(scenario.questions.length));
  assert.equal(variables.sc_prohibited_topics, SC012_PROHIBITED_TOPICS.join(' | '));
  scenario.questions.forEach((q, index) => {
    assert.equal(variables['sc_question_' + (index + 1)], q.prompt);
    assert.equal(variables['sc_followup_' + (index + 1) + '_1'], q.followUps[0]);
  });
  assert.equal(scenario.questions.length, 5);
  const payload = JSON.stringify(one);
  assert.ok(!payload.includes('synthetic-application-001'));
  assert.ok(!payload.includes('raw_cv'));
  assert.ok(!payload.includes('Pozyskiwanie klientów'));
  assert.ok(!payload.includes(uuid(1)));
  assert.ok(!JSON.stringify(variables).includes('+48123456789'));
  assert.ok(Object.isFrozen(one));
  assert.ok(Object.isFrozen(one.agent_override.agent));
});

test('Opaque Retell agent ids are accepted and the approved assistant version is bound', () => {
  const opaque = makeRetellOutboundDraft(request(), {
    ...route(), agentId: 'oBeDLoLOeuAbiuaMFXRtDOLriTJ5tSxD',
  });
  assert.equal(opaque.override_agent_id, 'oBeDLoLOeuAbiuaMFXRtDOLriTJ5tSxD');
  assert.equal(opaque.override_agent_version, 7);
  const shorter = makeRetellOutboundDraft({ ...request(), callTimeoutSeconds: 180 }, route());
  assert.equal(shorter.agent_override.agent.max_call_duration_ms, 180_000);
  assert.equal(shorter.retell_llm_dynamic_variables.sc_max_seconds, '180');
});

test('Reject untrusted prompts, drifted policy, Retell-invalid keys and unbound versions', () => {
  const scenario = releasedScenario();
  const base = { ...request(), scenario };
  for (const bad of [
    { ...route(), agentId: 'not an agent' },
    { ...route(), agentId: 'agent_' },
    { ...route(), agentId: 'javascript:alert(1)' },
    { ...route(), fromNumber: '1234' },
    { ...route(), agentVersion: 'latest_published' },
    { ...route(), agentVersion: -1 },
    { ...route(), agentVersion: 0.5 },
    { ...route(), apiKey: 'secret' },
    { ...route(), publishedAssistantVersion: 'assistant-v999' },
    { ...route(), enforcedProhibitedTopics: ['zdrowie'] },
  ]) assert.throws(() => makeRetellOutboundDraft(base, bad), /RETELL_OFFLINE_ROUTING_INVALID/);
  assert.throws(() => makeRetellOutboundDraft({ ...base, recordingAllowed: true }, route()), /RETELL_OFFLINE_ROUTING_INVALID/);
  assert.throws(() => makeRetellOutboundDraft({ ...base, providerIdempotencyKey: 'synthetic.request.001' }, route()), /RETELL_OFFLINE_ROUTING_INVALID/);
  assert.throws(() => makeRetellOutboundDraft({ ...base, providerIdempotencyKey: 'synthetic:request:001' }, route()), /RETELL_OFFLINE_ROUTING_INVALID/);
  assert.throws(() => makeRetellOutboundDraft({ ...base, rawCv: 'sensitive CV text' }, route()));
  assert.throws(() => makeRetellOutboundDraft(base, new Proxy(route(), {})));
  assert.throws(() => makeRetellOutboundDraft({
    ...base,
    scenario: {
      ...scenario,
      questions: scenario.questions.map((q, index) => index === 0
        ? { ...q, prompt: 'CV: Jan Kowalski, telefon +48111222333' }
        : q),
    },
  }, route()), /RETELL_UNTRUSTED_SCENARIO/);
  assert.throws(() => makeRetellOutboundDraft({
    ...base,
    scenario: {
      ...scenario,
      questions: scenario.questions.map((q, index) => index === 4
        ? { ...q, followUps: ['Podaj numer PESEL i adres.'] }
        : q),
    },
  }, route()), /RETELL_UNTRUSTED_SCENARIO/);
  assert.throws(() => makeRetellOutboundDraft({
    ...base,
    scenario: {
      ...scenario,
      constraints: { ...scenario.constraints, prohibitedTopics: ['zdrowie'] },
    },
  }, route()), /RETELL_UNTRUSTED_SCENARIO/);
  assert.throws(() => makeRetellOutboundDraft({
    ...base,
    scenario: { ...scenario, introductionVersion: 'notice-v001-custom' },
  }, route()), /RETELL_UNTRUSTED_SCENARIO/);
});
