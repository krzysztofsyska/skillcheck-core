import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {bootRetention} from './helpers/voice-retention-fixture.mjs';
import {executionHarness} from './helpers/erasure-execution-fixture.mjs';
import {createRankingHarness} from './helpers/screening-ranking-fixture.mjs';
import {prepareOfflineVoiceDraft,cancelOfflineVoicePreparation} from '../lib/voice/offline-preparation.ts';
import {atomicReviewVoicePlan,atomicReleaseVoicePlan} from '../lib/voice/atomic-plan-operations.ts';
import {reconstructTrustedVoiceSource} from '../lib/voice/trusted-source-verifier.ts';
import {ingestVoiceInterviewPermission} from '../lib/voice/interview-permission.ts';
import {syntheticRetellProof} from './helpers/voice-preparation-provider-fixture.mjs';

// Required real PostgreSQL: no skip and no embedded fallback for concurrency.
function pauseAfter(client,predicate){
 let enter,release,used=false;
 const entered=new Promise(r=>{enter=r;}),resume=new Promise(r=>{release=r;});
 return {entered,release,client:{query:async(sql,params)=>{const result=await client.query(sql,params);if(!used&&predicate(sql)){used=true;enter();await resume;}return result;}}};
}

test('R4 voice PostgreSQL transaction races',async t=>{
 const env=await bootRetention(t),{db,h,x}=env;
 await t.test('prepare holding candidate lock prevents freeze; committed preparation is subsequently purged once',async()=>{
  const s=await env.ready(),a=await env.connect(s.f.owner),proof=await syntheticRetellProof();
  const gate=pauseAfter(a,sql=>sql.startsWith('insert into private.sc010c_voice_preparation_requests'));
  const pending=prepareOfflineVoiceDraft(gate.client,s.context,s.request,s.deps(proof.retell,proof.verifiedAgent));
  try{await Promise.race([gate.entered,pending.then(()=>{throw new Error('Preparation did not reach the transaction barrier');})]);await assert.rejects(env.authorize(s),e=>e.code==='PT409');}
  finally{gate.release();}
  await pending;const state=await env.erasing(s);await x.purge(state.request_id,2);assert.equal((await env.quota(s)).reserved,0);
 });
 await t.test('purge rollback retains reservation while replay and cancellation cannot race past candidate lock',async()=>{
  const s=await env.ready(),operation=await env.prepare(s),a=await env.connect(s.f.owner);
  const state=await env.erasing(s);await h.asAdmin();await db.exec('begin');
  try{
   await x.purge(state.request_id,2);
   await assert.rejects(env.prepare(s,a));
   await assert.rejects(cancelOfflineVoicePreparation(a,s.context,operation.operationId));
  }finally{await db.exec('rollback');}
  assert.equal((await env.quota(s)).reserved,1);await x.purge(state.request_id,2);assert.equal((await env.quota(s)).reserved,0);
 });
 await t.test('two people sharing a grant cannot double refund across concurrent purges',async()=>{
  const a=await env.ready('PRESELEKCJA',4),b=await env.ready('PRESELEKCJA',4,{tenant:a.f,entitlementId:a.request.entitlementId});
  await env.prepare(a);await env.prepare(b);const sa=await env.erasing(a),sb=await env.erasing(b);
  const rival=await env.connect(null),y=executionHarness(createRankingHarness(rival));
  await h.asAdmin();await db.exec('begin');
  try{await x.purge(sa.request_id,2);await assert.rejects(y.purge(sb.request_id,2),e=>e.code==='PT409');await db.exec('commit');}
  catch(e){await db.exec('rollback');throw e;}
  await y.purge(sb.request_id,2);assert.equal((await env.quota(a)).reserved,0);
  await x.purge(sa.request_id,2);await y.purge(sb.request_id,2);assert.equal((await env.quota(a)).reserved,0);
 });
 await t.test('prepare, exact replay, permission, source, review and release respect restore lock',async()=>{
  const s=await env.ready(),a=await env.connect(s.f.owner);await env.prepare(s);
  const proof=await syntheticRetellProof(),permission=env.permission;
  const attempts=[
   ()=>prepareOfflineVoiceDraft(a,s.context,{...s.request,requestKey:randomUUID()},s.deps(proof.retell,proof.verifiedAgent)),
   ()=>prepareOfflineVoiceDraft(a,s.context,s.request,s.deps(proof.retell,proof.verifiedAgent)),
   ()=>reconstructTrustedVoiceSource(a,{companyId:s.f.companyId,applicationId:s.f.application.id,analysisId:s.f.analysis_id,reviewId:s.f.reviewId,shortlistEntryId:s.f.shortlistId}),
   ()=>atomicReviewVoicePlan(a,{planId:s.f.planId,sourceHash:s.f.source.sourceHash,expectedReviewVersion:1,decision:'approved',reason:null,requestKey:randomUUID()}),
   ()=>atomicReleaseVoicePlan(a,{planId:s.f.planId,sourceHash:s.f.source.sourceHash,approvedReviewId:s.f.planReviewId,expectedPointerVersion:s.request.pointerVersion,expectedReleaseId:s.f.releaseId,requestKey:randomUUID()}),
   async()=>{await a.query('reset role;set role voice_permission_verifier');await a.query("select set_config('request.jwt.claim.sub','',false)");return ingestVoiceInterviewPermission({attestation:permission.attest(permission.receipt(s.f)),config:permission.config(s.f),context:permission.context(s.f),execute:async(sql,p)=>(await a.query(sql,p)).rows[0].receipt_id});},
  ];
  await h.asAdmin();await db.exec('begin');await db.query('update private.erasure_execution_config set restore_isolated=true where singleton');
  try{for(const attempt of attempts){await env.actor(a,s.f.owner);await assert.rejects(attempt);}}
  finally{await db.exec('rollback');}
  assert.equal((await env.quota(s)).reserved,1);
  await env.prepare(s,a);assert.equal((await env.quota(s)).reserved,1);
 });
 await t.test('permission withdrawal committed after erasing ACK requires fresh signed manifest before purge',async()=>{
  const s=await env.ready();await env.prepare(s);const state=await env.erasing(s),a=await env.connect(null);
  await a.query('begin');await a.query('insert into private.voice_interview_permission_revocations(company_id,receipt_id) values($1,$2)',[s.f.companyId,s.f.permissionReceiptId]);
  try{await assert.rejects(x.purge(state.request_id,2),e=>e.code==='PT409');}finally{await a.query('commit');}
  await assert.rejects(x.purge(state.request_id,2),e=>e.code==='PT409');
  await x.transition(state.request_id,2,'erasing');await x.purge(state.request_id,3);assert.equal((await env.quota(s)).reserved,0);
 });
});
