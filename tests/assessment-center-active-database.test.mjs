import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { acBoot, acMigration, acSignature, acSheet, acDefinition, users } from './helpers/assessment-center-active-fixture.mjs';
import { lifecycleRules } from './helpers/erasure-lifecycle-fixture.mjs';
import { parseAssessmentCenterPair } from '../lib/assessment-center-pair.ts';
const denied = (...codes) => error => codes.includes(error.code);

test('AC active R13: two independent assessments and candidate lifecycle on the current chain', async t => {
 const e=await acBoot(t),{db,h,x}=e;
 await t.test('reviewed signature, exact allowlist, four readers and complete R12 delegation are preserved',async()=>{
  await h.asAdmin();
  const baseline=(await db.query('select *,private.erasure_schema_signature() actual from private.erasure_inventory_baseline_r13')).rows[0];
  assert.equal(baseline.actual,acSignature);assert.equal(baseline.schema_signature,acSignature);
  const actual=(await db.query("select n.nspname||'.'||c.relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f')")).rows.map(r=>r.name);
  assert.deepEqual(actual.sort(),baseline.known_tables.sort());
  for(const name of ['preview_candidate_erasure','prepare_erasure_purge_manifest','authorize_retention_suggestion','get_retention_schedule']){
   assert.equal((await db.query("select count(*)::int n from pg_proc where proname=$1 and prosrc like '%erasure_inventory_baseline_r13%'",[name])).rows[0].n,1);
  }
  for(const name of ['erasure_inventory_rows_r12','erasure_inventory_rows_r11','erasure_inventory_rows_r8','erasure_row_candidates_r12','erasure_row_candidates_r11','erasure_row_candidates_r8']){
   assert.equal((await db.query('select count(*)::int n from pg_proc where proname=$1',[name])).rows[0].n,1,name);
  }
  assert.deepEqual((await db.query("select relrowsecurity rls,has_table_privilege('authenticated',oid,'select') staff,has_table_privilege('anon',oid,'select') anon from pg_class where oid='private.ac_paired_sheets'::regclass")).rows[0],{rls:true,staff:false,anon:false});
  for(const name of ['ac_assign_pair','ac_find_pair','ac_read_pair','ac_submit_sheet']){
   assert.deepEqual((await db.query("select prosecdef definer,proconfig config,has_function_privilege('anon',oid,'execute') anon,has_function_privilege('authenticated',oid,'execute') staff from pg_proc where proname=$1",[name])).rows[0],{definer:true,config:['search_path=""'],anon:false,staff:true});
  }
  execFileSync(process.execPath,['scripts/sc-ac-compose.mjs','--check']);
 });
 const f=await e.seed(),other=await e.seed({owner:users.otherOwner});
 await t.test('definition → criteria/scales → immutable submissions → attributed evidence report; neither assessor sees the first sheet',async()=>{
  await h.asUser(f.owner);f.pairId=await e.assign(f);
  assert.equal(await e.find(f),f.pairId);
  await e.submit(f.pairId);
  assert.deepEqual(await e.read(f.pairId),{state:'pending',ownSubmitted:true});
  await assert.rejects(e.submit(f.pairId),denied('PT409'));
  await h.asUser(users.recruiter);
  assert.deepEqual(await e.read(f.pairId),{state:'pending',ownSubmitted:false});
  await assert.rejects(db.query('select * from private.ac_paired_sheets'),denied('42501'));
  const second=acSheet();second[0].rating='above';second[0].evidence='  Podsumował potrzeby klienta.  ';
  await e.submit(f.pairId,second);
  const report=parseAssessmentCenterPair(f.definitionId,f.definition,await e.read(f.pairId));
  assert.equal(report.state,'ready');assert.deepEqual(report.sheets.map(s=>s.authorId),[f.owner,users.recruiter]);
  assert.equal(report.sheets[1].evaluation.criteria[0].evidence,second[0].evidence.trim());
  assert.equal(report.sheets[0].evaluation.criteria[0].context,acSheet()[0].context);
  assert.equal(report.sheets[0].evaluation.criteria[1].rating,'insufficient_data');
  assert.ok(report.sheets.every(s=>Number.isFinite(Date.parse(s.submittedAt))));
  assert.equal('hiringDecision' in report,false);assert.equal('score' in report,false);
 });
 await t.test('foreign tenant, viewer, unknown IDs and revoked memberships cannot read or mutate assessments',async()=>{
  await h.asUser(f.owner);await h.insert('company_members',{company_id:f.companyId,user_id:users.viewer,role:'viewer'});
  for(const user of [other.owner,users.viewer,users.outsider]){
   await h.asUser(user);assert.equal(await e.find(f),null);
   await assert.rejects(e.read(f.pairId),denied('42501'));await assert.rejects(e.submit(f.pairId),denied('42501'));
   await assert.rejects(e.assign(f),denied('42501','PT404'));
  }
  await h.asUser(f.owner);await db.query('delete from public.company_members where company_id=$1 and user_id=$2',[f.companyId,users.recruiter]);
  await h.asUser(users.recruiter);assert.equal(await e.find(f),null);await assert.rejects(e.read(f.pairId),denied('42501'));
  await h.asUser(f.owner);await h.insert('company_members',{company_id:f.companyId,user_id:users.recruiter,role:'recruiter'});
  await assert.rejects(e.call('public.ac_assign_pair',[f.application.id,other.definitionId,f.owner,users.recruiter]),denied('42501'));
 });
 await t.test('only owner assigns; exact immutable AC revision, two current recruiters and strict dense observation validation',async()=>{
  const a=await e.seed();await h.asUser(users.recruiter);await assert.rejects(e.assign(a),denied('PT404'));
  await h.asUser(a.owner);
  for(const ids of [[a.owner,a.owner],[a.owner,users.viewer],[a.owner,users.otherOwner]])await assert.rejects(e.assign(a,...ids),denied('42501'));
  await assert.rejects(e.call('public.ac_assign_pair',[a.application.id,a.competencyDefinitionId,a.owner,users.recruiter]),denied('42501'));
  const id=await e.assign(a);await assert.rejects(e.assign(a),denied('PT409'));
  for(const sheet of [[],{},[acSheet()[1],acSheet()[0]],[{...acSheet()[0],context:''},acSheet()[1]],
   [{...acSheet()[0],evidence:' '},acSheet()[1]],[{...acSheet()[0],evidence:'x'.repeat(4001)},acSheet()[1]],
   [{...acSheet()[0],context:'x'.repeat(2001)},acSheet()[1]],
   [{...acSheet()[0],extra:'unreviewed'},acSheet()[1]],[acSheet()[0],{...acSheet()[1],evidence:'not empty'}]]){
   await assert.rejects(e.submit(id,sheet),denied('22023'));
  }
  await e.submit(id);await h.asAdmin();
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[a.owner]);
  await assert.rejects(db.query('update private.ac_paired_sheets set first_assessor=$2 where id=$1',[id,users.viewer]),denied('42501'));
  await assert.rejects(db.query('update private.ac_paired_sheets set first_sheet=$2 where id=$1',[id,JSON.stringify(acSheet().map(r=>({...r,context:'changed'})))]),denied('42501'));
  await assert.rejects(db.query('delete from private.ac_paired_sheets where id=$1',[id]),denied('42501'));
 });
 await t.test('closed, withdrawn, paused or archived process forbids new writes but retains authorized historical reports',async()=>{
  const a=await e.seed();const id=await e.assign(a);
  for(const [table,row,column,value,original] of [['applications',a.application,'status','rejected','new'],['recruitments',a.recruitment,'status','paused','open'],['positions',a.position,'status','archived','active']]){
   await h.asUser(a.owner);await db.query(`update public.${table} set ${column}=$2 where id=$1`,[row.id,value]);
   await assert.rejects(e.submit(id),denied('42501'));await assert.rejects(e.assign(a),denied('42501'));
   assert.deepEqual(await e.read(id),{state:'pending',ownSubmitted:false});
   await db.query(`update public.${table} set ${column}=$2 where id=$1`,[row.id,original]);
  }
  await h.asUser(f.owner);await e.call('public.withdraw_competency_test_access',[JSON.stringify({kind:'application',application_id:f.application.id,reason:'candidate_withdrawn'}),randomUUID()]);
  await assert.rejects(e.submit(f.pairId),denied('42501'));
  assert.equal((await e.read(f.pairId)).state,'ready');
 });
 await t.test('write advances retention clock; freeze hides reads and denies writes; cancel restores access',async()=>{
  const a=await e.seed();await h.asAdmin();const before=(await db.query('select generation from private.retention_candidate_clocks where candidate_id=$1',[a.candidate.id])).rows[0].generation;
  await h.asUser(a.owner);const id=await e.assign(a);await e.submit(id);
  await h.asAdmin();const after=(await db.query('select generation from private.retention_candidate_clocks where candidate_id=$1',[a.candidate.id])).rows[0].generation;assert.ok(Number(after)>Number(before));
  await h.asUser(a.owner);await x.policy(a,0,lifecycleRules);a.resolutionId=await x.resolve(a);const state=await x.freeze(a);
  assert.equal(await e.find(a),null);await assert.rejects(e.read(id),denied('42501'));
  await assert.rejects(e.assign(a),denied('PT409'));await h.asUser(users.recruiter);await assert.rejects(e.submit(id),denied('PT409'));
  await h.asUser(a.owner);await x.cancel(a,state.request_id,state.generation);assert.equal(await e.find(a),id);
  await h.asAdmin();await db.query('update private.erasure_execution_config set restore_isolated=true where singleton');
  await h.asUser(a.owner);assert.equal(await e.find(a),null);await assert.rejects(e.read(id),denied('42501'));
  await h.asAdmin();await db.query('update private.erasure_execution_config set restore_isolated=false where singleton');
 });
 await t.test('inventory/purge deletes only the confirmed candidate AC data; unknown dependencies fail closed',async()=>{
  const {f:a}=await e.submitted();await h.asUser(a.owner);
  a.definition=acDefinition();a.definitionId=await e.call('public.save_exercise_definition',[a.recruitment.id,randomUUID(),JSON.stringify(a.definition),0,a.position.id,a.position.updated_at]);
  const id=await e.assign(a);await e.submit(id);
  const p=await x.preview(a);assert.equal(p.counts['private.ac_paired_sheets'],1);
  assert.equal(p.counts['private.competency_test_grants'],1);assert.equal(p.counts['public.competency_test_attempts'],1);
  await h.asAdmin();await db.exec('begin');
  try{
   await db.exec('create table public.ac_unknown_copy(candidate_id uuid)');await h.asUser(a.owner);
   assert.ok((await x.preview(a)).blockers.includes('schema_dependency_unknown'));
  }finally{await db.exec('rollback');}
  await h.asUser(a.owner);
  const policy=await x.getPolicy(a);if(!policy)await x.policy(a,0,lifecycleRules);
  a.resolutionId=await x.resolve(a);await x.configure();const state=await x.freeze(a);
  await x.transition(state.request_id,0,'authorized');await x.transition(state.request_id,1,'erasing');await x.purge(state.request_id,2);
  await h.asAdmin();assert.equal((await db.query('select count(*)::int n from private.ac_paired_sheets where id=$1',[id])).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from private.ac_paired_sheets where id=$1',[f.pairId])).rows[0].n,1);
  for(const table of ['private.competency_test_grants','public.competency_test_attempts'])assert.equal((await db.query(`select count(*)::int n from ${table} where candidate_id=$1`,[a.candidate.id])).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from public.exercise_definition_entries where id=$1',[a.definitionId])).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1',[other.candidate.id])).rows[0].n,1);
 });
 await t.test('reapplying active migration is refused without modifying existing data',async()=>{
  await h.asAdmin();await assert.rejects(db.exec(await readFile(new URL('../supabase/migrations/'+acMigration,import.meta.url),'utf8')),denied('55000'));await db.exec('rollback');
  assert.equal((await db.query('select private.erasure_schema_signature() signature')).rows[0].signature,acSignature);
 });
 await t.test('operational rollback denies RPCs but keeps evidence, R13 and erasure support',async()=>{
  await h.asAdmin();const before=(await db.query('select count(*)::int n from private.ac_paired_sheets')).rows[0].n;
  await db.exec(await readFile(new URL('../supabase/rollbacks/20261106120000_sc_ac_inventory_r13_down.sql',import.meta.url),'utf8'));
  assert.equal((await db.query('select count(*)::int n from private.ac_paired_sheets')).rows[0].n,before);
  assert.equal((await db.query('select private.erasure_schema_signature() value')).rows[0].value,acSignature);
  await h.asUser(f.owner);await assert.rejects(e.read(f.pairId),denied('42501'));await assert.rejects(e.find(f),denied('42501'));
  assert.ok(!(await x.preview(f)).blockers.includes('schema_dependency_unknown'));
 });
});

test('AC migration refuses source drift atomically and strips hostile default grants',async t=>{
 const {activeBoot,c1Sql}=await import('./helpers/competency-active-fixture.mjs');
 const e=await activeBoot(t,{install:false}),{db,h}=e;
 await h.asAdmin();await db.exec(await c1Sql());
 const migration=await readFile(new URL('../supabase/migrations/'+acMigration,import.meta.url),'utf8');
 const reject=async()=>{await assert.rejects(db.exec(migration),denied('55000'));await db.exec('rollback');
  assert.equal((await db.query("select to_regclass('private.ac_paired_sheets') value")).rows[0].value,null);};
 await db.exec('create table public.ac_unknown_source(candidate_id uuid)');await reject();await db.exec('drop table public.ac_unknown_source');
 const original=(await db.query("select pg_get_functiondef('private.erasure_row_candidates(text,jsonb)'::regprocedure) source")).rows[0].source;
 await db.exec(original.replace('begin','begin\n -- synthetic source drift'));await reject();await db.exec(original);
 await db.exec('alter default privileges in schema private grant all on tables to authenticated; alter default privileges in schema private grant execute on functions to authenticated; alter default privileges in schema public grant execute on functions to anon');
 await db.exec(migration);
 assert.equal((await db.query("select has_table_privilege('authenticated','private.ac_paired_sheets','select') value")).rows[0].value,false);
 assert.equal((await db.query("select has_function_privilege('authenticated','private.ac_lock_application(uuid)','execute') value")).rows[0].value,false);
 assert.equal((await db.query("select has_function_privilege('anon','public.ac_read_pair(uuid)','execute') value")).rows[0].value,false);
 assert.equal((await db.query('select private.erasure_schema_signature() value')).rows[0].value,acSignature);
});

test('AC confirmed-subject withdrawal blocks new work for both reasons while preserving history and unrelated access',async t=>{
 const e=await acBoot(t),{db,h,x}=e;
 for(const reason of ['candidate_withdrawn','consent_withdrawn'])await t.test(reason,async()=>{
  const a=await e.seed(),unrelated=await e.seed(),other=await e.seed({owner:users.otherOwner});
  await h.asUser(a.owner);const pending=await e.assign(a);
  const revision=()=>e.call('public.save_exercise_definition',[a.recruitment.id,randomUUID(),JSON.stringify(a.definition),0,a.position.id,a.position.updated_at]);
  const historical=await e.assign({...a,definitionId:await revision()});const unassignedRevision=await revision();
  await e.submit(historical);await h.asUser(users.recruiter);await e.submit(historical);
  await h.asUser(a.owner);const resolutionId=await x.resolve(a);
  await e.call('public.withdraw_competency_test_access',[JSON.stringify({kind:'confirmed_subject',resolution_id:resolutionId,resolution_revision:1,reason}),randomUUID()]);
  const app=(await db.query('select status,competency_access_cancelled_at,competency_access_cancel_reason from public.applications where id=$1',[a.application.id])).rows[0];
  assert.equal(app.status,'new');assert.ok(app.competency_access_cancelled_at);assert.equal(app.competency_access_cancel_reason,reason);
  const candidate=(await db.query('select competency_access_cancelled_at,competency_access_cancel_reason from public.candidates where id=$1',[a.candidate.id])).rows[0];
  assert.ok(candidate.competency_access_cancelled_at);assert.equal(candidate.competency_access_cancel_reason,reason);
  await assert.rejects(e.assign({...a,definitionId:unassignedRevision}),denied('42501'));
  for(const actor of [a.owner,users.recruiter]){
   await h.asUser(actor);await assert.rejects(e.submit(pending),denied('42501'));
   assert.deepEqual(await e.read(pending),{state:'pending',ownSubmitted:false});assert.equal((await e.read(historical)).state,'ready');
  }
  for(const f of [unrelated,other]){await h.asUser(f.owner);const id=await e.assign(f);await e.submit(id);assert.deepEqual(await e.read(id),{state:'pending',ownSubmitted:true});}
 });
});

test('AC remains independent of revoking one competency grant',async t=>{
 const e=await acBoot(t),{db,h}=e;const {f,g}=await e.started();await h.asUser(f.owner);
 await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter')",[f.companyId,users.recruiter]);
 const definitionId=await e.call('public.save_exercise_definition',[f.recruitment.id,randomUUID(),JSON.stringify(acDefinition()),0,f.position.id,f.position.updated_at]);
 await e.call('public.revoke_competency_test_grant',[g.grantId,randomUUID()]);
 const pair=await e.assign({...f,definitionId});await e.submit(pair);
 assert.deepEqual(await e.read(pair),{state:'pending',ownSubmitted:true});
});
