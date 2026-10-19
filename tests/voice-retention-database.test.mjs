import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {bootRetention,voiceTables,sharedTables} from './helpers/voice-retention-fixture.mjs';
import {cancelOfflineVoicePreparation} from '../lib/voice/offline-preparation.ts';
import {users} from './helpers/screening-ranking-fixture.mjs';
import {lifecycleRules} from './helpers/erasure-lifecycle-fixture.mjs';

// Embedded is an explicit local contract run, never an implicit PG fallback.
// CI omits this switch and requires real loopback PostgreSQL for every test.
const embedded=process.env.VOICE_RETENTION_TEST_ENGINE==='pglite';
test('R4 voice graph uses existing signed purge/restore protocol',async t=>{
 const env=await bootRetention(t,{embedded}),{db,h,x}=env;
 await t.test('reviewed inventory and scheduler accept scoped voice; table, column and incoming FK drift deny',async()=>{
  const s=await env.ready();await h.asUser(s.f.owner);await x.policy(s.f,0,lifecycleRules);
  s.f.resolutionId=await x.resolve(s.f);await x.schedule(s.f);
  const preview=await x.preview(s.f,'confirmed_subject',s.f.resolutionId);
  assert.ok(!preview.blockers.includes('schema_dependency_unknown'));
  for(const table of voiceTables.slice(0,6))assert.ok(preview.counts[table]>0,table);
  assert.ok(!(await x.scheduleStatus(s.f)).blockers.includes('schema_dependency_unknown'));
  for(const ddl of [
   'create table public.unknown_voice_copy(candidate_id uuid)',
   'alter table private.voice_plan_request_keys add column shadow_candidate uuid',
   'create schema outside_voice; create table outside_voice.shadow(plan_id uuid references public.voice_plan_versions(id))',
  ]){
   await h.asAdmin();await db.exec('begin');
   try{await db.exec(ddl);await h.asUser(s.f.owner);assert.ok((await x.preview(s.f)).blockers.includes('schema_dependency_unknown'));assert.ok((await x.scheduleStatus(s.f)).blockers.includes('schema_dependency_unknown'));}
   finally{await db.exec('rollback');}
  }
 });
 await t.test('prepared reservation refunded once; all nine tables purged; shared FREE history remains',async()=>{
  const s=await env.ready();const operation=await env.prepare(s);
  await h.asAdmin();await db.query('insert into private.voice_interview_permission_revocations(company_id,receipt_id) values($1,$2)',[s.f.companyId,s.f.permissionReceiptId]);
  const shared={};for(const table of sharedTables.slice(0,3))shared[table]=(await db.query(`select to_jsonb(t) value from ${table} t order by to_jsonb(t)::text`)).rows;
  const before=await env.quota(s);const state=await env.erasing(s);
  const receipt=await x.purge(state.request_id,2);assert.ok(receipt.receipt_id);
  assert.deepEqual(await x.purge(state.request_id,2),receipt,'lost acknowledgment retry preserves receipt');
  for(const table of voiceTables)assert.equal(await env.count(table,s.f.companyId),0,table);
  const after=await env.quota(s);assert.equal(after.reserved,0);assert.equal(after.used,before.used);
  for(const key of ['id','company_id','package','total','grant_reference','created_at'])assert.deepEqual(after[key],before[key]);
  for(const table of sharedTables.slice(0,3))assert.deepEqual((await db.query(`select to_jsonb(t) value from ${table} t order by to_jsonb(t)::text`)).rows,shared[table]);
  assert.equal(await env.count('public.candidates',s.f.companyId),0);
  await assert.rejects(db.query(`insert into private.sc19_voice_entitlements select (jsonb_populate_record(null::private.sc19_voice_entitlements,$1)).*`,[JSON.stringify({...after,id:randomUUID(),grant_reference:randomUUID(),revision:1})]));
  assert.ok(operation.operationId);
 });
 await t.test('whole-person multi-candidate purge preserves same-company and foreign-company people and held units',async()=>{
  const a=await env.ready('PRESELEKCJA',5),b=await env.ready('PRESELEKCJA',5,{tenant:a.f,entitlementId:a.request.entitlementId});
  const survivor=await env.ready('PRESELEKCJA',5,{tenant:a.f,entitlementId:a.request.entitlementId});
  const foreign=await env.ready();for(const s of [a,b,survivor,foreign])await env.prepare(s);
  const state=await env.authorize(a,[a.f.candidate.id,b.f.candidate.id]);
  await x.transition(state.request_id,0,'authorized');await x.transition(state.request_id,1,'erasing');
  await x.purge(state.request_id,2);
  assert.equal((await env.quota(a)).reserved,1);assert.equal((await env.quota(foreign)).reserved,1);
  await h.asAdmin();assert.deepEqual((await db.query('select id from public.candidates where id=any($1::uuid[]) order by id',[[a.f.candidate.id,b.f.candidate.id,survivor.f.candidate.id,foreign.f.candidate.id]])).rows.map(r=>r.id).sort(),[survivor.f.candidate.id,foreign.f.candidate.id].sort());
  assert.equal(await env.count('private.sc010c_voice_preparations',a.f.companyId),1);
 });
 await t.test('cancelled operation does not refund twice; purge rollback restores rows and quota atomically',async()=>{
  const s=await env.ready(),operation=await env.prepare(s);await env.asServer(s.f.owner);
  await cancelOfflineVoicePreparation(db,s.context,operation.operationId);
  const quota=await env.quota(s);assert.equal(quota.reserved,0);
  const state=await env.erasing(s);await h.asAdmin();await db.exec('begin');
  await x.purge(state.request_id,2);await db.exec('rollback');
  assert.equal(await env.count('private.sc010c_voice_preparations',s.f.companyId),1);
  assert.deepEqual(await env.quota(s),quota);
  await x.purge(state.request_id,2);assert.deepEqual(await env.quota(s),quota);
 });
 await t.test('prepared rollback and mixed quota restore deny without taking another held reservation',async()=>{
  const s=await env.ready('PRESELEKCJA',3),other=await env.ready('PRESELEKCJA',3,{tenant:s.f,entitlementId:s.request.entitlementId});
  await env.prepare(s);await env.prepare(other);const state=await env.erasing(s);
  await h.asAdmin();await db.exec('begin');await x.purge(state.request_id,2);await db.exec('rollback');
  assert.equal((await env.quota(s)).reserved,2);assert.equal(await env.count('private.sc010c_voice_preparations',s.f.companyId),2);
  // Synthetic mixed-backup fault: restored operation data with newer counters.
  await db.query('update private.sc19_voice_entitlements set reserved=reserved-1 where id=$1',[s.request.entitlementId]);
  await assert.rejects(x.purge(state.request_id,2),e=>e.code==='PT409');
  assert.equal((await env.quota(s)).reserved,1);assert.equal(await env.count('private.sc010c_voice_preparations',s.f.companyId),2);
 });
 await t.test('ordinary roles, forged context and direct history deletion cannot invoke purge/refund or cross tenants',async()=>{
  const s=await env.ready(),foreign=await env.ready();await env.prepare(s);
  for(const role of ['anon','authenticated','screening_worker','contact_verifier','voice_permission_verifier','erasure_worker','erasure_scheduler','erasure_restore_attestor']){
   await h.asAdmin();await db.exec(`set role ${role}`);await db.query("select set_config('skillcheck.erasure_purge','true',false)");
   await assert.rejects(db.exec('insert into private.erasure_purge_context values(txid_current(),gen_random_uuid(),gen_random_uuid(),\'fake\',\'delete\')'));
   await assert.rejects(db.exec('select private.erasure_voice_refund_deleted()'));
   await assert.rejects(db.query('delete from private.sc010c_voice_preparations where company_id=$1',[s.f.companyId]));
  }
  await h.asAdmin();await assert.rejects(db.query('delete from public.voice_plan_versions where id=$1',[s.f.planId]));
  await assert.rejects(db.query('update private.voice_plan_request_keys set result_id=$1 where company_id=$2',[foreign.f.planReviewId,s.f.companyId]));
  await assert.rejects(db.query(`insert into private.voice_plan_request_keys(company_id,actor_id,operation,request_key,payload_hash,result_id,retention_policy_version,retention_deadline)
   values($1,$2,'review',$3,$4,$5,'test',clock_timestamp()+interval '1 day')`,[s.f.companyId,s.f.owner,randomUUID(),'a'.repeat(64),foreign.f.planReviewId]));
  await h.asUser(users.otherOwner);await assert.rejects(x.preview(s.f));
  assert.equal((await env.quota(s)).reserved,1);
 });
 await t.test('unknown/null request result blocks preview and signed execution; all operation mappings are typed',async()=>{
  const s=await env.ready();await h.asUser(s.f.owner);await x.policy(s.f,0,lifecycleRules);s.f.resolutionId=await x.resolve(s.f);
  await h.asAdmin();
  assert.equal((await db.query("select private.erasure_voice_request_candidate($1,'generate',$2) id",[s.f.companyId,s.f.planId])).rows[0].id,s.f.candidate.id);
  assert.equal((await db.query("select private.erasure_voice_request_candidate($1,'release',$2) id",[s.f.companyId,s.f.releaseId])).rows[0].id,s.f.candidate.id);
  assert.equal((await db.query("select private.erasure_voice_request_candidate($1,'generate',$2) id",[s.f.companyId,s.f.releaseId])).rows[0].id,null);
  // Model legacy malformed data with restored schema/guards intact afterwards.
  await db.exec('alter table private.voice_plan_request_keys disable trigger user');
  try{await db.query(`insert into private.voice_plan_request_keys values($1,$2,'generate',$3,$4,null,now(),'test',now()+interval '1 day')`,[s.f.companyId,s.f.owner,randomUUID(),'a'.repeat(64)]);}
  finally{await db.exec('alter table private.voice_plan_request_keys enable trigger user');}
  await h.asUser(s.f.owner);assert.ok((await x.preview(s.f)).blockers.includes('voice_request_adapter_unknown'));
  await assert.rejects(x.freeze(s.f));
 });
 await t.test('new activity advances existing clocks; exact prepared replay preserves clock and generation',async()=>{
  const s=await env.ready();const clock=async()=>{await h.asAdmin();return (await db.query('select * from private.retention_candidate_clocks where candidate_id=$1',[s.f.candidate.id])).rows[0];};
  const before=await clock();await env.prepare(s);const prepared=await clock();assert.ok(Number(prepared.generation)>Number(before.generation));
  await env.prepare(s);assert.deepEqual(await clock(),prepared);
  await h.asAdmin();await db.query('insert into private.voice_interview_permission_revocations(company_id,receipt_id) values($1,$2)',[s.f.companyId,s.f.permissionReceiptId]);
  assert.ok(Number((await clock()).generation)>Number(prepared.generation));
 });
 await t.test('normal stale current-release cleanup remains authorized without deleting immutable history',async()=>{
  const s=await env.ready();await h.asUser(s.f.owner);
  await db.query("update public.positions set title=title||' revised' where id=$1",[s.f.position.id]);
  await env.asServer(s.f.owner);
  assert.equal((await db.query('select private.sc012b_current_release($1) id',[s.f.application.id])).rows[0].id,null);
  assert.equal(await env.count('private.voice_plan_current_releases',s.f.companyId),0);
  assert.equal(await env.count('private.voice_plan_release_entries',s.f.companyId),1);
 });
 await t.test('all correction ancestry is removed in FK order without disabling constraints',async()=>{
  const s=await env.ready();await h.asAdmin();
  let planId=s.f.planId,reviewId=s.f.planReviewId;
  for(let version=2;version<=3;version++){
   const next=randomUUID(),hash=String(version).repeat(64);
   await db.query(`insert into public.voice_plan_versions select (jsonb_populate_record(null::public.voice_plan_versions,
    to_jsonb(p)||jsonb_build_object('id',$2::text,'supersedes_plan_id',p.id,'corrects_review_id',$3::text,'plan_version',$4::int,'source_hash',$5::text))).*
    from public.voice_plan_versions p where p.id=$1`,[planId,next,reviewId,version,hash]);
   reviewId=(await db.query(`insert into private.voice_plan_review_entries(company_id,application_id,plan_id,review_version,reviewer_id,decision,source_hash,retention_policy_version,retention_deadline)
    values($1,$2,$3,1,$4,'approved',$5,'test',clock_timestamp()+interval '1 day') returning id`,[s.f.companyId,s.f.application.id,next,s.f.owner,hash])).rows[0].id;
   planId=next;
  }
  const state=await env.erasing(s);const result=await x.purge(state.request_id,2);
  assert.equal(result.counts['public.voice_plan_versions'],3);
  assert.equal(result.counts['private.voice_plan_review_entries'],3);
 });

});


test('R4 voice signed-ledger restore re-erases coherent snapshots and preserves replay receipts',async t=>{
 const env=await bootRetention(t,{embedded}),{db,h,x}=env;
 const s=await env.ready('PRESELEKCJA',4),other=await env.ready('PRESELEKCJA',4,{tenant:s.f,entitlementId:s.request.entitlementId});
 await env.prepare(s);await env.prepare(other);
 let state;
 await h.asAdmin();await db.exec('begin');
 try{
  state=await env.erasing(s);await x.purge(state.request_id,2);await x.transition(state.request_id,2,'active_data_erased');
 }finally{await db.exec('rollback');}
 assert.equal((await env.quota(s)).reserved,2);
 await x.configure({restore_isolated:true});
 assert.equal((await x.replay()).replayed,1);
 assert.equal((await env.quota(s)).reserved,1);
 assert.equal(await env.count('private.sc010c_voice_preparations',s.f.companyId),1);
 await h.asAdmin();const receipt=(await db.query('select receipt_id,counts from private.erasure_executions where request_id=$1',[state.request_id])).rows[0];
 const quota=await env.quota(s),replayed=await x.replay();assert.equal(replayed.results[0].replay_noop,true);
 assert.deepEqual(await env.quota(s),quota);
 await h.asAdmin();assert.deepEqual((await db.query('select receipt_id,counts from private.erasure_executions where request_id=$1',[state.request_id])).rows[0],receipt);
 assert.equal((await db.query('select restore_isolated from private.erasure_execution_config where singleton')).rows[0].restore_isolated,true);
 // Unknown schema never becomes a trusted restore baseline.
 await db.exec('begin');try{
  await db.exec('create table public.unknown_restored_voice(candidate_id uuid)');
  await assert.rejects(x.replay());
 }finally{await db.exec('rollback');}
});


test('R4 voice installer removes hostile inherited helper and baseline privileges',async t=>{
 const roles=['authenticated','erasure_worker','voice_permission_verifier'];
 const env=await bootRetention(t,{embedded,beforeRetention:async db=>{
  for(const role of roles)await db.exec(`alter default privileges in schema private grant all on tables to ${role}; alter default privileges in schema private grant execute on functions to ${role}`);
 }});
 const {db,h}=env;await h.asAdmin();
 for(const role of roles){
  for(const fn of ['private.erasure_voice_request_candidate(uuid,text,uuid)','private.erasure_voice_row_guard()',
   'private.erasure_voice_refund_deleted()','private.erasure_voice_lock_entitlements(uuid)']){
   assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') allowed",[role,fn])).rows[0].allowed,false,role+fn);
  }
  for(const privilege of ['SELECT','INSERT','UPDATE','DELETE'])assert.equal((await db.query('select has_table_privilege($1,$2,$3) allowed',[role,'private.erasure_inventory_baseline_r4_voice',privilege])).rows[0].allowed,false);
 }
 const s=await env.ready();await env.prepare(s);const state=await env.erasing(s);await env.x.purge(state.request_id,2);
 assert.equal((await env.quota(s)).reserved,0);
});
