import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {setupRankingDatabase,users} from './helpers/screening-ranking-fixture.mjs';
import {lifecycleHarness,lifecycleRules} from './helpers/erasure-lifecycle-fixture.mjs';
import {assertAcceptedErasureSchema} from './helpers/erasure-preview-fixture.mjs';
const conflict=error=>error.code==='PT409';

test('SC-010 R2 owner authorization, reversible lifecycle and guarded candidate graph',async t=>{
 const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
 await db.exec('create role service_role nologin bypassrls');
 const h=await setupRankingDatabase(db),l=lifecycleHarness(h);
 await assertAcceptedErasureSchema(h,t);
 await t.test('only current owner can issue tickets, freeze, inspect or cancel; private helpers cannot be invoked',async()=>{
  const f=await l.ready(),p=await l.ticket(f);
  for(const [id,role]of [[users.recruiter,'recruiter'],[users.viewer,'viewer']])await h.insert('company_members',{company_id:f.companyId,user_id:id,role});
  for(const actor of [users.recruiter,users.viewer,users.otherOwner,users.outsider]){
   await h.asUser(actor);await assert.rejects(l.ticket(f));await assert.rejects(l.authorize(f,p));await assert.rejects(l.status(f));
  }
  await h.asUser(f.owner);const request=await l.authorize(f,p),state=await l.status(f);
  for(const actor of [users.recruiter,users.viewer,users.otherOwner,users.outsider]){await h.asUser(actor);await assert.rejects(l.cancel(f,request,state.generation));await assert.rejects(db.query('select public.get_erasure_status($1)',[request]));}
  for(const role of ['anon','screening_worker','contact_verifier','service_role']){
   await h.asAdmin();await db.exec(`set role ${role}`);
   for(const op of [()=>l.ticket(f),()=>l.authorize(f,p),()=>l.status(f),()=>l.cancel(f,request,state.generation)])await assert.rejects(op());
  }
  await h.asAdmin();const tables=(await db.query("select tablename from pg_tables where schemaname='private' and tablename like 'erasure_%'")).rows;
  for(const {tablename}of tables)for(const privilege of ['SELECT','INSERT','UPDATE','DELETE'])assert.equal((await db.query('select has_table_privilege($1,$2,$3) allowed',['authenticated',`private.${tablename}`,privilege])).rows[0].allowed,false,`${tablename} ${privilege}`);
  await h.asUser(f.owner);await l.cancel(f,request,state.generation);
 });
 await t.test('forged RLS helper rows and denial targets cannot reveal foreign candidate state',async()=>{
  const own=await l.ready(),foreign=await l.ready({owner:users.otherOwner});
  await h.asUser(own.owner);
  for(const id of [foreign.candidate.id,randomUUID()]){
   assert.equal((await db.query('select private.erasure_row_visible($1,$2::jsonb) value',['public.candidates',JSON.stringify({id,company_id:own.companyId})])).rows[0].value,false);
   assert.equal((await db.query('select private.candidate_workflow_visible($1,$2) value',[own.companyId,id])).rows[0].value,true);
  }
  const rejection=async id=>{try{await l.v.permission({...foreign,candidate:{id}},'revoked');assert.fail('foreign denial must fail');}catch(error){return {code:error.code,message:error.message};}};
  assert.deepEqual(await rejection(foreign.candidate.id),await rejection(randomUUID()));
  await l.freeze(foreign);await h.asUser(own.owner);
  assert.equal((await db.query('select private.candidate_workflow_visible($1,$2) value',[own.companyId,foreign.candidate.id])).rows[0].value,true);
  assert.equal((await db.query('select private.erasure_row_visible($1,$2::jsonb) value',['public.candidates',JSON.stringify({id:foreign.candidate.id,company_id:own.companyId})])).rows[0].value,false);
 });
 await t.test('ticket requires server state; expiry, content/policy/resolution edits and ownership transfer invalidate authorization',async()=>{
  const f=await l.ready();await assert.rejects(l.authorize(f,{preview_ticket_id:randomUUID()}));
  const p=await l.ticket(f);await db.query('update public.candidates set email=$1 where id=$2',['changed@example.test',f.candidate.id]);await assert.rejects(l.authorize(f,p),conflict);
  let next=await l.ticket(f);await l.policy(f,1,lifecycleRules.map(x=>({...x,duration_days:31})));await assert.rejects(l.authorize(f,next),conflict);
  next=await l.ticket(f);await l.resolve(f,[f.candidate.id],1);await assert.rejects(l.authorize(f,next),conflict);
  const oldResolutionTicket=await l.ticket(f);await assert.rejects(l.authorize(f,oldResolutionTicket),conflict);
  f.resolutionId=await l.resolve(f,[f.candidate.id],2);
  const expires=await l.ticket(f);await h.asAdmin();await db.exec('begin');
  try{
   // Privileged fault injection only, rolled back. Application roles have no table access.
   await db.exec('alter table private.erasure_preview_tickets disable trigger immutable_history');
   await db.query("update private.erasure_preview_tickets set expires_at=clock_timestamp()-interval '1 second' where id=$1",[expires.preview_ticket_id]);
   await h.asUser(f.owner);await assert.rejects(l.authorize(f,expires),conflict);
  }finally{await db.exec('rollback');await h.asUser(f.owner);}
  next=await l.ticket(f);await h.asAdmin();await db.query('update public.companies set owner_id=$1 where id=$2',[users.otherOwner,f.companyId]);await h.asUser(f.owner);await assert.rejects(l.authorize(f,next));
  await h.asUser(users.otherOwner);await assert.rejects(l.authorize(f,next));
 });
 await t.test('request/cancel retries are exact, cancel increases generation and old tickets cannot refreeze',async()=>{
  const f=await l.ready(),p=await l.ticket(f),otherTicket=await l.ticket(f),key=randomUUID(),request=await l.authorize(f,p,key);
  await assert.rejects(l.authorize(f,otherTicket,key),conflict);
  assert.equal(await l.authorize(f,p,key),request);const frozen=await l.status(f);assert.equal(frozen.status,'authorized');assert.equal(frozen.execution_enabled,false);assert.equal(frozen.phase,'local_frozen');
  const listed=(await db.query('select public.list_candidate_erasure_requests($1) value',[f.companyId])).rows[0].value;assert.equal(listed.length,1);assert.equal(listed[0].request_id,request);assert.ok(!JSON.stringify(listed).includes(f.candidate.id));
  await assert.rejects(l.cancel(f,request,frozen.generation+1),conflict);const cancelKey=randomUUID();
  assert.equal(await l.cancel(f,request,frozen.generation,cancelKey),request);assert.equal(await l.cancel(f,request,frozen.generation,cancelKey),request);
  const cancelled=await l.status(f);assert.equal(cancelled.status,'cancelled');assert.ok(cancelled.generation>frozen.generation);
  await assert.rejects(l.authorize(f,p),conflict);assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1',[f.candidate.id])).rows[0].n,1);
  const next=await l.freeze(f);assert.notEqual(next.request_id,request);await h.asAdmin();assert.ok((await db.query('select generation from private.erasure_candidate_lifecycle where candidate_id=$1',[f.candidate.id])).rows[0].generation>cancelled.generation);await h.asUser(f.owner);
  await l.cancel(f,next.request_id,next.generation);
 });
 await t.test('confirmed subject freezes exactly its reviewed IDs; active work, unknown schema and overlaps fail closed',async()=>{
  const f=await l.ready(),duplicate=await h.candidate(f),unrelated=await h.candidate(f);
  f.resolutionId=await l.resolve(f,[f.candidate.id,duplicate.candidate.id],1);const state=await l.freeze(f);
  for(const id of [f.candidate.id,duplicate.candidate.id])assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1',[id])).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1',[unrelated.candidate.id])).rows[0].n,1);
  await assert.rejects(l.ticket(duplicate,'candidate_record',null));await l.cancel(f,state.request_id,state.generation);
  const started=await h.start(f);await h.asUser(f.owner);const active=await l.ticket(f);await assert.rejects(l.authorize(f,active),conflict);assert.ok(started.attempt_id);
  const other=await l.ready();await h.asAdmin();await db.exec('begin');try{await db.exec('create table public.unmapped_lifecycle_copy(candidate_id uuid)');await h.asUser(other.owner);const drift=await l.ticket(other);await assert.rejects(l.authorize(other,drift),conflict);}finally{await db.exec('rollback');}
 });
 await t.test('frozen full graph disappears from RLS reads, ordinary lists and reports without deleting any rows',async()=>{
  const f=await l.ready({rich:true});const before=await l.snapshot();await h.asUser(f.owner);const state=await l.freeze(f);
  const tables=['candidates','candidate_documents','applications','candidate_assessments','behavior_assessment_entries','exercise_observation_entries','screening_analysis_versions','screening_analysis_attempts','screening_criterion_results','screening_result_reviews','screening_criterion_review_overrides','recruitment_shortlist_entries','candidate_contact_permissions','candidate_contact_preferences','candidate_communications','candidate_communication_events','candidate_communication_approvals'];
  for(const table of tables)assert.equal((await db.query(`select count(*)::int n from public.${table} where company_id=$1`,[f.companyId])).rows[0].n,0,table);
  assert.equal((await h.ranking(f)).length,0);assert.equal((await h.shortlist(f,true)).length,0);
  for(const read of [()=>l.v.list(f),()=>l.v.history(f.communicationId),()=>l.v.status(f.communicationId)]){try{const value=await read();assert.ok(!value||(Array.isArray(value)&&value.length===0));}catch(error){assert.ok(['PT403','PT404','PT409','42501'].includes(error.code),error.message);}}
  const analysis=before['public.screening_analysis_versions'].find(x=>x.id===f.analysis_id),attempt=before['public.screening_analysis_attempts'].find(x=>x.id===f.attempt_id);
  await assert.rejects(db.query('select * from public.start_screening_analysis($1,$2,1,1,$3,$4,$5,$6,$7)',[f.application.id,analysis.input_fingerprint,analysis.prompt_version,analysis.provider,analysis.model,analysis.model_revision,attempt.idempotency_key]),conflict);
  await assert.rejects(db.query('select * from public.retry_screening_analysis($1,$2)',[f.analysis_id,attempt.idempotency_key]),conflict);
  await assert.rejects(h.claim(f),conflict);await h.asWorker();
  await assert.rejects(db.query('select public.complete_screening_analysis($1,$2,$3,$4,$5::jsonb)',[f.attempt_id,'x'.repeat(32),'a'.repeat(64),'b'.repeat(64),'[]']),conflict);
  await assert.rejects(db.query('select public.fail_screening_attempt($1,$2,$3,$4,$5)',[f.attempt_id,'x'.repeat(32),'a'.repeat(64),'b'.repeat(64),'synthetic_failure']),conflict);
  await h.asAdmin();
  // Privileged DML proves the lifecycle trigger itself covers every adapter,
  // independently of the already-tested application grants and RLS policies.
  for(const table of [...tables.filter(x=>x!=='candidates').map(x=>`public.${x}`),'private.candidate_verified_contact_receipts','private.candidate_verified_contact_points','private.contact_audit','private.contact_requests']){
   const row=before[table].find(x=>x.company_id===f.companyId);assert.ok(row,table);
   const copy={...row,id:randomUUID(),request_key:randomUUID()};
   await assert.rejects(db.query(`insert into ${table} select (jsonb_populate_record(null::${table},$1::jsonb)).*`,[JSON.stringify(copy)]),error=>error.code==='PT409'&&/frozen/i.test(error.message),table);
  }
  const after=await l.snapshot();for(const [table,rows]of Object.entries(before))if(!table.startsWith('private.erasure_'))assert.deepEqual(after[table],rows,table);
  await h.asUser(f.owner);await l.cancel(f,state.request_id,state.generation);
  for(const table of tables)assert.ok((await db.query(`select count(*)::int n from public.${table} where company_id=$1`,[f.companyId])).rows[0].n>0,table);
 });
 await t.test('frozen graph rejects direct edits, new children, reparenting and cascades; active deletion is controlled too',async()=>{
  const f=await l.ready(),other=await h.candidate(f),state=await l.freeze(f);
  const mutations=[
   ()=>db.query('update public.candidates set email=$1 where id=$2',['bad@example.test',f.candidate.id]),
   ()=>db.query('insert into public.candidate_documents(company_id,candidate_id,source_text,redacted_text) values($1,$2,$3,$4)',[f.companyId,f.candidate.id,'late CV','late CV']),
   ()=>db.query('insert into public.applications(company_id,candidate_id,recruitment_id) values($1,$2,$3)',[f.companyId,f.candidate.id,f.recruitment.id]),
   ()=>db.query('update public.applications set candidate_id=$1 where id=$2',[f.candidate.id,other.application.id]),
   ()=>db.query('delete from public.recruitments where id=$1',[f.recruitment.id]),
   ()=>db.query('delete from public.positions where id=$1',[f.position.id]),
  ];
  // UPDATE may affect zero rows because RLS hides the frozen root; never allow a write.
  const hiddenUpdate=await mutations.shift()();assert.equal(hiddenUpdate.affectedRows??hiddenUpdate.rowCount,0);
  for(const mutate of mutations)await assert.rejects(mutate());
  await l.cancel(f,state.request_id,state.generation);
  await assert.rejects(db.query('delete from public.candidates where id=$1',[f.candidate.id]),conflict);
  await assert.rejects(db.query('delete from public.applications where id=$1',[f.application.id]),conflict);
  await assert.rejects(db.query('update public.candidates set id=$1 where id=$2',[randomUUID(),f.candidate.id]));
 });
 await t.test('freeze preserves B1 draft and approval; cancellation restores visibility but not independent denials',async()=>{
  const f=await l.v.ready();await l.policy(f,0,lifecycleRules);f.resolutionId=await l.resolve(f);
  const communication=await l.v.prepare(f),proof=l.v.receipt(f),receipt=await l.v.ingest(f,proof);await h.asUser(f.owner);await l.v.approve(communication,receipt);
  const state=await l.freeze(f);
  await db.query("select set_config('skillcheck.erasure_bypass','true',false)");
  await assert.rejects(l.v.prepare(f));await assert.rejects(l.v.permission(f,'unverified'));await assert.rejects(l.v.preferences(f));await assert.rejects(l.v.cancel(communication,2));await assert.rejects(l.v.ingest(f,proof));
  await h.asAdmin();const draft=(await db.query('select state,version from public.candidate_communications where id=$1',[communication])).rows[0];assert.equal(draft.state,'draft');assert.equal(draft.version,2);
  await h.asUser(f.owner);await l.cancel(f,state.request_id,state.generation);assert.equal((await l.v.list(f))[0].state,'draft');
  const again=await l.freeze(f);await l.v.permission(f,'revoked');await l.cancel(f,again.request_id,again.generation);assert.equal((await l.v.list(f))[0].state,'cancelled');assert.equal((await l.v.status(communication)).is_current,false);
 });
});
