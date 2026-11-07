import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {guardBoot,denied} from './helpers/exercise-ai-grant-guard-fixture.mjs';

test('C6 native concurrency: reject/approve and edit/edit serialize on exact revision',async t=>{
 assert.equal(process.env.SC_WER_PGLITE_PATH,undefined,'Native independent connections required');
 const e=await guardBoot(t),{db,h}=e,rival=await e.connect();await e.install();
 for(const name of ['20261106150000_exercise_ai_recruiter_api.sql','20261107164219_exercise_ai_revision_workflow.sql'])
  await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 const configure=async f=>{await rival.exec("set role authenticated;set lock_timeout='100ms'");await rival.query("select set_config('request.jwt.claim.sub',$1,false)",[f.owner]);};
 const reject=(f,client=db)=>e.call('public.reject_exercise_ai_proposal',[f.companyId,f.recruitment.id,f.definitionId,f.position.updated_at,'Korekta instrukcji'],client);
 const approve=(f,client=db)=>e.call('public.approve_exercise_ai_proposal',[f.companyId,f.recruitment.id,f.definitionId,f.position.updated_at],client);
 const edit=(f,client=db)=>e.call('public.edit_exercise_ai_proposal',[f.companyId,f.recruitment.id,f.definitionId,f.position.updated_at,JSON.stringify({...f.definition,title:'Korekta'}),f.position.updated_at],client);
 const f=await e.seed();await e.record(f);await configure(f);
 await db.exec('begin');try{
  await reject(f);await assert.rejects(approve(f,rival),denied('55P03'));await db.exec('commit');
 }finally{await db.exec('rollback');}
 await assert.rejects(approve(f,rival),denied('55000'));await assert.rejects(e.issue(f),denied('PT404'));
 const g=await e.seed();await e.record(g);await configure(g);
 await db.exec('begin');try{
  await approve(g);await assert.rejects(reject(g,rival),denied('55P03'));await db.exec('commit');
 }finally{await db.exec('rollback');}
 await assert.rejects(reject(g,rival),denied('55000'));assert.ok((await e.issue(g)).token);
 const z=await e.seed();await e.record(z);await configure(z);
 await db.exec('begin');try{
  assert.ok(await edit(z));await assert.rejects(edit(z,rival),denied('55P03'));await db.exec('commit');
 }finally{await db.exec('rollback');}
 await assert.rejects(edit(z,rival),denied('PT409'));await assert.rejects(approve(z,rival),denied('55000'));
 await h.asAdmin();assert.equal((await db.query('select count(*)::int n from exercise_ai.proposals where recruitment_id=$1',[z.recruitment.id])).rows[0].n,2);
});
