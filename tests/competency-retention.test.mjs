import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {boot,b2Tables,hash,observations} from './helpers/competency-attempt-fixture.mjs';
import {lifecycleRules} from './helpers/erasure-lifecycle-fixture.mjs';
import {behaviorGuideDefinitions} from '../lib/behavior-guide.ts';

const baseline='private.erasure_inventory_baseline_sc014_b2_v1';
test('SC014-B2 explicit retention graph, freeze, signed purge and replay',async t=>{
 const env=await boot(t),{db,h,x,call}=env;
 const counts=async f=>{await h.asAdmin();const result={};for(const table of b2Tables)
  result[table]=(await db.query(`select count(*)::int n from ${table} where company_id=$1`,[f.companyId])).rows[0].n;
  return result;
 };
 const generation=async f=>{await h.asAdmin();return Number((await db.query('select generation from private.retention_candidate_clocks where candidate_id=$1',[f.candidate.id])).rows[0].generation);};
 await t.test('literal composition matches; known tables preserve earlier baselines and voice/billing',async()=>{
  await h.asAdmin();const state=(await db.query(`select schema_signature,private.erasure_schema_signature() actual,known_tables from ${baseline}`)).rows[0];
  assert.equal(state.schema_signature,state.actual);
  for(const table of [...b2Tables,'private.erasure_inventory_baseline_r5','private.sc19_credit_journal','private.sc19_package_policy','private.sc010c_voice_preparations'])assert.ok(state.known_tables.includes(table));
  const previous=(await db.query('select schema_signature from private.erasure_inventory_baseline_r5')).rows[0];
  assert.equal(previous.schema_signature,'c989b84b9eec51fc48c361b8ad9e7404b4044268d56d106b6788fe56f3f1857d');
 });
 await t.test('candidate markers, tokens, session hashes, drafts and review evidence are inventoried; foreign tenant excluded',async()=>{
  const s=await env.submitted(),draft=await env.started({tenant:s.f}),foreign=await env.started();
  await call('private.save_candidate_competency_test_draft',[hash(foreign.s.session),'foreign confidential',0,randomUUID()]);
  await env.asGateway();await call('private.save_candidate_competency_test_draft',[hash(draft.s.session),'draft confidential',0,randomUUID()]);
  await h.asUser(s.f.owner);await call('public.save_competency_test_review',[s.a.attemptId,0,JSON.stringify(observations)]);
  const before=await generation(s.f);
  await h.asUser(s.f.owner);
  await call('public.withdraw_competency_test_access',[JSON.stringify({kind:'application',application_id:s.f.application.id,reason:'candidate_withdrawn'}),randomUUID()]);
  assert.ok(await generation(s.f)>before);
  await h.asAdmin();const rows=(await db.query('select * from private.erasure_inventory_rows($1,$2::uuid[])',[s.f.companyId,[s.f.candidate.id,draft.f.candidate.id]])).rows;
  for(const table of b2Tables)assert.ok(rows.some(r=>r.adapter===table),table);
  assert.ok(rows.every(r=>r.row_data.company_id===s.f.companyId));
  assert.ok(rows.every(r=>r.adapter!=='private.sc19_package_policy'),'global package policy is not a candidate purge adapter');
  assert.ok(rows.find(r=>r.adapter==='public.applications'&&r.row_key===s.f.application.id).row_data.competency_access_cancelled_at);
  assert.equal(rows.find(r=>r.adapter==='private.competency_test_drafts').row_data.draft_text,'draft confidential');
  const all=await counts(s.f);assert.equal(all['private.competency_test_sessions'],2);assert.equal(all['private.competency_test_cancellations'],1);
  await h.asAdmin();await db.query('select private.sc19_grant_paid($1,$2)',[s.f.companyId,'synthetic-b2-retention-settlement']);
  const required=behaviorGuideDefinitions.map((area,index)=>area.label+': '+(index<4?'Wysoki':'Standardowy'));
  s.f.position=(await db.query('update public.positions set required_behaviors=$1 where id=$2 returning *',[required,s.f.position.id])).rows[0];
  await env.permission.contact.register(s.f);
  const voice=await env.ready('PRESELEKCJA',4,{tenant:s.f});await env.prepare(voice);const quota=await env.quota(voice);
  await h.asAdmin();
  const packagePolicy=(await db.query('select * from private.sc19_package_policy order by plan')).rows;
  const billing=(await db.query('select to_jsonb(b) row from private.sc19_balances b where company_id=$1',[s.f.companyId])).rows;
  const journal=(await db.query('select to_jsonb(j) row from private.sc19_credit_journal j where company_id=$1 order by id',[s.f.companyId])).rows;
  const state=await env.authorize(s,[s.f.candidate.id,draft.f.candidate.id]);
  await env.asGateway();await assert.rejects(call('private.status_candidate_competency_test',[hash(s.s.session)]));
  await assert.rejects(call('private.save_candidate_competency_test_draft',[hash(draft.s.session),'post freeze',1,randomUUID()]));
  await x.transition(state.request_id,0,'authorized');await x.transition(state.request_id,1,'erasing');
  const purged=await x.purge(state.request_id,2);
  for(const table of b2Tables)assert.equal(purged.counts[table],all[table],table);
  assert.deepEqual(await counts(s.f),Object.fromEntries(b2Tables.map(table=>[table,0])));
  assert.equal((await counts(foreign.f))['private.competency_test_drafts'],1);
  assert.deepEqual(await env.quota(voice),quota);
  await h.asAdmin();assert.equal((await db.query('select count(*)::int n from private.sc010c_voice_preparations where candidate_id=$1',[voice.f.candidate.id])).rows[0].n,1);
  assert.deepEqual((await db.query('select * from private.sc19_package_policy order by plan')).rows,packagePolicy);
  assert.deepEqual((await db.query('select to_jsonb(b) row from private.sc19_balances b where company_id=$1',[s.f.companyId])).rows,billing);
  assert.deepEqual((await db.query('select to_jsonb(j) row from private.sc19_credit_journal j where company_id=$1 order by id',[s.f.companyId])).rows,journal);
  await x.transition(state.request_id,2,'active_data_erased');
 });
 await t.test('restore re-erases full B2 snapshot, never reopens sessions; replay remains idempotent',async()=>{
  const s=await env.submitted();await h.asUser(s.f.owner);
  await call('public.save_competency_test_review',[s.a.attemptId,0,JSON.stringify(observations)]);
  await h.asAdmin();await db.exec('begin');let state;
  try{
   state=await env.erasing(s);await x.purge(state.request_id,2);await x.transition(state.request_id,2,'active_data_erased');
  }finally{await db.exec('rollback');}
  assert.equal((await counts(s.f))['public.competency_test_attempts'],1);
  await x.configure({restore_isolated:true});
  await env.asGateway();await assert.rejects(call('private.status_candidate_competency_test',[hash(s.s.session)]));
  assert.ok((await x.replay()).replayed>=1);
  assert.deepEqual(await counts(s.f),Object.fromEntries(b2Tables.map(table=>[table,0])));
  assert.ok((await x.replay()).results.every(r=>r.replay_noop));
  await env.asGateway();await assert.rejects(call('private.status_candidate_competency_test',[hash(s.s.session)]));
  await h.asAdmin();assert.equal((await db.query('select restore_isolated from private.erasure_execution_config where singleton')).rows[0].restore_isolated,true);
  await x.configure();
 });
 await t.test('legal hold preserves B2 until owner release, then authorized purge removes it',async()=>{
  const s=await env.started(),state=await env.authorize(s);
  await x.transition(state.request_id,0,'authorized');await h.asUser(s.f.owner);
  const hold=(await db.query("select public.set_candidate_erasure_hold($1,'owner_review',clock_timestamp()+interval '1 day',clock_timestamp()+interval '2 days',$2) id",[state.request_id,randomUUID()])).rows[0].id;
  await assert.rejects(x.reserve(state.request_id,1,'erasing'),e=>e.code==='PT409');
  assert.equal((await counts(s.f))['private.competency_test_sessions'],1);
  await h.asUser(s.f.owner);await call('public.release_candidate_erasure_hold',[hold]);
  await x.transition(state.request_id,1,'erasing');await x.purge(state.request_id,2);
  assert.deepEqual(await counts(s.f),Object.fromEntries(b2Tables.map(table=>[table,0])));
 });
 await t.test('schema drift blocks preview and signing instead of becoming a new baseline',async()=>{
  const f=await env.seed();await h.asUser(f.owner);await x.policy(f,0,lifecycleRules);f.resolutionId=await x.resolve(f);
  await h.asAdmin();await db.exec('begin');
  try{
   await db.exec('create table public.unknown_competency_data(candidate_id uuid)');
   await h.asUser(f.owner);assert.ok((await x.preview(f)).blockers.includes('schema_dependency_unknown'));
   await assert.rejects(x.freeze(f));
  }finally{await db.exec('rollback');}
 });
 await t.test('ordinary SQL cannot forge purge context or modify new baseline',async()=>{
  const s=await env.started();
  for(const role of ['anon','authenticated','competency_test_gateway','erasure_worker']) {
   await h.asAdmin();await db.exec(`set role ${role}`);
   await assert.rejects(db.exec("insert into private.erasure_purge_context values(txid_current(),gen_random_uuid(),gen_random_uuid(),'forged','delete')"));
   await assert.rejects(db.exec(`update ${baseline} set schema_signature='forged'`));
   for(const table of b2Tables)await assert.rejects(db.query(`delete from ${table} where company_id=$1`,[s.f.companyId]));
  }
  await h.asAdmin();assert.equal((await counts(s.f))['private.competency_test_grants'],1);
 });
});
