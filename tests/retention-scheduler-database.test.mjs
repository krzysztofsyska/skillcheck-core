import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {setupRankingDatabase,users} from './helpers/screening-ranking-fixture.mjs';
import {retentionHarness} from './helpers/retention-scheduler-fixture.mjs';
import {setupExecutionLedger} from './helpers/erasure-execution-fixture.mjs';
import {assertAcceptedErasureSchema} from './helpers/erasure-preview-fixture.mjs';
const conflict=e=>e.code==='PT409';

test('SC-010 R4 server-clock retention through the real signed erasure ledger',async t=>{
 const db=new PGlite({extensions:{pgcrypto}}),ledgerDb=new PGlite();t.after(()=>db.close());t.after(()=>ledgerDb.close());
 const h=await setupRankingDatabase(db),x=await setupExecutionLedger(retentionHarness(h),ledgerDb);
 await assertAcceptedErasureSchema(h,t);await x.configure();
 await t.test('owner-only activation is versioned and scheduler has no owner, DML, ACK or purge capability',async()=>{
  const f=await x.ready();const key=randomUUID();await h.asUser(f.owner);
  const id=await x.schedule(f,'suggest_only',0,1,key);assert.equal(await x.schedule(f,'suggest_only',0,1,key),id);
  await assert.rejects(x.schedule(f,'automatic',0,1,key),conflict);
  for(const actor of [users.otherOwner,users.recruiter,users.viewer,users.outsider]){await h.asUser(actor);await assert.rejects(x.schedule(f));await assert.rejects(x.scheduleStatus(f));}
  await h.asAdmin();await db.exec('set role erasure_scheduler');
  for(const sql of ['select public.get_retention_schedule($1)','select public.configure_retention_schedule($1,0,1)','delete from private.retention_candidate_clocks where candidate_id=$1','select private.purge_candidate_erasure($1,0)','select private.get_erasure_reservation_binding($1)'])await assert.rejects(db.query(sql,[f.companyId]),e=>e.code==='42501');
  await h.asUser(f.owner);await x.revoke(f);
 });
 await t.test('suggest-only deduplicates due scopes without creating lifecycle authority',async()=>{
  const f=await x.ready();await x.close(f);await h.asUser(f.owner);await x.schedule(f);await x.age(f);
  const first=await x.tick();assert.ok(first.results.some(r=>r.status==='suggested'));
  await x.tick();await h.asUser(f.owner);const state=await x.scheduleStatus(f);assert.equal(state.suggestions,1);assert.equal(state.authorized,0);
  const suggestions=(await db.query('select public.get_retention_suggestions($1,null,null,25) value',[f.companyId])).rows[0].value;assert.equal(suggestions.length,1);assert.ok(JSON.stringify(suggestions).includes(f.candidate.id));await h.asUser(users.otherOwner);await assert.rejects(db.query('select public.get_retention_suggestions($1,null,null,25)',[f.companyId]));await h.asUser(f.owner);assert.equal(await x.status(f),null);
  assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1',[f.candidate.id])).rows[0].n,1);await x.revoke(f);
 });
 await t.test('automatic due produces delegated signed authority and removes its graph while preserving another tenant',async()=>{
  const f=await x.ready(),other=await x.ready({owner:users.otherOwner});await x.close(f);await h.asUser(f.owner);await x.schedule(f,'automatic');await x.age(f);
  const tick=await x.tick(),result=tick.results.find(r=>r.request_id);assert.ok(result?.request_id,JSON.stringify(tick));
  await x.tick();await h.asUser(f.owner);assert.equal((await x.scheduleStatus(f)).authorized,1);
  const reserved=await x.reserve(result.request_id,0,'authorized'),envelope=JSON.parse(reserved.envelope_text);assert.equal(envelope.authorization.kind,'retention_policy');assert.equal(envelope.authorization.actor_id,f.owner);
  await x.ack(reserved);await x.transition(result.request_id,1,'erasing');await x.purge(result.request_id,2);await x.transition(result.request_id,2,'active_data_erased');
  await h.asAdmin();for(const table of ['public.candidates','private.retention_candidate_clocks'])assert.equal((await db.query(`select count(*)::int n from ${table} where ${table.endsWith('candidates')?'id':'candidate_id'}=$1`,[f.candidate.id])).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1',[other.candidate.id])).rows[0].n,1);
  assert.notEqual((await x.requestStatus(f,result.request_id)).status,'completed');
 });

 for(const status of ['new','in_progress','hired'])await t.test(`a ${status} application anywhere in the confirmed subject blocks automatic retention`,async()=>{
  const f=await x.ready(),second=await h.candidate(f);await h.asUser(f.owner);f.resolutionId=await x.resolve(f,[f.candidate.id,second.candidate.id],1);
  await x.close(f);await db.query('update public.applications set status=$1 where id=$2',[status,second.application.id]);await x.schedule(f,'automatic');await x.age(f,[f.candidate.id,second.candidate.id]);
  const tick=await x.tick();assert.ok(tick.results.some(r=>r.blockers?.includes('active_purpose')),JSON.stringify(tick));await h.asUser(f.owner);assert.equal(await x.status(f),null);await x.revoke(f);
 });
 await t.test('client backdated data and reopening reset eligibility instead of inheriting an old deadline',async()=>{
  const f=await x.ready();await x.close(f);await h.asUser(f.owner);await x.schedule(f,'automatic');await x.age(f);
  await h.asUser(f.owner);await assert.rejects(db.query("insert into public.candidate_documents(company_id,candidate_id,source_text,created_at) values($1,$2,'forged date','2000-01-01')",[f.companyId,f.candidate.id]),e=>e.code==='42501');await h.asAdmin();await db.query("insert into public.candidate_documents(company_id,candidate_id,source_text,redacted_text,created_at) values($1,$2,'new data','new sanitized data','2000-01-01')",[f.companyId,f.candidate.id]);
  let tick=await x.tick();assert.ok(tick.results.some(r=>r.blockers?.includes('retention_not_due')),JSON.stringify(tick));await h.asUser(f.owner);assert.equal(await x.status(f),null);
  await x.age(f);await h.asUser(f.owner);await db.query("update public.recruitments set status='open' where id=$1",[f.recruitment.id]);await db.query("update public.recruitments set status='closed' where id=$1",[f.recruitment.id]);
  tick=await x.tick();assert.ok(tick.results.some(r=>r.blockers?.includes('retention_not_due')));await h.asUser(f.owner);await x.revoke(f);
 });
 await t.test('missing canonical history for one subject member never inherits another member clock',async()=>{
  const f=await x.ready(),second=await h.candidate(f);await x.close(f);await x.close(second);await h.asUser(f.owner);f.resolutionId=await x.resolve(f,[f.candidate.id,second.candidate.id],1);await x.schedule(f,'automatic');await x.age(f,[f.candidate.id,second.candidate.id]);
  await h.asAdmin();await db.query('delete from private.retention_candidate_clocks where candidate_id=$1',[second.candidate.id]);const tick=await x.tick();assert.ok(tick.results.some(r=>r.blockers?.includes('canonical_event_missing')),JSON.stringify(tick));await h.asUser(f.owner);assert.equal(await x.status(f),null);await x.revoke(f);
 });
 await t.test('process and consent event policies require their own complete canonical evidence',async()=>{
  for(const trigger of ['process_closed','consent_revoked']){
   const f=await x.ready();await x.close(f);await h.asUser(f.owner);const policy=await x.getPolicy(f);await x.policy(f,1,policy.rules.map(rule=>({...rule,trigger_event:trigger})));await x.schedule(f,'suggest_only',0,2);await x.age(f);
   const first=await x.tick();assert.ok(first.results.some(r=>r.blockers?.includes(trigger==='process_closed'?'retention_not_due':'canonical_event_missing')),JSON.stringify(first));
   if(trigger==='process_closed'){await x.age(f);const aged=await x.tick();assert.ok(aged.results.some(r=>r.status==='suggested'));}
   await h.asUser(f.owner);assert.equal(await x.status(f),null);await x.revoke(f);
  }
 });
 await t.test('revocation after automatic freeze prevents first erasing without silently unfreezing',async()=>{
  const f=await x.ready();await x.close(f);await h.asUser(f.owner);await x.schedule(f,'automatic');await x.age(f);const result=(await x.tick()).results.find(r=>r.request_id);assert.ok(result);
  await x.transition(result.request_id,0,'authorized');await h.asUser(f.owner);await x.revoke(f);await assert.rejects(x.reserve(result.request_id,1,'erasing'),conflict);
  await h.asUser(f.owner);assert.equal((await x.status(f)).status,'authorized');
 });
 await t.test('changed company owner cannot inherit a prior automatic delegation before first erasing',async()=>{
  const f=await x.ready();await x.close(f);await h.asUser(f.owner);await x.schedule(f,'automatic');await x.age(f);const result=(await x.tick()).results.find(r=>r.request_id);assert.ok(result);await x.transition(result.request_id,0,'authorized');
  await h.asAdmin();await assert.rejects(db.query('update public.companies set owner_id=$1 where id=$2',[users.otherOwner,f.companyId]),conflict);
  // A restored stale ownership row is a separate privileged fault; the worker must still recheck it.
  await db.exec('alter table public.companies disable trigger user');try{await db.query('update public.companies set owner_id=$1 where id=$2',[users.otherOwner,f.companyId]);}finally{await db.exec('alter table public.companies enable trigger user');}await assert.rejects(x.reserve(result.request_id,1,'erasing'),conflict);
 });
 await t.test('bounded ticks eventually examine every stable blocked subject beyond one batch',async()=>{
  const f=await x.ready(),second=await h.candidate(f),third=await h.candidate(f);await h.asUser(f.owner);await x.resolve(second);await x.resolve(third);await x.schedule(f);
  for(let i=0;i<6;i++)await x.tick(1);
  await h.asAdmin();assert.equal((await db.query('select count(distinct resolution_id)::int n from private.retention_suggestions where company_id=$1',[f.companyId])).rows[0].n,3);await h.asUser(f.owner);await x.revoke(f);
 });
 await t.test('new shared assessment definition starts a fresh observed retention period',async()=>{
  const f=await x.ready();await x.close(f);await h.asUser(f.owner);await x.schedule(f,'automatic');await x.age(f);await h.asUser(f.owner);
  await h.insert('assessment_stages',{company_id:f.companyId,recruitment_id:f.recruitment.id,name:'New evaluation stage',sequence:1});const tick=await x.tick();assert.ok(tick.results.some(r=>r.blockers?.includes('retention_not_due')),JSON.stringify(tick));await h.asUser(f.owner);assert.equal(await x.status(f),null);await x.revoke(f);
 });
 await t.test('unmapped provider resources block automatic authorization before any freeze',async()=>{
  const f=await x.ready({rich:true});await x.close(f);await h.asAdmin();await db.query('update public.screening_analysis_attempts set provider_response_id=$1 where id=$2',['synthetic-unmapped-resource',f.attempt_id]);await h.asUser(f.owner);await x.schedule(f,'automatic');await x.age(f);
  const tick=await x.tick();assert.equal(tick.authorized,0);await h.asUser(f.owner);assert.equal(await x.status(f),null);await x.revoke(f);
 });
 await t.test('pending erasing retries preserve the reserved authority after independent contact denial',async()=>{
  const f=await x.ready();await x.close(f);await h.asUser(f.owner);await x.schedule(f,'automatic');await x.age(f);const request=(await x.tick()).results.find(r=>r.request_id)?.request_id;assert.ok(request);await x.transition(request,0,'authorized');const key=randomUUID(),reserved=await x.reserve(request,1,'erasing',key);
  await h.asUser(f.owner);await x.v.permission(f,'revoked');assert.deepEqual(await x.reserve(request,1,'erasing',key),reserved);await x.ack(reserved);await assert.rejects(x.purge(request,2),conflict);await x.transition(request,2,'erasing');await x.purge(request,3);
 });
 await t.test('signed delegated purge restores from a backup preceding policy and schedule activation',async()=>{
  await x.configure();const f=await h.seed(),independent=new PGlite();t.after(()=>independent.close());const restore=await setupExecutionLedger(retentionHarness(h),independent);let request;
  await h.asAdmin();await db.exec('begin');try{
   await h.asUser(f.owner);await restore.policy(f,0,(await import('./helpers/erasure-lifecycle-fixture.mjs')).lifecycleRules);f.resolutionId=await restore.resolve(f);await restore.close(f);await restore.schedule(f,'automatic');await restore.age(f);
   request=(await restore.tick()).results.find(r=>r.request_id)?.request_id;assert.ok(request);await restore.transition(request,0,'authorized');await restore.transition(request,1,'erasing');await restore.purge(request,2);await restore.transition(request,2,'active_data_erased');
  }finally{await db.exec('rollback');}
  await restore.configure({restore_isolated:true});const replay=await restore.replay();assert.equal(replay.replayed,1);assert.equal(replay.verifiedEvents,3);await h.asAdmin();assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1',[f.candidate.id])).rows[0].n,0);await restore.configure();
 });
});
