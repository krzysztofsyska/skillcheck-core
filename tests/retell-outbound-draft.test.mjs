import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRetellOutboundDraft } from '../lib/voice/retell-outbound-draft.ts';

const mock = () => ({
  externalCorrelationId:'synthetic-application-001',destinationE164:'+48123456789',
  publishedAssistantVersion:'assistant-v001',providerIdempotencyKey:'synthetic-request-001',
  recordingAllowed:false,callTimeoutSeconds:600,
  scenario:{
    schemaVersion:1,language:'pl-PL',introductionVersion:'notice-pl-202610',
    questions:[{id:'common-situation',prompt:'Proszę opisać sytuację zawodową.',followUps:['Jaki był rezultat?']}],
    constraints:{maxSeconds:600,prohibitedTopics:['zdrowie']},
  },
});
const route = () => ({fromNumber:'+48111122233',agentId:'agent_1234567890',agentVersion:7});
test('Retell pure request is deterministic, versioned and includes no candidate CV',()=>{
  const one=makeRetellOutboundDraft(mock(),route());
  const two=makeRetellOutboundDraft({...mock(),scenario:{
    constraints:{prohibitedTopics:['zdrowie'],maxSeconds:600},
    questions:[{followUps:['Jaki był rezultat?'],prompt:'Proszę opisać sytuację zawodową.',id:'common-situation'}],
    introductionVersion:'notice-pl-202610',language:'pl-PL',schemaVersion:1,
  }},route());
  assert.deepEqual(one,two);
  assert.deepEqual(Object.keys(one).sort(),[
    'from_number','idempotency_key','override_agent_id','override_agent_version',
    'retell_llm_dynamic_variables','to_number',
  ].sort());
  assert.deepEqual({...one.retell_llm_dynamic_variables},{
    sc_notice_version:'notice-pl-202610',sc_language:'pl-PL',sc_max_seconds:'600',
    sc_question_count:'1',sc_question_1:'Proszę opisać sytuację zawodową.',
    sc_followup_1_1:'Jaki był rezultat?',
  });
  assert.equal(one.idempotency_key,mock().providerIdempotencyKey);
  assert.equal(one.override_agent_version,7);
  assert.ok(Object.isFrozen(one));
  assert.ok(!JSON.stringify(one).includes('synthetic-application-001'));
  assert.ok(!JSON.stringify(one).includes('raw_cv'));
});

test('No provider calls; reject malformed routing, unexpected fields or recording',()=>{
  for(const bad of [
    {...route(),agentId:'not-an-agent'},
    {...route(),fromNumber:'1234'},
    {...route(),agentVersion:'latest_published'},
    {...route(),agentVersion:-1},
    {...route(),agentVersion:0.5},
    {...route(),apiKey:'secret'},
  ]) assert.throws(()=>makeRetellOutboundDraft(mock(),bad),/RETELL_OFFLINE_ROUTING_INVALID/);
  assert.throws(()=>makeRetellOutboundDraft({...mock(),recordingAllowed:true},route()),/RETELL_OFFLINE_ROUTING_INVALID/);
  assert.throws(()=>makeRetellOutboundDraft({...mock(),rawCv:'sensitive'},route()));
  assert.throws(()=>makeRetellOutboundDraft(mock(),new Proxy(route(),{})));
});
