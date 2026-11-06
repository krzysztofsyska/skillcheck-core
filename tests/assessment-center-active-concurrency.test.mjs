import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acBoot, acSheet, users } from './helpers/assessment-center-active-fixture.mjs';
import { lifecycleRules } from './helpers/erasure-lifecycle-fixture.mjs';
const busy=error=>['PT409','55P03'].includes(error.code);
const denied=error=>['42501','PT404','PT409'].includes(error.code);
const auth=async(client,id)=>{await client.exec('reset role;set role authenticated');await client.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);};

test('AC native PostgreSQL: submissions commit once and membership revocation serializes in both orders',async t=>{
 assert.equal(process.env.SC_WER_PGLITE_PATH,undefined,'Independent native connections required');
 const e=await acBoot(t),{db,h,call}=e,rival=await e.connect();
 const f=await e.seed();const id=await e.assign(f);
 await auth(rival,f.owner);await db.exec('begin');
 try{
  await e.submit(id);await assert.rejects(call('public.ac_submit_sheet',[id,JSON.stringify(acSheet())],rival),busy);
  await db.exec('commit');await assert.rejects(call('public.ac_submit_sheet',[id,JSON.stringify(acSheet())],rival),busy);
 }finally{await db.exec('rollback');}
 for(const revokeFirst of [true,false]){
  const a=await e.seed();const pair=await e.assign(a);await auth(rival,users.recruiter);
  if(revokeFirst){
   await db.exec('begin');try{
    await db.query('delete from public.company_members where company_id=$1 and user_id=$2',[a.companyId,users.recruiter]);
    await assert.rejects(call('public.ac_submit_sheet',[pair,JSON.stringify(acSheet())],rival),busy);await db.exec('commit');
   }finally{await db.exec('rollback');}
  }else{
   await rival.exec('begin');try{
    await call('public.ac_submit_sheet',[pair,JSON.stringify(acSheet())],rival);
    await assert.rejects(db.query('delete from public.company_members where company_id=$1 and user_id=$2',[a.companyId,users.recruiter]),busy);
    await rival.exec('commit');
   }finally{await rival.exec('rollback');}
   await db.query('delete from public.company_members where company_id=$1 and user_id=$2',[a.companyId,users.recruiter]);
  }
  await assert.rejects(call('public.ac_read_pair',[pair],rival),denied);
  await assert.rejects(call('public.ac_submit_sheet',[pair,JSON.stringify(acSheet())],rival),denied);
 }
 await h.asAdmin();assert.equal((await db.query('select count(*)::int n from private.ac_paired_sheets where id=$1 and first_sheet is not null',[id])).rows[0].n,1);
});

test('AC native PostgreSQL: freeze and controlled withdrawal serialize against submission in both orders',async t=>{
 assert.equal(process.env.SC_WER_PGLITE_PATH,undefined,'Independent native connections required');
 const e=await acBoot(t),{db,h,x,call}=e,rival=await e.connect();
 let policy=false;
 for(const action of ['freeze','withdraw','candidate_withdrawn','consent_withdrawn'])for(const protectionFirst of [true,false]){
  const f=await e.seed();const id=await e.assign(f);await h.asUser(f.owner);
  if(!policy){await x.policy(f,0,lifecycleRules);policy=true;}f.resolutionId=await x.resolve(f);
  let frozenState;
  const protect=async()=>action==='freeze'?(frozenState=await x.freeze(f)):call('public.withdraw_competency_test_access',[
   JSON.stringify(action==='withdraw'?{kind:'application',application_id:f.application.id,reason:'candidate_withdrawn'}
    :{kind:'confirmed_subject',resolution_id:f.resolutionId,resolution_revision:1,reason:action}),randomUUID()]);
  const submit=()=>call('public.ac_submit_sheet',[id,JSON.stringify(acSheet())],rival);
  await auth(rival,users.recruiter);
  if(protectionFirst){
   await db.exec('begin');try{await protect();await assert.rejects(submit(),busy);await db.exec('commit');}finally{await db.exec('rollback');}
  }else{
   await rival.exec('begin');try{await submit();await assert.rejects(protect(),busy);await rival.exec('commit');}finally{await rival.exec('rollback');}
   await h.asUser(f.owner);await protect();
  }
  await assert.rejects(submit(),denied);
  if(action==='freeze'){await assert.rejects(call('public.ac_read_pair',[id],rival),denied);await h.asUser(f.owner);await x.cancel(f,frozenState.request_id,frozenState.generation);}
 }
});
