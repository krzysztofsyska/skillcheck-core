import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {guardBoot,denied} from './helpers/exercise-ai-grant-guard-fixture.mjs';
import {users} from './helpers/competency-active-fixture.mjs';
const sql=name=>readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
const migration='20261107164219_exercise_ai_revision_workflow.sql';

test('C6 atomic revision and rejection preserve provenance, approval isolation, history and tenant guards',async t=>{
 const e=await guardBoot(t),{db,h}=e;await e.install();
 await db.exec(await sql('20261106150000_exercise_ai_recruiter_api.sql'));
 await db.exec(await sql(migration));
 const signature=(await db.query('select private.erasure_schema_signature() s')).rows[0].s;
 assert.equal(signature,'75eca00dc4b8bbf7959e18a144beda51a70b0377ab4cc306e59b2cef56402688');
 const f=await e.seed();await e.record(f);
 const read=async(id=f.definitionId)=>e.call('public.read_exercise_ai_proposal',[f.companyId,f.recruitment.id,id]);
 const reject=(id=f.definitionId,reason='Niepełna instrukcja')=>e.call('public.reject_exercise_ai_proposal',[f.companyId,f.recruitment.id,id,f.position.updated_at,reason]);
 const edit=(id=f.definitionId,def={...f.definition,title:'Poprawiona propozycja'})=>e.call('public.edit_exercise_ai_proposal',[
  f.companyId,f.recruitment.id,id,f.position.updated_at,JSON.stringify(def),f.position.updated_at]);
 const original=await read();
 for(const actor of [users.viewer,users.outsider,null]){
  await h.asUser(actor);await assert.rejects(reject(),denied('PT404'));await assert.rejects(edit(),denied('PT404'));
 }
 await h.asUser(f.owner);
 await assert.rejects(reject(f.definitionId,''),denied('22023'));
 await db.query('select exercise_ai.set_auto_release($1,true)',[f.recruitment.id]);
 const revisedId=await edit(),revised=await read(revisedId);
 assert.equal(revised.definitionEntry.version,2);assert.equal(revised.definitionEntry.definition.title,'Poprawiona propozycja');
 assert.equal(revised.proposal.approvedAt,null);assert.equal(revised.proposal.approvalMode,null);
 for(const [key,value] of Object.entries(original.proposal.provenance))assert.deepEqual(revised.proposal.provenance[key],value);
 assert.equal(revised.proposal.provenance.human_edit.source_definition_id,f.definitionId);
 assert.equal(revised.proposal.provenance.human_edit.actor,f.owner);
 assert.equal((await read()).proposal.provenance.workflow.state,'superseded');
 assert.deepEqual((await read()).definitionEntry,original.definitionEntry);
 await assert.rejects(e.approve(f),denied('55000'));await assert.rejects(e.issue(f),denied('PT404'));
 await assert.rejects(edit(),denied('PT409'));await assert.rejects(reject(),denied('PT409'));
 await assert.rejects(e.issue({...f,definitionId:revisedId}),denied('PT404'));
 const rejected=await reject(revisedId);assert.equal(await reject(revisedId,'another reason'),rejected);
 const rejectedReview=await read(revisedId);assert.equal(rejectedReview.proposal.provenance.workflow.reason,'Niepełna instrukcja');
 await assert.rejects(e.approve({...f,definitionId:revisedId}),denied('55000'));
 // Reworking a rejection creates a new pending version; it never reopens the old one.
 const third=await edit(revisedId);await e.approve({...f,definitionId:third});
 const grant=await e.issue({...f,definitionId:third});assert.ok(grant.token);
 await assert.rejects(reject(third),denied('55000'));
 // Existing manual-save RPC must not launder AI origin or inherit approval.
 const row=(await read(third)).definitionEntry;
 const fourth=await e.call('public.save_exercise_definition',[f.recruitment.id,row.exercise_id,JSON.stringify({...f.definition,title:'Manual route correction'}),3,f.position.id,f.position.updated_at]);
 const fourthReview=await read(fourth);assert.equal(fourthReview.proposal.approvedAt,null);
 assert.equal(fourthReview.proposal.provenance.human_edit.root_definition_id,f.definitionId);
 assert.equal((await read(third)).proposal.approvalMode,'manual');
 await assert.rejects(e.issue({...f,definitionId:fourth}),denied('PT404'));
 // Invalid edit is atomic: no orphan definition or status transition.
 await assert.rejects(edit(fourth,{...f.definition,criteria:[]}),denied('22023'));
 assert.equal((await read(fourth)).proposal.provenance.workflow,undefined);
 assert.equal((await db.query('select count(*)::int n from public.exercise_definition_entries where exercise_id=$1',[row.exercise_id])).rows[0].n,4);
 await h.asAdmin();
 await assert.rejects(db.exec(await readFile(new URL('../supabase/rollbacks/'+migration.replace('.sql','_down.sql'),import.meta.url),'utf8')),denied('55000'));await db.exec('rollback');
 assert.equal((await db.query('select private.erasure_schema_signature() s')).rows[0].s,signature);
});
