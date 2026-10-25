import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {boot,hash,users,b2Tables,observations} from './helpers/competency-attempt-fixture.mjs';
import {parseCompetencyTestSubmission,evaluateCompetencyTest} from '../lib/competency-test.ts';
const denied=e=>['42501','PT404','PT409','PT422','23505','23514','23503'].includes(e.code);

test('B2 candidate grants, immutable attempt and human review',async t=>{
 const e=await boot(t),{db,h,call}=e;
 await t.test('T1/T2 gateway-only EXECUTE; no direct tables or helper escalation',async()=>{
  const f=await e.seed();
  for(const role of ['anon','authenticated','competency_test_gateway']){
   await h.asAdmin();await db.exec(`set role ${role}`);
   for(const table of b2Tables) for(const sql of [`select * from ${table}`,`delete from ${table}`,`update ${table} set id=id`,`insert into ${table} default values`])await assert.rejects(db.query(sql),denied);
   await assert.rejects(call('private.competency_session',[Buffer.alloc(32)]),denied);
   if(role!=='competency_test_gateway')await assert.rejects(call('private.inspect_candidate_competency_test',[Buffer.alloc(32)]),denied);
  }
  for(const actor of [users.viewer,users.outsider,users.otherOwner]){
   await h.asUser(actor);await assert.rejects(call('public.create_competency_test_grant',[f.application.id,f.definitionId,new Date(Date.now()+3600000),randomUUID()]),denied);
  }
  await h.asAdmin();await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter')",[f.companyId,users.recruiter]);
  await h.asUser(users.recruiter);const g=await call('public.create_competency_test_grant',[f.application.id,f.definitionId,new Date(Date.now()+3600000),randomUUID()]);assert.ok(g.token);
 });
 await t.test('T2 cross-company definitions, reads and composite FK fail closed',async()=>{
  const left=await e.submitted(),right=await e.seed({owner:users.otherOwner});await h.asUser(right.owner);
  await assert.rejects(call('public.read_competency_test_response',[left.a.attemptId]),denied);
  await assert.rejects(call('public.save_competency_test_review',[left.a.attemptId,0,JSON.stringify(observations)]),denied);
  await assert.rejects(call('public.create_competency_test_grant',[right.application.id,left.f.definitionId,new Date(Date.now()+3600000),randomUUID()]),denied);
  await h.asAdmin();await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'viewer')",[left.f.companyId,users.viewer]);
  await h.asUser(users.viewer);await assert.rejects(call('public.read_competency_test_response',[left.a.attemptId]),denied);
  const fresh=await e.seed(),other=await e.seed({tenant:fresh});await h.asAdmin();await db.query("select set_config('request.jwt.claim.sub',$1,false)",[fresh.owner]);
  await assert.rejects(db.query(`insert into private.competency_test_grants(company_id,candidate_id,recruitment_id,application_id,definition_entry_id,token_digest,start_by_at,created_by,issuance_request_key,event_request_key)
    values($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '1 hour',$7,$8,$9)`,[fresh.companyId,other.candidate.id,fresh.recruitment.id,fresh.application.id,fresh.definitionId,Buffer.alloc(32,3),fresh.owner,randomUUID(),randomUUID()]),e=>e.code==='23503');
 });
 await t.test('T10 an SC008-valid but SC014-A-invalid rubric cannot issue or start',async()=>{
  const f=await e.seed(),bad={...f.definition,title:'😀'.repeat(101)};await h.asUser(f.owner);
  const id=await call('public.save_exercise_definition',[f.recruitment.id,randomUUID(),JSON.stringify(bad),0,f.position.id,f.position.updated_at]);
  assert.throws(()=>parseCompetencyTestSubmission(bad,{workSample:'Plan'}));
  await assert.rejects(call('public.create_competency_test_grant',[f.application.id,id,new Date(Date.now()+3600000),randomUUID()]),e=>e.code==='PT422');
  await h.asAdmin();assert.equal((await db.query('select count(*)::int n from private.competency_test_grants where definition_entry_id=$1',[id])).rows[0].n,0);
  // A legacy/imported grant is also rechecked at start, before releasing content.
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[f.owner]);
  const token='7'.repeat(64);
  await db.query(`insert into private.competency_test_grants(company_id,candidate_id,recruitment_id,application_id,definition_entry_id,token_digest,start_by_at,created_by,issuance_request_key,event_request_key)
    values($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '1 hour',$7,$8,$9)`,[f.companyId,f.candidate.id,f.recruitment.id,f.application.id,id,hash(token),f.owner,randomUUID(),randomUUID()]);
  const session=await e.exchange({token});
  await assert.rejects(call('private.start_candidate_competency_test',[hash(session.session),randomUUID()]),e=>e.code==='PT422');
  await h.asAdmin();assert.equal((await db.query('select count(*)::int n from public.competency_test_attempts where definition_entry_id=$1',[id])).rows[0].n,0);
 });
 await t.test('T3 lost issue and rotation responses, stable uniqueness and atomic immutable audit',async()=>{
  const f=await e.seed(),g=await e.issue(f);const replay=await e.issue(f,{key:g.key,startBy:g.startBy});
  assert.equal(replay.grantId,g.grantId);assert.equal(replay.state,'secret_unavailable_rotate_required');assert.equal(replay.token,undefined);
  const s=await e.exchange(g);await assert.rejects(e.exchange(g),denied);
  await h.asUser(f.owner);const key=randomUUID();const rotated=await call('public.rotate_competency_test_grant',[g.grantId,1,key]);assert.equal(Number(rotated.revision),2);
  const lost=await call('public.rotate_competency_test_grant',[g.grantId,1,key]);assert.equal(lost.token,undefined);
  await e.asGateway();await assert.rejects(call('private.inspect_candidate_competency_test',[hash(s.session)]),denied);await assert.rejects(e.exchange(g),denied);
  const fresh=await e.exchange(rotated);assert.ok(fresh.session);
  await h.asUser(f.owner);await call('public.revoke_competency_test_grant',[g.grantId,randomUUID()]);await assert.rejects(e.issue(f),denied);
  await e.asGateway();await assert.rejects(call('private.inspect_candidate_competency_test',[hash(fresh.session)]),denied);
  await h.asAdmin();const events=(await db.query('select kind,revision from private.competency_test_grant_events where grant_id=$1 order by created_at',[g.grantId])).rows;
  assert.deepEqual(events.map(v=>v.kind),['issued','rotated','revoked']);
  await assert.rejects(db.query('update private.competency_test_grant_events set revision=100 where grant_id=$1',[g.grantId]),denied);
  const stored=JSON.stringify((await db.query('select to_jsonb(g) value from private.competency_test_grants g where id=$1',[g.grantId])).rows);
  assert.equal(stored.includes(g.token),false);assert.equal(stored.includes(rotated.token),false);
 });
 await t.test('T4/T5 metadata before start; recovery, full 180 minutes and stable replay',async()=>{
  const f=await e.seed({duration:180}),g=await e.issue(f,{startBy:new Date(Date.now()+60000).toISOString()}),s=await e.exchange(g);
  const pre=await call('private.inspect_candidate_competency_test',[hash(s.session)]);
  assert.deepEqual(Object.keys(pre).sort(),['durationMinutes','label','revisionId','state','version']);
  assert.equal(JSON.stringify(pre).includes('Poufny'),false);
  const key=randomUUID(),start=await call('private.start_candidate_competency_test',[hash(s.session),key]);
  assert.equal(new Date(start.deadlineAt)-new Date(start.startedAt),180*60000);
  const retry=await call('private.start_candidate_competency_test',[hash(s.session),key]);assert.deepEqual(retry,start);
  await call('private.save_candidate_competency_test_draft',[hash(s.session),'',0,randomUUID()]);
  const draftKey=randomUUID();assert.deepEqual(await call('private.save_candidate_competency_test_draft',[hash(s.session),'Plan roboczy',1,draftKey]),{version:2});
  assert.deepEqual(await call('private.save_candidate_competency_test_draft',[hash(s.session),'Plan roboczy',1,draftKey]),{version:2});
  const recovered=await call('private.inspect_candidate_competency_test',[hash(s.session)]);assert.equal(recovered.draft.text,'Plan roboczy');assert.equal(recovered.deadlineAt,start.deadlineAt);
  for(const forbidden of ['criteria','company_id','candidate_id','observations','score','submission_digest'])assert.equal(JSON.stringify(recovered).includes('"'+forbidden+'"'),false);
  await h.asAdmin();const session=(await db.query('select absolute_expires_at,idle_expires_at from private.competency_test_sessions where session_digest=$1',[hash(s.session)])).rows[0];
  assert.equal(new Date(session.absolute_expires_at)-new Date(start.deadlineAt),900000);assert.equal(+new Date(session.absolute_expires_at),+new Date(session.idle_expires_at));
 });
 await t.test('T10 invalid direct submit keeps draft, timer and attempt; canonical replay',async()=>{
  const {f,s,a}=await e.started();await call('private.save_candidate_competency_test_draft',[hash(s.session),'zachowaj draft',0,randomUUID()]);
  for(const input of [null,{},[],{workSample:null},{workSample:3},...['',' \t\n','\u200b','\u2800','!!!','x'.repeat(20001)].map(workSample=>({workSample}))]){
   await assert.rejects(call('private.submit_candidate_competency_test',[hash(s.session),JSON.stringify(input),randomUUID()]),denied);
   const recovered=await call('private.inspect_candidate_competency_test',[hash(s.session)]);assert.equal(recovered.state,'in_progress');assert.equal(recovered.draft.text,'zachowaj draft');assert.equal(recovered.deadlineAt,a.deadlineAt);
  }
  const payload={workSample:'  Plan wdrożenia. \n',company_id:randomUUID(),score:100};
  const receipt=await call('private.submit_candidate_competency_test',[hash(s.session),JSON.stringify(payload),randomUUID()]);
  assert.deepEqual(Object.keys(receipt).sort(),['attemptId','state']);
  assert.deepEqual(await call('private.submit_candidate_competency_test',[hash(s.session),JSON.stringify({workSample:'Plan wdrożenia.'}),randomUUID()]),receipt);
  await assert.rejects(call('private.submit_candidate_competency_test',[hash(s.session),JSON.stringify({workSample:'Inny plan.'}),randomUUID()]),denied);
  await assert.rejects(call('private.save_candidate_competency_test_draft',[hash(s.session),'overwrite',1,randomUUID()]),denied);
  await h.asAdmin();assert.equal((await db.query('select count(*)::int n from private.competency_test_drafts where attempt_id=$1',[a.attemptId])).rows[0].n,0);
  await assert.rejects(db.query("update public.competency_test_attempts set work_sample='zmiana' where id=$1",[a.attemptId]),denied);
  await h.asUser(f.owner);const read=await call('public.read_competency_test_response',[a.attemptId]);assert.equal(read.workSample,parseCompetencyTestSubmission(f.definition,payload).workSample);
 });
 await t.test('human rating bound to immutable answer and rubric, ordinary closure remains allowed',async()=>{
  const {f,a}=await e.submitted();await h.asUser(f.owner);
  await db.query("update public.applications set status='rejected' where id=$1",[f.application.id]);await db.query("update public.recruitments set status='closed' where id=$1",[f.recruitment.id]);
  await call('public.save_competency_test_review',[a.attemptId,0,JSON.stringify(observations)]);
  const read=await call('public.read_competency_test_response',[a.attemptId]);const expected=evaluateCompetencyTest(f.definition,{workSample:read.workSample},observations);
  assert.equal(Number(read.reviews[0].coverage),expected.coverage);assert.equal(read.reviews[0].score,null);assert.equal(read.reviews[0].reviewer_id,f.owner);
  for(const bad of [[],[{criterionIndex:0,rating:'above',evidence:'missing quote'},{criterionIndex:1,rating:'below',evidence:'Plan'}],observations.map(v=>({...v,criterionIndex:1}))])
   await assert.rejects(call('public.save_competency_test_review',[a.attemptId,1,JSON.stringify(bad)]),denied);
  await h.asAdmin();await assert.rejects(db.query('delete from public.competency_test_review_entries where attempt_id=$1',[a.attemptId]),denied);
 });
});
