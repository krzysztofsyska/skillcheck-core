import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {activeBoot,users,observations} from './helpers/competency-active-fixture.mjs';
import {competencyReport,parseCompetencyAccess} from '../lib/competency-staff.ts';
const denied=e=>['42501','PT404'].includes(e.code);

test('C3: only recruiters manage grants; the report separates evidence, declarations and gaps',async t=>{
 const e=await activeBoot(t,{fullChain:true}),{db,h,call}=e;
 const r=await e.submitted();await h.asAdmin();
 await db.query("insert into public.company_members(company_id,user_id,role) values ($1,$2,'viewer'),($1,$3,'recruiter')",[r.f.companyId,users.viewer,users.recruiter]);
 for(const actor of [users.viewer,users.otherOwner]){
  await h.asUser(actor);
  for(const [name,args] of [
   ['public.list_competency_test_access',[r.f.application.id]],
   ['public.create_competency_test_grant',[r.f.application.id,r.f.definitionId,new Date(Date.now()+3600000).toISOString(),randomUUID()]],
   ['public.rotate_competency_test_grant',[r.g.grantId,1,randomUUID()]],
   ['public.revoke_competency_test_grant',[r.g.grantId,randomUUID()]],
   ['public.read_competency_test_response',[r.a.attemptId]],
   ['public.save_competency_test_review',[r.a.attemptId,0,JSON.stringify(observations)]],
  ]) await assert.rejects(call(name,args),denied);
 }
 await h.asUser(users.recruiter);
 const access=parseCompetencyAccess(await call('public.list_competency_test_access',[r.f.application.id]));
 assert.equal(access.access[0].state,'submitted');assert.equal(access.access[0].grantId,r.g.grantId);
 assert.doesNotMatch(JSON.stringify(access),/token|digest|workSample/);
 const scope={companyId:r.f.companyId,recruitmentId:r.f.recruitment.id,applicationId:r.f.application.id};
 let response=await call('public.read_competency_test_response',[r.a.attemptId]);
 let report=competencyReport(response,scope,r.a.attemptId,r.f.definitionId,r.f.definition);
 assert.equal(report.review,null);assert.equal(report.confirmed.length,0);assert.equal(report.missing.length,2);
 await call('public.save_competency_test_review',[r.a.attemptId,0,JSON.stringify(observations)]);
 response=await call('public.read_competency_test_response',[r.a.attemptId]);
 report=competencyReport(response,scope,r.a.attemptId,r.f.definitionId,r.f.definition);
 assert.equal(report.confirmed[0].evidence,'Plan');assert.equal(report.missing[0],'Komunikacja');assert.equal(report.review.score,null);
 assert.equal(report.confirmed[0].rationale,r.f.definition.criteria[0].meets);
 assert.match(report.answer,/Plan/);assert.equal(report.review.coverage,0.5);
 assert.throws(()=>competencyReport(response,{...scope,applicationId:randomUUID()},r.a.attemptId,r.f.definitionId,r.f.definition));
 const forged=structuredClone(response);forged.reviews[0].score=100;
 assert.throws(()=>competencyReport(forged,scope,r.a.attemptId,r.f.definitionId,r.f.definition),/Niezgodna ocena/);
 await h.asUser(r.f.owner);await call('public.withdraw_competency_test_access',[JSON.stringify({kind:'application',application_id:r.f.application.id,reason:'candidate_withdrawn'}),randomUUID()]);
 const withdrawn=parseCompetencyAccess(await call('public.list_competency_test_access',[r.f.application.id]));
 assert.equal(withdrawn.cancelled,true);assert.equal(withdrawn.access[0].state,'withdrawn');assert.equal(withdrawn.access[0].attemptId,null);
 await assert.rejects(call('public.read_competency_test_response',[r.a.attemptId]),denied);
});
