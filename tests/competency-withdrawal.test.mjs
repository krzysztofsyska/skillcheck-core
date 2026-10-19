import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {boot,hash,users,observations,definition} from './helpers/competency-attempt-fixture.mjs';

const deny=async action=>assert.rejects(action,error=>['42501','PT404','PT409'].includes(error.code));
const withdraw=(env,scope,key=randomUUID())=>env.call('public.withdraw_competency_test_access',[scope,key]);
const appScope=f=>({kind:'application',application_id:f.application.id,reason:'candidate_withdrawn'});
const subjectScope=(resolution,revision=1)=>({kind:'confirmed_subject',resolution_id:resolution,resolution_revision:revision,reason:'consent_withdrawn'});
const resolve=async(env,f,ids,revision=0,key=randomUUID())=>{
 await env.h.asUser(f.owner);
 return env.call('public.confirm_erasure_subject',[f.candidate.id,ids,revision,key]);
};
async function otherApplication(env,f){
 await env.h.asUser(f.owner);
 const recruitment=await env.h.insert('recruitments',{company_id:f.companyId,position_id:f.position.id,name:'Other synthetic recruitment',status:'open'});
 const application=await env.h.insert('applications',{company_id:f.companyId,recruitment_id:recruitment.id,candidate_id:f.candidate.id});
 const definitionId=await env.call('public.save_exercise_definition',[recruitment.id,randomUUID(),definition(),0,f.position.id,f.position.updated_at]);
 return {...f,recruitment,application,definitionId};
}

test('B2 T8/T11 withdrawal, protected status boundary and subject propagation',async t=>{
 const env=await boot(t),{db,h,call}=env;
 await t.test('application cancellation is atomic, permanent, idempotent, scoped and hides retained responses',async()=>{
  const {f,g,s,receipt}=await env.submitted();
  const sibling=await otherApplication(env,f),otherGrant=await env.issue(sibling);
  await h.asUser(f.owner);
  const review=await call('public.save_competency_test_review',[receipt.attemptId,0,observations]);
  assert.ok(review);
  const key=randomUUID(),result=await withdraw(env,appScope(f),key);
  assert.deepEqual(await withdraw(env,appScope(f),key),result);
  await deny(()=>call('public.read_competency_test_response',[receipt.attemptId]));
  await deny(()=>call('public.save_competency_test_review',[receipt.attemptId,1,observations]));
  await db.query("update public.applications set status='new' where id=$1",[f.application.id]);
  await deny(()=>env.issue(f));
  await env.asGateway();
  await deny(()=>call('private.status_candidate_competency_test',[hash(s.session)]));
  await deny(()=>call('private.exchange_candidate_competency_test_session',[g.token]));
  const siblingSession=await env.exchange(otherGrant);
  assert.ok(siblingSession.session,'application withdrawal preserves another recruitment for the same candidate');
  await h.asAdmin();
  const saved=(await db.query('select * from private.competency_test_cancellations where id=$1',[result.cancellationId])).rows[0];
  assert.deepEqual(saved.candidate_ids,[f.candidate.id]);assert.equal(saved.actor_id,f.owner);assert.equal(saved.scope_kind,'application');
  assert.equal((await db.query('select count(*)::int n from private.competency_test_cancellations where request_key=$1',[key])).rows[0].n,1);
  assert.equal((await db.query('select competency_access_cancelled_at from public.candidates where id=$1',[f.candidate.id])).rows[0].competency_access_cancelled_at,null);
  assert.equal((await db.query("select count(*)::int n from private.competency_test_grant_events where grant_id=$1 and kind='revoked'",[g.grantId])).rows[0].n,1);
  await assert.rejects(db.query('update private.competency_test_cancellations set reason=$1 where id=$2',['consent_withdrawn',result.cancellationId]),{code:'42501'});
 });
 await t.test('direct INSERT UPDATE upsert and GUC or role spoof cannot enter withdrawn or write markers',async()=>{
  const f=await env.seed(),newCandidate=await h.insert('candidates',{company_id:f.companyId,first_name:'Synthetic',last_name:'Import'});
  await db.query("select set_config('skillcheck.competency_withdrawal','true',false)");
  await assert.rejects(db.query("update public.applications set status='withdrawn' where id=$1",[f.application.id]),{code:'42501'});
  await assert.rejects(h.insert('applications',{company_id:f.companyId,recruitment_id:f.recruitment.id,candidate_id:newCandidate.id,status:'withdrawn'}),{code:'42501'});
  await assert.rejects(db.query(`insert into public.applications(id,company_id,recruitment_id,candidate_id,status)
   values($1,$2,$3,$4,'withdrawn') on conflict(id) do update set status=excluded.status`,[f.application.id,f.companyId,f.recruitment.id,f.candidate.id]),{code:'42501'});
  // SET ROLE checks SESSION_USER, so a test that merely SET ROLEs from the
  // installer would retain the installer's role-switch power. Actual login
  // denial is tested separately on PostgreSQL; here verify the role graph.
  assert.equal((await db.query("select pg_has_role('authenticated','competency_test_marker_writer','member') allowed")).rows[0].allowed,false);
  await assert.rejects(db.query("select private.competency_write_markers($1,$2::uuid[],$3::uuid[],'candidate_withdrawn',true,true)",[f.companyId,[f.candidate.id],[f.application.id]]),{code:'42501'});
  await h.asAdmin();
  await assert.rejects(db.query("update public.candidates set competency_access_cancelled_at=clock_timestamp(),competency_access_cancel_reason='candidate_withdrawn' where id=$1",[f.candidate.id]),{code:'42501'});
  await h.asUser(f.owner);
  await db.query("update public.applications set status='rejected' where id=$1",[f.application.id]);
  await db.query("update public.applications set status='hired' where id=$1",[f.application.id]);
  assert.equal((await db.query('select competency_access_cancelled_at from public.applications where id=$1',[f.application.id])).rows[0].competency_access_cancelled_at,null);
 });
 await t.test('two companies and owner/recruiter boundary; no arbitrary subject list accepted',async()=>{
  const f=await env.seed(),foreign=await env.seed({owner:users.otherOwner});
  await h.asAdmin();
  await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter'),($1,$3,'viewer')",[f.companyId,users.recruiter,users.viewer]);
  for(const actor of [users.viewer,users.outsider,users.otherOwner]){
   await h.asUser(actor);await deny(()=>withdraw(env,appScope(f)));
  }
  await h.asUser(users.recruiter);await deny(()=>withdraw(env,appScope(foreign)));
  await withdraw(env,appScope(f));
  const resolution=await resolve(env,f,[f.candidate.id]);
  await h.asUser(users.recruiter);await deny(()=>withdraw(env,subjectScope(resolution)));
  await h.asUser(f.owner);
  await assert.rejects(withdraw(env,{...subjectScope(resolution),candidate_ids:[foreign.candidate.id]}),{code:'PT422'});
  await withdraw(env,subjectScope(resolution));
 });
 await t.test('confirmed scope blocks every saved response and propagates through later confirm, new anchors and trusted inserts',async()=>{
  const a=await env.submitted(),b=await env.submitted({tenant:a.f}),unrelated=await env.started({tenant:a.f});
  await h.asUser(a.f.owner);
  await call('public.save_competency_test_review',[a.receipt.attemptId,0,observations]);
  await call('public.save_competency_test_review',[b.receipt.attemptId,0,observations]);
  const ids=[a.f.candidate.id,b.f.candidate.id].sort(),resolution=await resolve(env,a.f,ids);
  await withdraw(env,subjectScope(resolution));
  for(const item of [a,b]){
   await deny(()=>call('public.read_competency_test_response',[item.receipt.attemptId]));
   await deny(()=>call('public.save_competency_test_review',[item.receipt.attemptId,1,observations]));
   await deny(()=>env.issue(item.f));
   await env.asGateway();await deny(()=>call('private.status_candidate_competency_test',[hash(item.s.session)]));
   await h.asUser(a.f.owner);
  }
  const later=await env.started({tenant:a.f});
  const extended=[...ids,later.f.candidate.id].sort();
  const key=randomUUID(),linked=await resolve(env,a.f,extended,1,key);
  assert.equal(await resolve(env,a.f,extended,1,key),linked,'confirm remains idempotent');
  await env.asGateway();await deny(()=>call('private.inspect_candidate_competency_test',[hash(later.s.session)]));
  const shrink=await resolve(env,a.f,[a.f.candidate.id],2);
  assert.ok(shrink);
  const newAnchor=await env.started({tenant:a.f});
  await resolve(env,newAnchor.f,[newAnchor.f.candidate.id,a.f.candidate.id]);
  await env.asGateway();await deny(()=>call('private.inspect_candidate_competency_test',[hash(newAnchor.s.session)]));
  const imported=await env.started({tenant:a.f});
  // Simulates a future trusted helper inserting a link. The BEFORE INSERT
  // guard must propagate even without calling public.confirm_erasure_subject.
  await env.actor(db,a.f.owner);
  await db.query(`insert into private.erasure_subject_resolutions(company_id,anchor_candidate_id,candidate_ids,revision,confirmed_by)
   values($1,$2,$3::uuid[],1,$4)`,[a.f.companyId,imported.f.candidate.id,[imported.f.candidate.id,a.f.candidate.id],a.f.owner]);
  await env.asGateway();await deny(()=>call('private.inspect_candidate_competency_test',[hash(imported.s.session)]));
  const unaffected=await call('private.inspect_candidate_competency_test',[hash(unrelated.s.session)]);
  assert.equal(unaffected.state,'in_progress');
  await h.asAdmin();
  const all=[...extended,newAnchor.f.candidate.id,imported.f.candidate.id];
  assert.equal((await db.query('select count(*)::int n from public.candidates where id=any($1::uuid[]) and competency_access_cancelled_at is not null',[all])).rows[0].n,all.length);
  const links=(await db.query("select candidate_ids from private.competency_test_cancellations where company_id=$1 and scope_kind='resolution_link'",[a.f.companyId])).rows;
  assert.ok(links.some(row=>row.candidate_ids.includes(imported.f.candidate.id)));
 });
 for(const publisher of ['confirm','trusted_insert'])await t.test(`linking two existing groups withdraws their full transitive scope via ${publisher}`,async()=>{
  const a=await env.started(),b=await env.started({tenant:a.f}),c=await env.started({tenant:a.f});
  const d=await env.submitted({tenant:a.f}),unrelated=await env.started({tenant:a.f});
  const groupOne=[a.f.candidate.id,b.f.candidate.id].sort(),groupTwo=[c.f.candidate.id,d.f.candidate.id].sort();
  const ar=await resolve(env,a.f,groupOne),cr=await resolve(env,c.f,groupTwo);
  await call('public.save_competency_test_review',[d.receipt.attemptId,0,observations]);
  await withdraw(env,subjectScope(ar));
  await env.asGateway();
  assert.equal((await call('private.status_candidate_competency_test',[hash(d.s.session)])).state,'submitted','unlinked group still has access before linking');
  let linked;
  if(publisher==='confirm')linked=await resolve(env,a.f,[a.f.candidate.id,c.f.candidate.id],1);
  else{
   await env.actor(db,a.f.owner);
   linked=(await db.query(`insert into private.erasure_subject_resolutions(company_id,anchor_candidate_id,candidate_ids,revision,confirmed_by)
    values($1,$2,$3::uuid[],2,$4) returning id`,[a.f.companyId,a.f.candidate.id,[a.f.candidate.id,c.f.candidate.id],a.f.owner])).rows[0].id;
  }
  await env.asGateway();
  for(const item of [a,b,c])await deny(()=>call('private.inspect_candidate_competency_test',[hash(item.s.session)]));
  await deny(()=>call('private.status_candidate_competency_test',[hash(d.s.session)]));
  assert.equal((await call('private.inspect_candidate_competency_test',[hash(unrelated.s.session)])).state,'in_progress');
  await h.asUser(a.f.owner);
  await deny(()=>call('public.read_competency_test_response',[d.receipt.attemptId]));
  await deny(()=>call('public.save_competency_test_review',[d.receipt.attemptId,1,observations]));
  await h.asAdmin();
  const complete=[...groupOne,...groupTwo].sort();
  const audit=(await db.query("select candidate_ids from private.competency_test_cancellations where resolution_id=$1 and scope_kind='resolution_link'",[linked])).rows;
  assert.deepEqual(audit.map(row=>row.candidate_ids),[complete],'audit records the full affected scope, not just the two new link IDs');
  assert.equal((await db.query('select count(*)::int n from public.candidates where id=any($1::uuid[]) and competency_access_cancelled_at is not null',[complete])).rows[0].n,4);
  assert.equal((await db.query('select count(*)::int n from private.competency_test_grants where candidate_id=any($1::uuid[]) and revoked_at is not null',[complete])).rows[0].n,4);
  assert.equal((await db.query('select count(*)::int n from private.competency_test_sessions where candidate_id=any($1::uuid[]) and invalidated_at is not null',[complete])).rows[0].n,4);
  await assert.rejects(db.query('update private.erasure_subject_resolutions set candidate_ids=$1::uuid[] where id=$2',[[c.f.candidate.id,unrelated.f.candidate.id],cr]),{code:'42501'},'immutable resolutions cannot bypass propagation by UPDATE');
  assert.equal((await db.query('select competency_access_cancelled_at from public.candidates where id=$1',[unrelated.f.candidate.id])).rows[0].competency_access_cancelled_at,null);
 });
 await t.test('stale revisions and A/B–B/C overlap fail until owner confirms the complete scope',async()=>{
  const a=await env.seed(),b=await env.seed({tenant:a}),c=await env.seed({tenant:a});
  const ab=await resolve(env,a,[a.candidate.id,b.candidate.id]);
  await resolve(env,b,[b.candidate.id,c.candidate.id]);
  await assert.rejects(withdraw(env,subjectScope(ab)),{code:'PT409'});
  const all=await resolve(env,a,[a.candidate.id,b.candidate.id,c.candidate.id],1);
  await assert.rejects(withdraw(env,subjectScope(ab)),{code:'PT409'});
  await assert.rejects(withdraw(env,subjectScope(all)),{code:'PT409'});
  await withdraw(env,subjectScope(all,2));
 });
 await t.test('candidate with no applications stays withdrawn when a new recruitment/application appears',async()=>{
  const tenant=await env.seed();await h.asUser(tenant.owner);
  const person=await h.insert('candidates',{company_id:tenant.companyId,first_name:'Synthetic',last_name:'No application'});
  const f={...tenant,candidate:person};
  const resolution=await resolve(env,f,[person.id]);await withdraw(env,subjectScope(resolution));
  const later=await otherApplication(env,f);
  await deny(()=>env.issue(later));
 });
 await t.test('audit failure rolls back status, marker, grant and session changes',async()=>{
  const {f,g,s}=await env.started();await h.asAdmin();
  await db.exec(`create function private.synthetic_reject_cancellation() returns trigger language plpgsql as $$
   begin raise exception using errcode='PT422',message='Synthetic audit failure';end;$$;
   create trigger zz_synthetic_reject_cancellation before insert on private.competency_test_cancellations
   for each row execute function private.synthetic_reject_cancellation()`);
  try{
   await h.asUser(f.owner);
   await assert.rejects(withdraw(env,appScope(f)),{code:'PT422'});
   await env.asGateway();assert.equal((await call('private.inspect_candidate_competency_test',[hash(s.session)])).state,'in_progress');
   await h.asAdmin();
   assert.equal((await db.query('select revoked_at from private.competency_test_grants where id=$1',[g.grantId])).rows[0].revoked_at,null);
   const app=(await db.query('select status,competency_access_cancelled_at from public.applications where id=$1',[f.application.id])).rows[0];
   assert.equal(app.status,'new');assert.equal(app.competency_access_cancelled_at,null);
  }finally{await h.asAdmin();await db.exec('drop trigger zz_synthetic_reject_cancellation on private.competency_test_cancellations;drop function private.synthetic_reject_cancellation()');}
 });
});

test('B2 T11 legacy withdrawn rows receive persistent marker and explicit installation audit',async t=>{
 let historical;
 const env=await boot(t,{beforeWithdrawal:async(_db,h)=>{
  historical=await h.seed();await h.asUser(historical.owner);
  await _db.query("update public.applications set status='withdrawn' where id=$1",[historical.application.id]);
  await h.asAdmin();
 }});
 const {db,h}=env;await h.asAdmin();
 const row=(await db.query('select * from public.applications where id=$1',[historical.application.id])).rows[0];
 assert.ok(row.competency_access_cancelled_at);assert.equal(row.competency_access_cancel_reason,'candidate_withdrawn');
 const audit=(await db.query("select * from private.competency_test_cancellations where application_id=$1 and scope_kind='historical_withdrawn'",[historical.application.id])).rows[0];
 assert.equal(audit.actor_id,historical.owner);assert.deepEqual(audit.candidate_ids,[historical.candidate.id]);
 await h.asUser(historical.owner);
 await db.query("update public.applications set status='new' where id=$1",[historical.application.id]);
 assert.ok((await db.query('select competency_access_cancelled_at from public.applications where id=$1',[historical.application.id])).rows[0].competency_access_cancelled_at);
});
