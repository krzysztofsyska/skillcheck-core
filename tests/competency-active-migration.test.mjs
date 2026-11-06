import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { activeBoot, c1Sql, b2Tables, users, hash, observations } from './helpers/competency-active-fixture.mjs';
import { lifecycleRules } from './helpers/erasure-lifecycle-fixture.mjs';
import { assertCurrentInventory, migrationManifest } from './helpers/sc19-migration-fixture.mjs';

const denied=e=>['PT404','42501'].includes(e.code);
const run=async(db,sql)=>{try{return await db.exec(sql);}catch(e){await db.exec('rollback');throw e;}};
const rollback=()=>readFile(new URL('../supabase/rollbacks/20261106063720_sc_wer_c1_inventory_r12_down.sql',import.meta.url),'utf8');
async function catalogSnapshot(db) {
 await db.exec("reset role;set search_path=''");
 const snapshot={signature:(await db.query('select private.erasure_schema_signature() value')).rows[0].value};
 for(const [name,sql] of Object.entries((await migrationManifest()).queries)) snapshot[name]=(await db.query(sql)).rows[0].digest;
 return snapshot;
}

test('C1: unused rollback restores R11; unsupported reinstallation stays atomic',async t=>{
 const {db}=await activeBoot(t,{install:false});const before=await catalogSnapshot(db);
 await run(db,await c1Sql());await run(db,await rollback());await assertCurrentInventory(db);
 assert.deepEqual(await catalogSnapshot(db),before,'rollback restores source function, policy and ACL contracts');
 // Dropped column numbers are not reusable in PostgreSQL. Reinstalling on that
 // physical layout requires a separately reviewed signature, never auto-learning.
 await assert.rejects(run(db,await c1Sql()),/sc_wer_final_schema_mismatch/);
 await assertCurrentInventory(db);
});

test('C1: full chain preserves R11, all inventory adapters and least privilege',async t=>{
 const {db,h}=await activeBoot(t,{fullChain:true});
 await assertCurrentInventory(db);
 assert.equal((await db.query('select schema_signature from private.erasure_inventory_baseline_r11')).rows[0].schema_signature,
  '0d22eb7a547b1f8838298b034d3d257ca4cba9e81430f5c6b20b9212e4d88b84');
 const old=(await db.query("select prosrc from pg_proc where oid='private.erasure_inventory_rows_r11(uuid,uuid[])'::regprocedure")).rows[0].prosrc;
 assert.match(old,/cv_bulk_items/);assert.match(old,/erasure_inventory_rows_r8/);
 for(const table of b2Tables) {
  assert.equal((await db.query('select relrowsecurity from pg_class where oid=$1::regclass',[table])).rows[0].relrowsecurity,true);
  for(const role of ['anon','authenticated','competency_test_gateway']) {
   assert.equal((await db.query("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') v",[role,table])).rows[0].v,false);
  }
 }
 await h.asAdmin();await assert.rejects(run(db,await c1Sql()),/sc_wer_already_installed/);
 await assertCurrentInventory(db);
});

for(const variant of ['relation','function','acl','config']) test(`C1: ${variant} drift fails atomically`,async t=>{
 const {db}=await activeBoot(t,{install:false});
 if(variant==='relation') await db.exec('create table public.unreviewed_candidate_data(id uuid)');
 if(variant==='function') await db.exec("create or replace function private.erasure_row_candidates(adapter text,data jsonb) returns uuid[] language sql security definer set search_path='' as $$select array[]::uuid[]$$");
 if(variant==='acl') await db.exec('grant execute on function private.erasure_inventory_rows(uuid,uuid[]) to anon');
 if(variant==='config') await db.exec("alter function private.erasure_inventory_rows(uuid,uuid[]) set search_path='public'");
 const before=await catalogSnapshot(db);
 await assert.rejects(run(db,await c1Sql()),/sc_wer_source_(schema|function|privileges)_unreviewed/);
 assert.deepEqual(await catalogSnapshot(db),before);
 assert.equal((await db.query("select to_regclass('private.competency_test_grants') v")).rows[0].v,null);
});

test('C1: SQL shortlist gate, capability exchange, evidence review and tenant isolation',async t=>{
 const e=await activeBoot(t),{db,h,seed,issue,call,asGateway}=e;
 const notSelected=await seed({shortlist:false});await assert.rejects(issue(notSelected),denied);
 const {f,g,s,a}=await e.submitted();
 await h.asUser(users.otherOwner);await assert.rejects(call('public.read_competency_test_response',[a.attemptId]),denied);
 await h.asUser(f.owner);
 await call('public.save_competency_test_review',[a.attemptId,0,JSON.stringify(observations)]);
 const response=await call('public.read_competency_test_response',[a.attemptId]);
 assert.match(response.workSample,/Plan/);assert.equal(Number(response.reviews[0].coverage),0.5);
 assert.equal(response.reviews[0].status,'insufficient_evidence');
 await assert.rejects(call('public.save_competency_test_review',[a.attemptId,0,JSON.stringify(observations)]),e=>e.code==='PT409');
 await h.remove(f.shortlistId);
 await assert.rejects(issue(f,{key:g.key,startBy:g.startBy}),denied);
 await assert.rejects(call('public.rotate_competency_test_grant',[g.grantId,1,randomUUID()]),denied);
 await asGateway();await assert.rejects(call('private.status_candidate_competency_test',[hash(s.session)]),denied);
 await assert.rejects(e.exchange(g),denied);
 await h.asUser(f.owner);assert.equal((await call('public.revoke_competency_test_grant',[g.grantId,randomUUID()])).revoked,true);
 await h.asAdmin();
 assert.equal((await db.query('select count(*)::int n from private.competency_test_grants where application_id=$1',[notSelected.application.id])).rows[0].n,0);
});

test('C1: rotation kills old capabilities, TTL and withdrawal block every later use',async t=>{
 const e=await activeBoot(t),{db,h,call,asGateway}=e;
 const {f,g,s}=await e.started();
 await h.asAdmin();await assert.rejects(run(db,await rollback()),/sc_wer_rollback_data_present/);
 await h.asUser(f.owner);
 const rotated=await call('public.rotate_competency_test_grant',[g.grantId,1,randomUUID()]);
 await asGateway();await assert.rejects(call('private.inspect_candidate_competency_test',[hash(s.session)]),denied);
 await assert.rejects(e.exchange(g),denied);
 const next=await e.exchange(rotated);
 await assert.rejects(e.exchange(rotated),denied);
 await h.asAdmin();await db.query("update private.competency_test_sessions set idle_expires_at=clock_timestamp()-interval '1 second' where session_digest=$1",[hash(next.session)]);
 await asGateway();await assert.rejects(call('private.inspect_candidate_competency_test',[hash(next.session)]),denied);
 const fresh=await e.started();await h.asUser(fresh.f.owner);
 await call('public.withdraw_competency_test_access',[JSON.stringify({kind:'application',application_id:fresh.f.application.id,reason:'candidate_withdrawn'}),randomUUID()]);
 await asGateway();await assert.rejects(call('private.start_candidate_competency_test',[hash(fresh.s.session),randomUUID()]),denied);
 await h.asUser(fresh.f.owner);await assert.rejects(call('public.read_competency_test_response',[fresh.a.attemptId]),denied);
});

test('C1: multi-subject cancellations block a partial manifest and forged tenant references',async t=>{
 const e=await activeBoot(t),{db,h,x,call}=e;await x.configure();
 const a=await e.started(),b=await e.started({tenant:a.f}),other=await e.started({owner:users.otherOwner});
 await h.asUser(a.f.owner);await x.policy(a.f,0,lifecycleRules);
 a.f.resolutionId=await x.resolve(a.f,[a.f.candidate.id,b.f.candidate.id]);
 await call('public.withdraw_competency_test_access',[JSON.stringify({kind:'confirmed_subject',resolution_id:a.f.resolutionId,resolution_revision:1,reason:'consent_withdrawn'}),randomUUID()]);
 const partial=await call('public.preview_candidate_erasure',[a.f.candidate.id,'candidate_record',null]);
 assert.ok(partial.blockers.includes('shared_competency_cancellation_requires_adapter'));
 const full=await x.preview(a.f,'confirmed_subject',a.f.resolutionId);assert.equal(full.blockers.includes('shared_competency_cancellation_requires_adapter'),false);
 await assert.rejects(x.resolve(a.f,[a.f.candidate.id,other.f.candidate.id],1),denied);
 await h.asAdmin();
 await assert.rejects(db.query(`insert into private.competency_test_cancellations(company_id,candidate_ids,scope_kind,reason,actor_id,request_key)
 values($1,$2,'confirmed_subject','consent_withdrawn',$3,$4)`,[a.f.companyId,[a.f.candidate.id,other.f.candidate.id],a.f.owner,randomUUID()]),e=>['PT409','PT404','42501'].includes(e.code));
});

test('C1: preview/purge includes all seven surfaces and preserves the other tenant',async t=>{
 const e=await activeBoot(t),{db,h,x,call}=e;await x.configure();
 const target=await e.submitted(),survivor=await e.submitted({owner:users.otherOwner});
 await h.asUser(target.f.owner);await call('public.save_competency_test_review',[target.a.attemptId,0,JSON.stringify(observations)]);
 // A second, in-progress definition provides a retained draft in the same subject graph.
 const second=await e.started({tenant:target.f});
 await call('private.save_candidate_competency_test_draft',[hash(second.s.session),'Plan draft',0,randomUUID()]);
 await h.asUser(target.f.owner);
 await call('public.withdraw_competency_test_access',[JSON.stringify({kind:'application',application_id:target.f.application.id,reason:'candidate_withdrawn'}),randomUUID()]);
 await x.policy(target.f,0,lifecycleRules);
 target.f.resolutionId=await x.resolve(target.f,[target.f.candidate.id,second.f.candidate.id]);
 const preview=await x.preview(target.f,'confirmed_subject',target.f.resolutionId);
 assert.equal(preview.blockers.includes('schema_dependency_unknown'),false);
 for(const table of b2Tables) assert.ok(Number(preview.counts[table])>0,table);
 const state=await x.freeze(target.f);await x.transition(state.request_id,0,'authorized');await x.transition(state.request_id,1,'erasing');
 await x.purge(state.request_id,2);
 await h.asAdmin();
 for(const table of b2Tables) assert.equal((await db.query(`select count(*)::int n from ${table} where company_id=$1`,[target.f.companyId])).rows[0].n,0,table);
 assert.equal((await db.query('select count(*)::int n from public.competency_test_attempts where company_id=$1',[survivor.f.companyId])).rows[0].n,1);
 // Purge replay returns the persisted receipt and never re-erases other subjects.
 await h.asUser(target.f.owner);const replay=await x.purge(state.request_id,2);assert.equal(replay.phase,'active_data_erased');
});
