import test from 'node:test';
import assert from 'node:assert/strict';
import { behaviorAreas } from '../lib/position-fields.ts';
import { buildInterviewPlan, reviewInterviewPlan, releaseInterviewPlan } from '../lib/voice/interview-plan.ts';
import { evaluateVoiceMvpPreflight, scenarioApplicationBinding, voiceScenarioFromApprovedPlan } from '../lib/voice/mvp-package-gate.ts';
import { validateVoiceCallRequest } from '../lib/voice/provider.ts';
import { FakeVoiceProvider } from '../lib/voice/fake-provider.ts';

const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const policy=(plan='FREE')=>({
  plan, companyVerified:true, freeTrialApproved:true, paidSettlementVerified:true, planActive:true,
  screeningReviewedAndCurrent:true, planReleasedAndCurrent:true,
  candidateContactApproved:true, candidateNoticeDelivered:true, providerEnabled:true,
  limit:{total:plan==='FREE'?1:10,used:0,reserved:0},
});
const source=()=>({
  companyId:uuid(1), applicationId:uuid(2),
  positionRevision:'pos-v001',analysisRevision:'ai-v001',reviewRevision:'review-v001',
  screeningReviewed:true,screeningCurrent:true,
  position:{
    title:'Przedstawiciel handlowy',tasks:['Pozyskiwanie klientów'],kpis:['Nowe umowy'],
    requiredCompetencies:['Negocjacje'],requiredBehaviors:behaviorAreas.map(([,label],i)=>
      label+': '+(i<2?'Krytyczny':'Standardowy')),
  },
  gaps:[{criterionId:'kpi:1',kind:'kpi',reason:'missing_evidence'}],
});

test('FREE and PRESELEKCJA can be enabled separately with configured backend quota',()=>{
  for(const plan of ['FREE','PRESELEKCJA']){
    const result=evaluateVoiceMvpPreflight(policy(plan));
    assert.deepEqual(result,{state:'prepared_for_trusted_dispatch',package:plan,maxSeconds:600});
    assert.equal(evaluateVoiceMvpPreflight({...policy(plan),limit:{total:plan==='FREE'?1:10,used:0,reserved:plan==='FREE'?1:10}}).reason,'quota_exhausted');
  }
  assert.equal(evaluateVoiceMvpPreflight({...policy('PRESELEKCJA'),limit:{total:2,used:2,reserved:0}}).reason,'quota_exhausted');
  assert.equal(evaluateVoiceMvpPreflight({...policy('FREE'),limit:{total:10,used:1,reserved:0}}).reason,'invalid_snapshot');
  assert.equal(evaluateVoiceMvpPreflight({...policy('FREE'),limit:{total:10,used:0,reserved:0}}).reason,'invalid_snapshot');
  assert.equal(evaluateVoiceMvpPreflight({...policy('FREE'),limit:{total:2,used:0,reserved:0}}).reason,'invalid_snapshot');
});

test('FREE strictly requires verified trial; PRESELEKCJA strictly requires paid settlement',()=>{
  assert.equal(evaluateVoiceMvpPreflight({...policy('FREE'),freeTrialApproved:false}).reason,'trial_not_approved');
  assert.equal(evaluateVoiceMvpPreflight({...policy('PRESELEKCJA'),paidSettlementVerified:false}).reason,'payment_not_verified');
  assert.equal(evaluateVoiceMvpPreflight({...policy('PRESELEKCJA'),planActive:false}).reason,'package_not_active');
  assert.equal(evaluateVoiceMvpPreflight({...policy(),companyVerified:false}).reason,'company_unverified');
});

test('No call without current human-approved interview, consent, notice and enabled provider',()=>{
  for(const [field,reason] of [
    ['screeningReviewedAndCurrent','screening_or_plan_not_ready'],
    ['planReleasedAndCurrent','screening_or_plan_not_ready'],
    ['candidateContactApproved','contact_not_authorized'],
    ['candidateNoticeDelivered','contact_not_authorized'],
    ['providerEnabled','provider_not_enabled'],
  ]) assert.equal(evaluateVoiceMvpPreflight({...policy(),[field]:false}).reason,reason);
});

test('Fail closed for unknown fields (CV, phone, price), unsafe counts and non-boolean markers',()=>{
  for(const bad of [
    {...policy(),rawCv:'PRIVATE'}, {...policy(),phone:'+48123456789'},
    {...policy(),price:1}, {...policy(),providerEnabled:'true'},
    {...policy(),plan:'WERYFIKACJA'}, {...policy(),limit:{total:-1,used:0,reserved:0}},
    {...policy(),limit:{total:1,used:2,reserved:0}},
    {...policy(),limit:{total:1,used:0,reserved:0,other:1}},
    {...policy(),limit:{total:NaN,used:0,reserved:0}},
    {...policy(),limit:{total:1,used:0,reserved:1.5}},
    null,[],{...policy(),limit:null},new Proxy(policy(),{}),
  ]) assert.equal(evaluateVoiceMvpPreflight(bad).reason,'invalid_snapshot');
});

test('SC-012 reviewed & released plan projects into the real SC-011 VoiceScenario contract',async()=>{
  const draft=buildInterviewPlan(source());
  assert.throws(()=>voiceScenarioFromApprovedPlan(draft),/VOICE_MVP_PLAN_NOT_RELEASED/);
  const approved=reviewInterviewPlan(draft,{
    expectedRevision:1,expectedSourceFingerprint:draft.sourceFingerprint,reviewerId:uuid(10),
    reviewedAt:'2026-10-12T10:00:00.000Z',
  });
  assert.throws(()=>voiceScenarioFromApprovedPlan(approved),/VOICE_MVP_PLAN_NOT_RELEASED/);
  const released=releaseInterviewPlan(approved,{
    expectedRevision:2,expectedSourceFingerprint:approved.sourceFingerprint,releasedBy:uuid(11),
    releasedAt:'2026-10-12T10:01:00.000Z',
  });
  const scenario=voiceScenarioFromApprovedPlan(released);
  assert.equal(scenario.questions.length,5);
  assert.equal(scenario.constraints.maxSeconds,600);
  assert.equal(scenario.language,'pl-PL');
  assert.equal(scenario.introductionVersion,'notice-pl-202610');
  assert.deepEqual(scenario.questions.map(q=>q.prompt),released.questions.map(q=>q.text));
  assert.deepEqual(scenarioApplicationBinding(scenario),{
    companyId:uuid(1),applicationId:uuid(2),sourceFingerprint:released.sourceFingerprint,
  });
  assert.equal(scenarioApplicationBinding(structuredClone(scenario)),undefined);
  assert.ok(!JSON.stringify(scenario).includes(uuid(1)));
  assert.ok(!JSON.stringify(scenario).includes(uuid(2)));
  assert.ok(!JSON.stringify(scenario).includes('Pozyskiwanie klientów'));
  assert.ok(!JSON.stringify(scenario).includes('Nowe umowy'));
  const request={
    externalCorrelationId:'fictional-case-001', destinationE164:'+48123456789',
    publishedAssistantVersion:'assistant-v001',scenario,
    recordingAllowed:false,callTimeoutSeconds:600,providerIdempotencyKey:'fictional-attempt-001',
  };
  assert.doesNotThrow(()=>validateVoiceCallRequest(request));
  const offline=new FakeVoiceProvider();
  const accepted=await offline.initiateOutbound(request);
  assert.equal(offline.syntheticCallCount,1);
  assert.ok(accepted.providerCallId.startsWith('fake-call-'));
  await assert.rejects(offline.initiateOutbound({...request,destinationE164:'+48987654321'}));
});

test('No forging allowed via extra injected questions or malformed released status',()=>{
  const draft=buildInterviewPlan(source());
  const approved=reviewInterviewPlan(draft,{
    expectedRevision:1,expectedSourceFingerprint:draft.sourceFingerprint,reviewerId:uuid(10),
    reviewedAt:'2026-10-12T10:00:00.000Z',
  });
  const released=releaseInterviewPlan(approved,{
    expectedRevision:2,expectedSourceFingerprint:approved.sourceFingerprint,releasedBy:uuid(11),
    releasedAt:'2026-10-12T10:01:00.000Z',
  });
  const fake={...draft,status:'released',revision:3,
    releasedAt:'2026-10-12T10:01:00.000Z',releasedBy:uuid(11),
    reviewerId:uuid(10),reviewedAt:'2026-10-12T10:00:00.000Z'};
  assert.doesNotThrow(()=>JSON.stringify(fake));
  assert.equal(evaluateVoiceMvpPreflight({...policy(),planReleasedAndCurrent:false}).state,'blocked');
  assert.throws(()=>voiceScenarioFromApprovedPlan(fake),/VOICE_MVP_PLAN_NOT_RELEASED/);
  assert.throws(()=>voiceScenarioFromApprovedPlan(structuredClone(released)),/VOICE_MVP_PLAN_NOT_RELEASED/);
  assert.throws(()=>voiceScenarioFromApprovedPlan({
    ...released,
    questions:released.questions.map((q,index)=>index===0?{...q,text:'CV Jana Kowalskiego, tel. +48111222333'}:q),
  }),/VOICE_MVP_PLAN_NOT_RELEASED/);
  assert.doesNotThrow(()=>voiceScenarioFromApprovedPlan(released));
});
