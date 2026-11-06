import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { guardBoot, denied } from './helpers/exercise-ai-grant-guard-fixture.mjs';
import { users } from './helpers/competency-active-fixture.mjs';

test('C6 recruiter API native: read/approval serialize with recruiter membership removal in both orders',async t=>{
 assert.equal(process.env.SC_WER_PGLITE_PATH,undefined,'Independent native connections required');
 const e=await guardBoot(t),{db}=e,rival=await e.connect();await e.install();
 await db.exec(await readFile(new URL('../supabase/migrations/20261106150000_exercise_ai_recruiter_api.sql',import.meta.url),'utf8'));
 const f=await e.seed();await e.record(f);
 await rival.exec('set role authenticated');await rival.query("select set_config('request.jwt.claim.sub',$1,false)",[users.recruiter]);
 await db.exec("set lock_timeout='100ms'");
 for(const name of ['public.read_exercise_ai_proposal','public.approve_exercise_ai_proposal']){
  const args=[f.companyId,f.recruitment.id,f.definitionId,...(name.includes('approve')?[f.position.updated_at]:[])];
  const call=()=>e.call(name,args,rival);
  await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter') on conflict(company_id,user_id) do update set role=excluded.role",[f.companyId,users.recruiter]);
  await db.exec('begin');
  try{
   await db.query('delete from public.company_members where company_id=$1 and user_id=$2',[f.companyId,users.recruiter]);
   await assert.rejects(call(),denied('PT409'));await db.exec('rollback');
  }finally{await db.exec('rollback');}
  await rival.exec('begin');
  try{
   assert.ok(await call());
   await assert.rejects(db.query('delete from public.company_members where company_id=$1 and user_id=$2',[f.companyId,users.recruiter]),denied('55P03'));
   await rival.exec('commit');
  }finally{await rival.exec('rollback');}
  await db.query('delete from public.company_members where company_id=$1 and user_id=$2',[f.companyId,users.recruiter]);
  await assert.rejects(call(),denied('PT404'));
 }
});
