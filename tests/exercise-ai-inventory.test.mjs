import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { activeBoot } from './helpers/competency-active-fixture.mjs';
import { acMigration, acSignature } from './helpers/assessment-center-active-fixture.mjs';
import { lifecycleRules } from './helpers/erasure-lifecycle-fixture.mjs';
const migration='20261106130000_exercise_ai_proposals.sql';
const signature='75eca00dc4b8bbf7959e18a144beda51a70b0377ab4cc306e59b2cef56402688';
const sql=()=>readFile(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8');
const denied=(...codes)=>error=>codes.includes(error.code);
const provenance=f=>({provider:'synthetic',model:'fixture',prompt_version:'v1',payload_schema_version:1,result_schema_version:1,
 input_fingerprint:'a'.repeat(64),position_id:f.position.id,position_updated_at:f.position.updated_at});

test('C6 R14: full migration chain, erasure with AI provenance, fail closed drift and operational rollback',async t=>{
 const e=await activeBoot(t,{fullChain:true,throughMigration:migration}),{db,h,x}=e;
 await h.asAdmin();
 const baseline=(await db.query('select *,private.erasure_schema_signature() actual from private.erasure_inventory_baseline_r14')).rows[0];
 assert.equal(baseline.actual,signature);assert.equal(baseline.schema_signature,signature);
 const actual=(await db.query("select n.nspname||'.'||c.relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f')")).rows.map(r=>r.name);
 assert.deepEqual(actual.sort(),baseline.known_tables.sort());
 for(const name of ['preview_candidate_erasure','prepare_erasure_purge_manifest','authorize_retention_suggestion','get_retention_schedule']){
  assert.equal((await db.query("select count(*)::int n from pg_proc where proname=$1 and prosrc like '%erasure_inventory_baseline_r14%'",[name])).rows[0].n,1);
 }
 execFileSync(process.execPath,['scripts/sc-c6-compose.mjs','--check']);
 const {f}=await e.submitted();await h.asUser(f.owner);
 const proposal=(await db.query('select exercise_ai.record_proposal($1,$2,$3,20) id',[f.recruitment.id,f.definitionId,provenance(f)])).rows[0].id;
 const other=await e.seed();await h.asUser(f.owner);
 const preview=await x.preview(f);assert.ok(!preview.blockers.includes('schema_dependency_unknown'));
 assert.equal(preview.counts['private.competency_test_grants'],1);
 await h.asAdmin();await db.exec('create table public.c6_unknown(candidate_id uuid)');
 await h.asUser(f.owner);assert.ok((await x.preview(f)).blockers.includes('schema_dependency_unknown'));
 await h.asAdmin();await db.exec('drop table public.c6_unknown');
 // Retain R14, evidence and FKs while disabling only C6 writes.
 await db.exec(await readFile(new URL('../supabase/rollbacks/20261106130000_exercise_ai_proposals_down.sql',import.meta.url),'utf8'));
 assert.equal((await db.query('select private.erasure_schema_signature() signature')).rows[0].signature,signature);
 await h.asUser(f.owner);
 await assert.rejects(db.query('select exercise_ai.approve_proposal($1)',[f.definitionId]),denied('42501'));
 await assert.rejects(db.query('select exercise_ai.set_auto_release($1,true)',[f.recruitment.id]),denied('42501'));
 await assert.rejects(db.query('select exercise_ai.record_proposal($1,$2,$3,20)',[f.recruitment.id,f.definitionId,provenance(f)]),denied('42501'));
 await x.policy(f,0,lifecycleRules);f.resolutionId=await x.resolve(f);await x.configure();const state=await x.freeze(f);
 await x.transition(state.request_id,0,'authorized');await x.transition(state.request_id,1,'erasing');await x.purge(state.request_id,2);
 await h.asAdmin();
 assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1',[f.candidate.id])).rows[0].n,0);
 assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1',[other.candidate.id])).rows[0].n,1);
 assert.equal((await db.query('select count(*)::int n from exercise_ai.proposals where id=$1',[proposal])).rows[0].n,1);
 assert.equal((await db.query('select count(*)::int n from public.exercise_definition_entries where id=$1',[f.definitionId])).rows[0].n,1);
 await assert.rejects(db.exec(await sql()),denied('55000'));await db.exec('rollback');
 assert.equal((await db.query('select private.erasure_schema_signature() signature')).rows[0].signature,signature);
});

test('C6 R14: pinned R13 preflight refuses schema/function/ACL drift atomically; hostile defaults are stripped',async t=>{
 const {db,h}=await activeBoot(t,{throughMigration:acMigration});await h.asAdmin();const migrationSql=await sql();
 const reject=async()=>{
  await assert.rejects(db.exec(migrationSql),denied('55000'));await db.exec('rollback');
  assert.equal((await db.query("select to_regnamespace('exercise_ai') value")).rows[0].value,null);
  assert.equal((await db.query("select to_regclass('private.erasure_inventory_baseline_r14') value")).rows[0].value,null);
 };
 await db.exec('create table public.c6_unknown_source(candidate_id uuid)');await reject();await db.exec('drop table public.c6_unknown_source');
 const original=(await db.query("select pg_get_functiondef('private.erasure_row_candidates(text,jsonb)'::regprocedure) source")).rows[0].source;
 await db.exec(original.replace('begin','begin\n -- synthetic drift'));await reject();await db.exec(original);
 await db.exec('grant execute on function private.erasure_row_candidates(text,jsonb) to authenticated');await reject();
 await db.exec('revoke execute on function private.erasure_row_candidates(text,jsonb) from authenticated');
 assert.equal((await db.query('select private.erasure_schema_signature() signature')).rows[0].signature,acSignature);
 const hostile='c6_hostile_'+randomUUID().replaceAll('-','');
 await db.exec(`create role ${hostile} nologin`);
 try {
  await db.exec(`alter default privileges grant all on tables to ${hostile}; alter default privileges grant execute on functions to ${hostile}`);
  await db.exec(migrationSql);
  assert.equal((await db.query("select has_table_privilege($1,'exercise_ai.proposals','select') value",[hostile])).rows[0].value,false);
  assert.equal((await db.query("select has_table_privilege($1,'private.erasure_inventory_baseline_r14','select') value",[hostile])).rows[0].value,false);
  assert.equal((await db.query("select has_function_privilege($1,'exercise_ai.approve_proposal(uuid)','execute') value",[hostile])).rows[0].value,false);
  assert.equal((await db.query('select private.erasure_schema_signature() signature')).rows[0].signature,signature);
 } finally {
  await db.exec(`rollback;reset role;drop owned by ${hostile};drop role ${hostile}`);
 }
});
