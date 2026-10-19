import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {boot,hash,users,observations} from './helpers/competency-attempt-fixture.mjs';

// No fallback, mocks, skips or embedded substitute: boot requires an explicitly
// supplied disposable loopback PostgreSQL server and independent connections.
const subjectScope=(id,revision=1)=>({kind:'confirmed_subject',resolution_id:id,resolution_revision:revision,reason:'consent_withdrawn'});
const appScope=f=>({kind:'application',application_id:f.application.id,reason:'candidate_withdrawn'});

test('B2 real PostgreSQL: withdrawal, existing confirmation and access serialize until COMMIT',async t=>{
 const env=await boot(t,{embedded:false}),{db,h,call}=env;
 const rival=await env.connect();
 const auth=async(client,id)=>{await env.actor(client,id);await client.query('set role authenticated');};
 const resolve=(client,f,ids,revision=0,key=randomUUID())=>call('public.confirm_erasure_subject',[f.candidate.id,ids,revision,key],client);
 const withdraw=(client,scope)=>call('public.withdraw_competency_test_access',[scope,randomUUID()],client);
 const busy=action=>assert.rejects(action,{code:'PT409'});

 await t.test('actual restricted login cannot assume marker-writer role or call its helper',async()=>{
  const f=await env.seed();await h.asAdmin();
  const role='sc014_withdraw_'+randomUUID().replaceAll('-',''),password=randomUUID();
  await db.query(`create role ${role} login noinherit nosuperuser nocreatedb nocreaterole nobypassrls password '${password}'`);
  const client=new Client({...env.connectionConfig,user:role,password});
  try{
   await db.query(`grant authenticated to ${role}`);await client.connect();
   await client.query('set role authenticated');
   await client.query("select set_config('request.jwt.claim.sub',$1,false)",[f.owner]);
   await client.query("select set_config('skillcheck.competency_withdrawal','true',false)");
   await assert.rejects(client.query("select set_config('role','competency_test_marker_writer',false)"),{code:'42501'});
   await assert.rejects(client.query("select private.competency_write_markers($1,$2::uuid[],$3::uuid[],'candidate_withdrawn',true,true)",[f.companyId,[f.candidate.id],[f.application.id]]),{code:'42501'});
   await assert.rejects(client.query("update public.applications set status='withdrawn' where id=$1",[f.application.id]),{code:'42501'});
   await withdraw(client,appScope(f));
  }finally{
   await client.end();await h.asAdmin();await db.query(`drop role ${role}`);
  }
 });

 await t.test('withdrawal wins; confirm/link with a new anchor retries and propagates before publishing',async()=>{
  const a=await env.submitted(),later=await env.started({tenant:a.f});
  await auth(db,a.f.owner);const resolution=await resolve(db,a.f,[a.f.candidate.id]);
  await db.query('begin');
  try{
   await withdraw(db,subjectScope(resolution));
   await auth(rival,a.f.owner);
   await busy(()=>resolve(rival,later.f,[later.f.candidate.id,a.f.candidate.id]));
   await db.query('commit');
  }finally{await db.query('rollback');}
  await resolve(rival,later.f,[later.f.candidate.id,a.f.candidate.id]);
  await env.asGateway(rival);
  await assert.rejects(call('private.inspect_candidate_competency_test',[hash(later.s.session)],rival),{code:'PT404'});
  await auth(rival,a.f.owner);
  await assert.rejects(call('public.read_competency_test_response',[a.receipt.attemptId],rival),{code:'PT404'});
 });
 await t.test('confirm wins; old resolution cannot withdraw an incomplete scope after the retry',async()=>{
  const a=await env.started(),b=await env.started({tenant:a.f});
  await auth(db,a.f.owner);const old=await resolve(db,a.f,[a.f.candidate.id]);
  await db.query('begin');let latest;
  try{
   latest=await resolve(db,a.f,[a.f.candidate.id,b.f.candidate.id],1);
   await auth(rival,a.f.owner);await busy(()=>withdraw(rival,subjectScope(old)));
   await db.query('commit');
  }finally{await db.query('rollback');}
  await assert.rejects(withdraw(rival,subjectScope(old)),{code:'PT409'});
  await withdraw(rival,subjectScope(latest,2));
  await env.asGateway();
  for(const item of [a,b])await assert.rejects(call('private.inspect_candidate_competency_test',[hash(item.s.session)]),{code:'PT404'});
 });
 await t.test('direct trusted INSERT of an overlapping range uses the same mutex as withdrawal',async()=>{
  const a=await env.seed(),b=await env.seed({tenant:a}),c=await env.seed({tenant:a});
  await auth(db,a.owner);const resolution=await resolve(db,a,[a.candidate.id,b.candidate.id]);
  await env.actor(db,a.owner);await db.query('begin');
  try{
   await db.query(`insert into private.erasure_subject_resolutions(company_id,anchor_candidate_id,candidate_ids,revision,confirmed_by)
    values($1,$2,$3::uuid[],1,$4)`,[a.companyId,b.candidate.id,[b.candidate.id,c.candidate.id],a.owner]);
   await auth(rival,a.owner);await busy(()=>withdraw(rival,subjectScope(resolution)));
   await db.query('commit');
  }finally{await db.query('rollback');}
  await assert.rejects(withdraw(rival,subjectScope(resolution)),{code:'PT409'});
  const complete=await resolve(rival,a,[a.candidate.id,b.candidate.id,c.candidate.id],1);
  await withdraw(rival,subjectScope(complete,2));
 });
 await t.test('withdrawal blocks a concurrent new application and permanently denies its later grant',async()=>{
  const f=await env.seed();await auth(db,f.owner);
  const resolution=await resolve(db,f,[f.candidate.id]);
  const recruitment=await h.insert('recruitments',{company_id:f.companyId,position_id:f.position.id,name:'Concurrent synthetic recruitment',status:'open'});
  await db.query('begin');
  const insert=()=>rival.query('insert into public.applications(company_id,recruitment_id,candidate_id) values($1,$2,$3) returning id',[f.companyId,recruitment.id,f.candidate.id]);
  try{
   await withdraw(db,subjectScope(resolution));await auth(rival,f.owner);
   await busy(insert);await db.query('commit');
  }finally{await db.query('rollback');}
  const application=(await insert()).rows[0].id;
  await assert.rejects(call('public.create_competency_test_grant',[application,f.definitionId,new Date(Date.now()+3600000).toISOString(),randomUUID()],rival),{code:'PT404'});
 });
 await t.test('response/review locks defeat withdrawal first; withdrawal first defeats response/review',async()=>{
  const first=await env.submitted();await auth(db,first.f.owner);await db.query('begin');
  try{
   assert.ok((await call('public.read_competency_test_response',[first.receipt.attemptId])).workSample);
   await call('public.save_competency_test_review',[first.receipt.attemptId,0,JSON.stringify(observations)]);
   await auth(rival,first.f.owner);await busy(()=>withdraw(rival,appScope(first.f)));
   await db.query('commit');
  }finally{await db.query('rollback');}
  await withdraw(rival,appScope(first.f));
  await auth(db,first.f.owner);
  await assert.rejects(call('public.read_competency_test_response',[first.receipt.attemptId]),{code:'PT404'});
  await assert.rejects(call('public.save_competency_test_review',[first.receipt.attemptId,1,JSON.stringify(observations)]),{code:'PT404'});
  const second=await env.submitted();await auth(db,second.f.owner);await db.query('begin');
  try{
   await withdraw(db,appScope(second.f));await auth(rival,second.f.owner);
   await busy(()=>call('public.read_competency_test_response',[second.receipt.attemptId],rival));
   await busy(()=>call('public.save_competency_test_review',[second.receipt.attemptId,0,JSON.stringify(observations)],rival));
   await db.query('commit');
  }finally{await db.query('rollback');}
  await assert.rejects(call('public.read_competency_test_response',[second.receipt.attemptId],rival),{code:'PT404'});
 });
 await t.test('owner authority remains locked through confirm and withdrawal until COMMIT',async()=>{
  const f=await env.seed();await auth(db,f.owner);await db.query('begin');let resolution;
  try{
   resolution=await resolve(db,f,[f.candidate.id]);
   await withdraw(db,subjectScope(resolution));
   await env.actor(rival,f.owner);await rival.query("set lock_timeout='150ms'");
   await assert.rejects(rival.query('update public.companies set owner_id=$1 where id=$2',[users.otherOwner,f.companyId]),{code:'55P03'});
   await db.query('commit');
  }finally{await db.query('rollback');}
  await rival.query('update public.companies set owner_id=$1 where id=$2',[users.otherOwner,f.companyId]);
  await auth(db,f.owner);await assert.rejects(resolve(db,f,[f.candidate.id],1),{code:'PT404'});
  await auth(db,users.otherOwner);
  const revised=await resolve(db,f,[f.candidate.id],1);
  assert.ok(revised,'new owner can confirm a new immutable revision without resetting denial');
 });
});
