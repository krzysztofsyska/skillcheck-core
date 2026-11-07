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
 await h.asAdmin();assert.equal((await db.query('select count(*)::int n from exercise_ai.proposals p join public.exercise_definition_entries d on d.id=p.definition_entry_id where d.exercise_id=(select exercise_id from public.exercise_definition_entries where id=$1)',[z.definitionId])).rows[0].n,2);
 const manual=async(f,client=db)=>{
  const id=(await client.query('select exercise_id from public.exercise_definition_entries where id=$1',[f.definitionId])).rows[0].exercise_id;
  return e.call('public.save_exercise_definition',[f.recruitment.id,id,JSON.stringify(f.definition),1,f.position.id,f.position.updated_at],client);
 };
 // Classification first: the old manual editor must inherit the committed origin.
 const a=await e.seed();await configure(a);
 await db.exec('begin');try{
  await e.record(a);await assert.rejects(manual(a,rival),denied('55P03'));await db.exec('commit');
 }finally{await db.exec('rollback');}
 const inherited=await manual(a,rival);await h.asAdmin();
 assert.ok((await db.query('select id from exercise_ai.proposals where definition_entry_id=$1',[inherited])).rows[0]);
 // Manual revision first: no retroactive origin may be attached to its ancestor.
 const b=await e.seed();await configure(b);
 await db.exec('begin');try{
  await manual(b);await assert.rejects(e.record(b,rival),denied('55P03'));await db.exec('commit');
 }finally{await db.exec('rollback');}
 await assert.rejects(e.record(b,rival),denied('PT409'));
 // An older MVCC snapshot must not bypass the absence check after acquiring a lock.
 const c=await e.seed();await configure(c);await rival.exec('begin isolation level repeatable read');
 try{await rival.query('select count(*) from public.exercise_definition_entries');await e.record(c);
  await assert.rejects(manual(c,rival),denied('PT409'));
 }finally{await rival.exec('rollback');}
 // Approval is preserved when it wins; the subsequent revision is pending.
 const d=await e.seed();await e.record(d);await configure(d);
 await db.exec('begin');try{
  await approve(d);await assert.rejects(edit(d,rival),denied('55P03'));await db.exec('commit');
 }finally{await db.exec('rollback');}
 const child=await edit(d,rival);await h.asAdmin();
 const approvals=(await db.query('select definition_entry_id,approved_at from exercise_ai.proposals where definition_entry_id=any($1::uuid[])',[[d.definitionId,child]])).rows;
 assert.ok(approvals.find(x=>x.definition_entry_id===d.definitionId).approved_at);
 assert.equal(approvals.find(x=>x.definition_entry_id===child).approved_at,null);
 const j=await e.seed();await e.record(j);await configure(j);
 await db.exec('begin');try{
  await edit(j);await assert.rejects(approve(j,rival),denied('55P03'));await db.exec('commit');
 }finally{await db.exec('rollback');}
 await assert.rejects(approve(j,rival),denied('55000'));
 // Manual save participates in exactly the same rejection/edit serialization.
 const k=await e.seed();await e.record(k);await configure(k);
 await db.exec('begin');try{
  await reject(k);await assert.rejects(manual(k,rival),denied('55P03'));await db.exec('commit');
 }finally{await db.exec('rollback');}
 assert.ok(await manual(k,rival));
 const l=await e.seed();await e.record(l);await configure(l);
 await db.exec('begin');try{
  await manual(l);await assert.rejects(edit(l,rival),denied('55P03'));await assert.rejects(reject(l,rival),denied('55P03'));await db.exec('commit');
 }finally{await db.exec('rollback');}
 await assert.rejects(edit(l,rival),denied('PT409'));await assert.rejects(reject(l,rival),denied('PT409'));
});
