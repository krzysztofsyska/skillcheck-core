import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {Client} from 'pg';
import {boot,hash,users,observations,b2Tables} from './helpers/competency-attempt-fixture.mjs';
import {lifecycleRules} from './helpers/erasure-lifecycle-fixture.mjs';
import {executeCompetencyOperation} from '../lib/competency-attempt-transport.ts';
const busy=e=>['PT409','55P03'].includes(e.code);
const denied=e=>['42501','PT404','PT409'].includes(e.code);
// Intentionally no PGlite fallback or skip: two independent real connections.
test('B2 real PostgreSQL transaction and role boundaries',async t=>{
 const e=await boot(t,{embedded:false}),{db,h,call}=e;
 const actor=async(c,id)=>{await e.actor(c,id);await c.exec('set role authenticated');};
 await t.test('dedicated authenticated DB login can only call gateway surfaces',async()=>{
  const f=await e.seed(),g=await e.issue(f);
  const role='sc014_gateway_'+randomUUID().replaceAll('-',''),password=randomBytes(24).toString('hex');
  await h.asAdmin();await db.exec(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit nobypassrls;grant competency_test_gateway to ${role}`);
  const c=new Client({...e.connectionConfig,user:role,password});await c.connect();
  try{
   const s=await executeCompetencyOperation(c,{kind:'exchange',token:g.token});
   const pre=await executeCompetencyOperation(c,{kind:'inspect',session:s.session});assert.equal(pre.state,'not_started');
   const failCommit={query:async(sql,values)=>{if(sql==='commit')throw new Error('synthetic lost commit');return c.query(sql,values);}};
   await assert.rejects(executeCompetencyOperation(failCommit,{kind:'start',session:s.session,requestKey:randomUUID()}),/synthetic lost commit/);
   assert.equal((await executeCompetencyOperation(c,{kind:'inspect',session:s.session})).state,'not_started');
   const a=await executeCompetencyOperation(c,{kind:'start',session:s.session,requestKey:randomUUID()});assert.equal(a.state,'in_progress');
   for(const table of b2Tables)await assert.rejects(c.query(`select * from ${table}`),denied);
   await assert.rejects(c.query('set role authenticated'),denied);await assert.rejects(c.query('set role competency_test_marker_writer'),denied);
   await assert.rejects(c.query('select public.read_competency_test_response($1)',[a.attemptId]),denied);
  }finally{await c.end();await h.asAdmin();await db.exec(`drop role ${role}`);}
 });
 await t.test('two starts and submits serialize; winner retained, autosave cannot recreate draft',async()=>{
  const f=await e.seed(),g=await e.issue(f),s=await e.exchange(g),a=await e.connect(null),b=await e.connect(null);
  await e.asGateway(a);await e.asGateway(b);await a.exec('begin');
  const start=await call('private.start_candidate_competency_test',[hash(s.session),randomUUID()],a);
  await assert.rejects(call('private.start_candidate_competency_test',[hash(s.session),randomUUID()],b),busy);
  await a.exec('commit');assert.equal((await call('private.start_candidate_competency_test',[hash(s.session),randomUUID()],b)).attemptId,start.attemptId);
  await call('private.save_candidate_competency_test_draft',[hash(s.session),'Plan roboczy',0,randomUUID()],b);
  await a.exec('begin');const answer=JSON.stringify({workSample:'Plan bezpiecznego wdrożenia.'});
  const receipt=await call('private.submit_candidate_competency_test',[hash(s.session),answer,randomUUID()],a);
  await assert.rejects(call('private.submit_candidate_competency_test',[hash(s.session),answer,randomUUID()],b),busy);
  await assert.rejects(call('private.save_candidate_competency_test_draft',[hash(s.session),'stary draft',1,randomUUID()],b),busy);
  await a.exec('commit');assert.deepEqual(await call('private.submit_candidate_competency_test',[hash(s.session),answer,randomUUID()],b),receipt);
  await assert.rejects(call('private.save_candidate_competency_test_draft',[hash(s.session),'stary draft',1,randomUUID()],b),denied);
  await h.asAdmin();assert.equal((await db.query('select count(*)::int n from private.competency_test_drafts where attempt_id=$1',[start.attemptId])).rows[0].n,0);
 });
 await t.test('autosave first commits then submit deletes its exact row',async()=>{
  const r=await e.started(),a=await e.connect(null),b=await e.connect(null);await e.asGateway(a);await e.asGateway(b);
  await a.exec('begin');await call('private.save_candidate_competency_test_draft',[hash(r.s.session),'Plan',0,randomUUID()],a);
  const args=[hash(r.s.session),JSON.stringify({workSample:'Plan wdrożenia.'}),randomUUID()];await assert.rejects(call('private.submit_candidate_competency_test',args,b),busy);
  await a.exec('commit');await call('private.submit_candidate_competency_test',args,b);
  await h.asAdmin();assert.equal((await db.query('select count(*)::int n from private.competency_test_drafts where attempt_id=$1',[r.a.attemptId])).rows[0].n,0);
 });
 await t.test('revoke versus submit in both orders; receipt denied after revoke',async()=>{
  for(const revokeFirst of [false,true]){
   const r=await e.started(),a=await e.connect(r.f.owner),b=await e.connect(null);await actor(a,r.f.owner);await e.asGateway(b);
   const args=[hash(r.s.session),JSON.stringify({workSample:'Plan wdrożenia.'}),randomUUID()];
   if(revokeFirst){await a.exec('begin');await call('public.revoke_competency_test_grant',[r.g.grantId,randomUUID()],a);await assert.rejects(call('private.submit_candidate_competency_test',args,b),busy);await a.exec('commit');await assert.rejects(call('private.submit_candidate_competency_test',args,b),denied);}
   else{await b.exec('begin');await call('private.submit_candidate_competency_test',args,b);await assert.rejects(call('public.revoke_competency_test_grant',[r.g.grantId,randomUUID()],a),busy);await b.exec('commit');await call('public.revoke_competency_test_grant',[r.g.grantId,randomUUID()],a);await assert.rejects(call('private.status_candidate_competency_test',[hash(r.s.session)],b),denied);}
  }
 });
 await t.test('B2 candidate locks conflict with actual freeze; freeze denies every candidate/staff surface',async()=>{
  const r=await e.submitted();await h.asUser(r.f.owner);await e.x.policy(r.f,0,lifecycleRules);r.f.resolutionId=await e.x.resolve(r.f,[r.f.candidate.id]);
  const a=await e.connect(null);await e.asGateway(a);await a.exec('begin');await call('private.status_candidate_competency_test',[hash(r.s.session)],a);
  await assert.rejects(e.x.freeze(r.f),busy);await a.exec('commit');await e.x.freeze(r.f);
  await assert.rejects(call('private.status_candidate_competency_test',[hash(r.s.session)],a),denied);
  await h.asUser(r.f.owner);await assert.rejects(call('public.read_competency_test_response',[r.a.attemptId]),denied);await assert.rejects(call('public.save_competency_test_review',[r.a.attemptId,0,JSON.stringify(observations)]),denied);
 });
 // Successful operations commit, so the later authority check uses current
 // revision/version or a second untouched grant. A business conflict must not
 // masquerade as the expected PT404 denial after revocation of authority.
 const staffFixture=async operation=>{
  const r=await e.submitted();
  const issueTargets=operation==='issue'?[await e.seed({tenant:r.f}),await e.seed({tenant:r.f})]:null;
  const secondRevoke=operation==='revoke'?await e.submitted({tenant:r.f}):null;
  const run=(client,committed=false)=>{
   if(operation==='issue'){
    const f=issueTargets[Number(committed)];
    return call('public.create_competency_test_grant',[f.application.id,f.definitionId,new Date(Date.now()+3600000),randomUUID()],client);
   }
   if(operation==='rotate')return call('public.rotate_competency_test_grant',[r.g.grantId,committed?2:1,randomUUID()],client);
   if(operation==='revoke')return call('public.revoke_competency_test_grant',[(committed?secondRevoke:r).g.grantId,randomUUID()],client);
   if(operation==='read')return call('public.read_competency_test_response',[r.a.attemptId],client);
   return call('public.save_competency_test_review',[r.a.attemptId,committed?1:0,JSON.stringify(observations)],client);
  };
  const assertSuccess=result=>{
   if(operation==='read')assert.ok(result.workSample);
   else if(operation==='review')assert.match(result,/^[0-9a-f-]{36}$/);
   else if(operation==='revoke')assert.equal(result.revoked,true);
   else assert.ok(result.grantId);
  };
  return {r,run,assertSuccess};
 };
 await t.test('all staff surfaces serialize with owner RLS membership UPDATE and DELETE in both orders',async t=>{
  for(const operation of ['issue','rotate','revoke','read','review'])for(const mutation of ['update','delete'])for(const operationFirst of [true,false])
   await t.test(`${operation} / membership ${mutation} / ${operationFirst?'operation':'owner mutation'} first`,async()=>{
    const {r,run,assertSuccess}=await staffFixture(operation);
    // Both setup and contested DML execute through actual authenticated-owner
    // grants and RLS, including their SELECT policy / WITH CHECK paths.
    await h.asUser(r.f.owner);
    await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter'),($1,$3,'recruiter')",[r.f.companyId,users.recruiter,users.viewer]);
    const a=await e.connect(users.recruiter),b=await e.connect(r.f.owner);
    await actor(a,users.recruiter);await actor(b,r.f.owner);await b.exec("set lock_timeout='100ms'");
    assert.deepEqual((await b.query('select current_user as role,auth.uid() as actor')).rows[0],{role:'authenticated',actor:r.f.owner});
    const change=async()=>{
     const result=mutation==='update'
      ?await b.query("update public.company_members set role='viewer' where company_id=$1 and user_id=$2",[r.f.companyId,users.recruiter])
      :await b.query('delete from public.company_members where company_id=$1 and user_id=$2',[r.f.companyId,users.recruiter]);
     assert.equal(result.rowCount,1,'Owner RLS must actually mutate the membership');
    };
    try{
     if(operationFirst){
      await a.exec('begin');assertSuccess(await run(a));
      // The RPC has returned, but the membership lock lives until COMMIT.
      await assert.rejects(change(),busy);await a.exec('commit');await change();
     }else{
      await b.exec('begin');await change();await assert.rejects(run(a),busy);await b.exec('commit');
     }
     await assert.rejects(run(a,operationFirst),error=>error.code==='PT404');
     const membership=(await b.query('select role from public.company_members where company_id=$1 and user_id=$2',[r.f.companyId,users.recruiter])).rows;
     assert.deepEqual(membership,mutation==='update'?[{role:'viewer'}]:[]);
     // An independently authorized recruiter still succeeds on the same
     // company after the old recruiter's role change or membership deletion.
     await actor(a,users.viewer);assertSuccess(await run(a,operationFirst));
    }finally{await a.exec('rollback');await b.exec('rollback');await a.end();await b.end();}
   });
 });
 await t.test('server deadline, replay after start-by and receipt after deadline',async()=>{
  const f=await e.seed({duration:1}),g=await e.issue(f,{startBy:new Date(Date.now()+5000).toISOString()}),s=await e.exchange(g),key=randomUUID();
  const a=await call('private.start_candidate_competency_test',[hash(s.session),key]);
  const r=await e.started({duration:1});
  await new Promise(resolve=>setTimeout(resolve,5200));await e.asGateway();
  assert.equal((await call('private.start_candidate_competency_test',[hash(s.session),key])).deadlineAt,a.deadlineAt);
  const receipt=await call('private.submit_candidate_competency_test',[hash(s.session),JSON.stringify({workSample:'Plan po start-by.'}),randomUUID()]);
  await call('private.save_candidate_competency_test_draft',[hash(r.s.session),'zachowaj po terminie',0,randomUUID()]);
  const wait=Math.max(new Date(a.deadlineAt),new Date(r.a.deadlineAt))-Date.now()+100;
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,wait)));
  assert.deepEqual(await call('private.status_candidate_competency_test',[hash(s.session)]),receipt);
  assert.deepEqual(await call('private.submit_candidate_competency_test',[hash(s.session),JSON.stringify({workSample:'Plan po start-by.'}),randomUUID()]),receipt);
  await assert.rejects(call('private.submit_candidate_competency_test',[hash(r.s.session),JSON.stringify({workSample:'Plan za późno.'}),randomUUID()]),denied);
  await h.asAdmin();const row=(await db.query('select a.state,a.submitted_at,d.draft_text from public.competency_test_attempts a join private.competency_test_drafts d on d.attempt_id=a.id where a.id=$1',[r.a.attemptId])).rows[0];
  assert.equal(row.state,'in_progress');assert.equal(row.submitted_at,null);assert.equal(row.draft_text,'zachowaj po terminie');
 });
 await t.test('all staff surfaces serialize with owner transfer in both orders',async t=>{
  await h.asAdmin();
  assert.equal((await db.query("select has_column_privilege('authenticated','public.companies','owner_id','UPDATE') allowed")).rows[0].allowed,false,
   'Ownership transfer is not an authenticated DML capability in this schema');
  for(const operation of ['issue','rotate','revoke','read','review'])for(const operationFirst of [true,false])
   await t.test(`${operation} / owner transfer / ${operationFirst?'operation':'transfer'} first`,async()=>{
    const {r,run,assertSuccess}=await staffFixture(operation),a=await e.connect(r.f.owner),b=await e.connect(null);
    await actor(a,r.f.owner);await b.exec("set lock_timeout='100ms'");
    // Only transfer uses the isolated administrator: authenticated users have
    // UPDATE(name), never UPDATE(owner_id). The B2 calls remain authenticated.
    const transfer=async()=>{
     const result=await b.query('update public.companies set owner_id=$1 where id=$2',[users.otherOwner,r.f.companyId]);
     assert.equal(result.rowCount,1);
    };
    try{
     if(operationFirst){
      await a.exec('begin');assertSuccess(await run(a));
      await assert.rejects(transfer(),busy);await a.exec('commit');await transfer();
     }else{
      await b.exec('begin');await transfer();await assert.rejects(run(a),busy);await b.exec('commit');
     }
     assert.equal((await b.query('select owner_id from public.companies where id=$1',[r.f.companyId])).rows[0].owner_id,users.otherOwner);
     await assert.rejects(run(a,operationFirst),error=>error.code==='PT404');
     await actor(a,users.otherOwner);assertSuccess(await run(a,operationFirst));
    }finally{await a.exec('rollback');await b.exec('rollback');await a.end();await b.end();}
   });
 });
});
