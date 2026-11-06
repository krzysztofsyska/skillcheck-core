import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { guardBoot, denied, hash } from './helpers/exercise-ai-grant-guard-fixture.mjs';

const snapshot=async db=>(await db.query(`select p.oid::regprocedure::text name,pg_get_userbyid(proowner) owner,proacl::text acl,proconfig,prosecdef
 from pg_proc p where oid in ('private.competency_eligible(public.applications,uuid)'::regprocedure,
 'exercise_ai.record_proposal(uuid,uuid,jsonb,integer)'::regprocedure) order by name`)).rows;

test('C6 AC3: pending AI denied, manual/manual-approved/auto-approved work, retagging forbidden and R14 unchanged',async t=>{
 const e=await guardBoot(t),{db,h}=e;
 await h.asAdmin();const before=await snapshot(db);
 const signature=(await db.query('select private.erasure_schema_signature() s')).rows[0].s;
 await e.install();assert.deepEqual(await snapshot(db),before);
 assert.equal((await db.query('select private.erasure_schema_signature() s')).rows[0].s,signature);
 execFileSync(process.execPath,['scripts/sc-c6-grant-guard-compose.mjs','--check']);
 const pending=await e.seed();await e.record(pending);
 await assert.rejects(e.issue(pending),denied('PT404'));
 await h.asAdmin();assert.equal((await db.query('select count(*)::int n from private.competency_test_grants where definition_entry_id=$1',[pending.definitionId])).rows[0].n,0);
 for(const mode of ['manual_definition','manual_approval','auto_approval']){
  const f=await e.seed();
  if(mode==='auto_approval')await db.query('select exercise_ai.set_auto_release($1,true)',[f.recruitment.id]);
  if(mode!=='manual_definition')await e.record(f);
  if(mode==='manual_approval')await e.approve(f);
  const g=await e.issue(f),s=await e.exchange(g);
  const started=await e.call('private.start_candidate_competency_test',[hash(s.session),randomUUID()]);
  assert.equal(started.state,'in_progress');assert.ok(started.test.instructions);
  await h.asUser(f.owner);
  if(mode==='manual_definition'){
   await assert.rejects(e.record(f),denied('PT409'));
   await e.call('public.revoke_competency_test_grant',[g.grantId,randomUUID()]);
   await assert.rejects(e.record(f),denied('PT409'));
  }
 }
 const fresh=await e.seed();
 for(const isolation of ['repeatable read','serializable']){
  await h.asUser(fresh.owner);await db.exec('begin isolation level '+isolation);
  try{await assert.rejects(e.record(fresh),denied('PT409'));}finally{await db.exec('rollback');}
  await db.exec('begin isolation level '+isolation);
  try{await assert.rejects(e.issue(fresh),denied('PT409'));}finally{await db.exec('rollback');}
 }
 // Operational rollback pauses AI intake without reopening candidate access.
 await h.asAdmin();await db.exec(await readFile(new URL('../supabase/rollbacks/20261106140000_exercise_ai_grant_guard_down.sql',import.meta.url),'utf8'));
 assert.equal((await db.query('select private.erasure_schema_signature() s')).rows[0].s,signature);
 await h.asUser(fresh.owner);await assert.rejects(e.record(fresh),denied('42501'));
 await assert.rejects(e.issue(pending),denied('PT404'));
 assert.ok((await e.issue(fresh)).token);
});

test('C6 AC3: legacy pre-attachment grants and sessions fail closed on every candidate path/replay; staff history survives',async t=>{
 const e=await guardBoot(t),{db,h}=e;
 // Build states with the reviewed R14 APIs BEFORE the new boundary is installed.
 const unopened=await e.seed(),startBy=new Date(Date.now()+3600000).toISOString(),g=await e.issue(unopened,{startBy});
 const rotationKey=randomUUID(),rotated=await e.call('public.rotate_competency_test_grant',[g.grantId,g.revision,rotationKey]);
 await e.record(unopened);
 const started=await e.started();await h.asUser(started.f.owner);await e.record(started.f);
 const submitted=await e.submitted();await h.asUser(submitted.f.owner);await e.record(submitted.f);
 await e.install();
 await assert.rejects(e.issue(unopened,{key:g.key,startBy}),denied('PT404'));
 await h.asUser(unopened.owner);
 await assert.rejects(e.call('public.rotate_competency_test_grant',[g.grantId,g.revision,rotationKey]),denied('PT404'));
 await assert.rejects(e.call('public.rotate_competency_test_grant',[g.grantId,rotated.revision,randomUUID()]),denied('PT404'));
 await assert.rejects(e.exchange(rotated),denied('PT404'));
 await e.asGateway();
 const session=hash(started.s.session),submittedSession=hash(submitted.s.session);
 for(const [name,args] of [
  ['private.inspect_candidate_competency_test',[session]],
  ['private.start_candidate_competency_test',[session,randomUUID()]],
  ['private.save_candidate_competency_test_draft',[session,'draft',0,randomUUID()]],
  ['private.submit_candidate_competency_test',[session,JSON.stringify({workSample:'Proposed answer'}),randomUUID()]],
  ['private.inspect_candidate_competency_test',[submittedSession]],
  ['private.status_candidate_competency_test',[submittedSession]],
  ['private.submit_candidate_competency_test',[submittedSession,JSON.stringify({workSample:'Plan wdrożenia obejmuje terminy i komunikację.'}),randomUUID()]],
 ])await assert.rejects(e.call(name,args),denied('PT404'));
 await h.asUser(submitted.f.owner);
 const historical=await e.call('public.read_competency_test_response',[submitted.receipt.attemptId]);
 assert.equal(historical.workSample,'Plan wdrożenia obejmuje terminy i komunikację.');
 assert.equal((await e.call('public.list_competency_test_attempts',[submitted.f.application.id])).length,1);
 await e.approve(started.f);await e.asGateway();
 assert.equal((await e.call('private.inspect_candidate_competency_test',[session])).state,'in_progress');
 await e.approve(submitted.f);await e.asGateway();
 assert.equal((await e.call('private.status_candidate_competency_test',[submittedSession])).state,'submitted');
});

test('C6 AC3: migration rejects unreviewed schema, function body and function ACL before changing either RPC',async t=>{
 const e=await guardBoot(t),{db,h}=e;
 await h.asAdmin();
 const original=(await db.query("select pg_get_functiondef('private.competency_eligible(public.applications,uuid)'::regprocedure) sql")).rows[0].sql;
 const recordBody=(await db.query("select prosrc from pg_proc where oid='exercise_ai.record_proposal(uuid,uuid,jsonb,integer)'::regprocedure")).rows[0].prosrc;
 const attempt=async()=>{
  await assert.rejects(e.install(),denied('55000'));await db.exec('rollback');
  assert.equal((await db.query("select prosrc from pg_proc where oid='exercise_ai.record_proposal(uuid,uuid,jsonb,integer)'::regprocedure")).rows[0].prosrc,recordBody);
 };
 await db.exec('create table public.c6_guard_drift(id uuid)');await attempt();await db.exec('drop table public.c6_guard_drift');
 await db.exec(original.replace('return d;','return d; -- unreviewed body'));await attempt();await db.exec(original);
 await db.exec('grant execute on function private.competency_eligible(public.applications,uuid) to authenticated');await attempt();
 await db.exec('revoke execute on function private.competency_eligible(public.applications,uuid) from authenticated');
 await e.install();
});
