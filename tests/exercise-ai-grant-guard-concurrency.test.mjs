import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { guardBoot, denied } from './helpers/exercise-ai-grant-guard-fixture.mjs';
const auth=async(client,actor)=>{await client.exec('reset role;set role authenticated');await client.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);};

test('C6 AC3 native: registration/issuance serialize both ways, and stale snapshots cannot bypass approval',async t=>{
 assert.equal(process.env.SC_WER_PGLITE_PATH,undefined,'Independent native connections required');
 const e=await guardBoot(t),{db,h}=e,rival=await e.connect();await e.install();
 for(const registrationFirst of [true,false]){
  const f=await e.seed();await auth(rival,f.owner);
  const issue=()=>e.call('public.create_competency_test_grant',[f.application.id,f.definitionId,new Date(Date.now()+3600000).toISOString(),randomUUID()],rival);
  await db.exec('begin');
  try{
   if(registrationFirst){
    await e.record(f);
    await assert.rejects(issue(),denied('PT409'));
    await db.exec('commit');
    await assert.rejects(issue(),denied('PT404'));
    await e.approve(f);assert.ok((await issue()).token);
   }else{
    await e.issue(f);
    await assert.rejects(e.record(f,rival),denied('PT409'));
    await db.exec('commit');
    await assert.rejects(e.record(f,rival),denied('PT409'));
    assert.equal((await db.query('select count(*)::int n from exercise_ai.proposals where definition_entry_id=$1',[f.definitionId])).rows[0].n,0);
   }
  }finally{await db.exec('rollback');}
 }
 for(const level of ['repeatable read','serializable']){
  const f=await e.seed();await auth(rival,f.owner);await rival.exec('begin isolation level '+level);
  try{
   assert.equal((await rival.query('select count(*)::int n from exercise_ai.proposals where definition_entry_id=$1',[f.definitionId])).rows[0].n,0);
   await e.record(f);
   await assert.rejects(e.call('public.create_competency_test_grant',[f.application.id,f.definitionId,new Date(Date.now()+3600000).toISOString(),randomUUID()],rival),denied('PT409'));
  }finally{await rival.exec('rollback');}
 }
 // Approval becoming visible only after COMMIT must never leak task content.
 const f=await e.seed();await e.record(f);await auth(rival,f.owner);await db.exec('begin');
 try{
  await db.query('select exercise_ai.approve_proposal($1)',[f.definitionId]);
  await assert.rejects(e.call('public.create_competency_test_grant',[f.application.id,f.definitionId,new Date(Date.now()+3600000).toISOString(),randomUUID()],rival),denied('PT404'));
  await db.exec('commit');
  assert.ok((await e.call('public.create_competency_test_grant',[f.application.id,f.definitionId,new Date(Date.now()+3600000).toISOString(),randomUUID()],rival)).token);
 }finally{await db.exec('rollback');}
});
