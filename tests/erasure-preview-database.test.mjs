import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {setupRankingDatabase,users} from './helpers/screening-ranking-fixture.mjs';
import {erasureHarness,retentionRules,assertAcceptedErasureSchema} from './helpers/erasure-preview-fixture.mjs';
const conflict=error=>error.code==='PT409';
const count=(p,table)=>Number(p.counts[table]??0);

test('SC-010 R1 owner-reviewed scope and read-only fail-closed inventory',async t=>{
 const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
 const h=await setupRankingDatabase(db),e=erasureHarness(h);
 await assertAcceptedErasureSchema(h,t);
 await t.test('missing policy is explicit and preview has finite TTL without authorizing execution',async()=>{
  const f=await h.seed(),p=await e.preview(f);
  assert.ok(p.blockers.includes('retention_policy_required'));assert.ok(p.blockers.includes('subject_resolution_required'));
  for(const blocker of ['execution_not_implemented','external_inventory_unverified','backup_policy_unverified'])assert.ok(p.blockers.includes(blocker));
  assert.match(p.manifest_hash,/^[0-9a-f]{64}$/);assert.match(p.schema_signature,/^[0-9a-f]{64}$/);
  const ttl=Date.parse(p.expires_at)-Date.parse(p.generated_at);assert.ok(ttl>0&&ttl<=300000);
  assert.equal(p.policy_revision,0);assert.equal(p.candidate_count,1);assert.equal(p.scope_kind,'candidate_record');
  const functions=(await db.query("select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname ~ '(erasure|retention)' order by proname")).rows.map(x=>x.proname);
  assert.ok(!functions.some(x=>/purge|execute|authorize|request_candidate/.test(x)));
 });
 await t.test('owner policy records only explicit finite rules, versions and exact idempotent requests',async()=>{
  const f=await h.seed(),key=randomUUID(),id=await e.policy(f,0,retentionRules,key);
  assert.equal(await e.policy(f,0,retentionRules,key),id);assert.equal((await e.preview(f)).policy_revision,1);
  await assert.rejects(e.policy(f,0),conflict);
  await assert.rejects(e.policy(f,0,[{...retentionRules[0],duration_days:90}],key),conflict);
  const next=await e.policy(f,1,[{...retentionRules[0],duration_days:45}]);assert.notEqual(next,id);assert.equal((await e.preview(f)).policy_revision,2);
  for(const rules of [null,[],{},[null],[{...retentionRules[0],duration_days:0}],[{...retentionRules[0],duration_days:-1}],[{...retentionRules[0],duration_days:'30'}],[{...retentionRules[0],duration_days:1.5}],[{...retentionRules[0],hold_review_days:0}],[{...retentionRules[0],data_class:'unknown'}],[{...retentionRules[0],trigger_event:'whenever'}],[{...retentionRules[0],automatic:true}],retentionRules.concat(retentionRules)])await assert.rejects(e.policy(f,2,rules));
  const policy=await e.getPolicy(f);assert.ok(JSON.stringify(policy).includes('45'));assert.ok(!JSON.stringify(policy).includes('automatic'));
 });
 await t.test('recruiter/viewer/foreign owner/outsider/anonymous/workers cannot configure, resolve or preview',async()=>{
  const f=await h.seed();for(const [id,role]of [[users.recruiter,'recruiter'],[users.viewer,'viewer']])await h.insert('company_members',{company_id:f.companyId,user_id:id,role});
  for(const actor of [users.recruiter,users.viewer,users.otherOwner,users.outsider]){
   await h.asUser(actor);for(const operation of [()=>e.policy(f),()=>e.resolve(f),()=>e.preview(f),()=>e.getPolicy(f),()=>e.getResolution(f)])await assert.rejects(operation());
  }
  for(const role of ['anon','screening_worker','contact_verifier']){
   await h.asAdmin();await db.exec(`set role ${role}`);for(const operation of [()=>e.policy(f),()=>e.resolve(f),()=>e.preview(f),()=>e.getPolicy(f),()=>e.getResolution(f)])await assert.rejects(operation());
  }
  await h.asAdmin();const privateFunctions=(await db.query("select p.oid::regprocedure::text signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname ~ '(erasure|retention)'")).rows;
  for(const {signature}of privateFunctions)for(const role of ['anon','authenticated','screening_worker','contact_verifier'])assert.equal((await db.query('select has_function_privilege($1,$2,\'EXECUTE\') allowed',[role,signature])).rows[0].allowed,false,`${role}: ${signature}`);
 });
 await t.test('full graph includes every candidate copy and all five JSON request adapters, excluding shared configuration',async()=>{
  const f=await e.rich();await e.policy(f);const resolution=await e.resolve(f);
  const before=await e.snapshot();await h.asUser(f.owner);const p=await e.preview(f,'confirmed_subject',resolution);const again=await e.preview(f,'confirmed_subject',resolution);
  assert.ok(!p.blockers.includes('schema_dependency_unknown'));assert.equal(p.manifest_hash,again.manifest_hash);assert.equal(p.candidate_count,1);
  for(const table of ['public.candidates','public.candidate_documents','public.applications','public.candidate_assessments','public.behavior_assessment_entries','public.exercise_observation_entries','public.screening_analysis_versions','public.screening_analysis_attempts','public.screening_criterion_results','public.screening_result_reviews','public.screening_criterion_review_overrides','public.recruitment_shortlist_entries','public.candidate_contact_permissions','public.candidate_contact_preferences','public.candidate_communications','public.candidate_communication_events','public.candidate_communication_approvals','private.candidate_verified_contact_receipts','private.candidate_verified_contact_points','private.contact_audit'])assert.ok(count(p,table)>0,table);
  assert.equal(count(p,'private.contact_requests'),5);
  for(const table of ['public.companies','public.positions','public.recruitments','public.exercise_definition_entries','private.contact_trusted_issuers','private.contact_policy_templates'])assert.equal(count(p,table),0,table);
  for(const secret of ['PRIVATE','synthetic@example.test',f.candidate.id,f.application.id,f.receiptId])assert.ok(!JSON.stringify(p).includes(secret),secret);
  assert.deepEqual(await e.snapshot(),before,'preview must leave all persistent rows unchanged');
 });
 await t.test('duplicate resolution selects confirmed IDs, all applications and no automatic email matching',async()=>{
  const f=await h.seed(),duplicate=await h.candidate(f),unconfirmed=await h.candidate(f),other=await h.seed(users.otherOwner);
  await h.asUser(f.owner);await db.query('update public.candidates set email=$1 where company_id=$2',['same@example.test',f.companyId]);
  const recruitment=await h.insert('recruitments',{company_id:f.companyId,position_id:f.position.id,name:'Second process',status:'open'});
  await h.insert('applications',{company_id:f.companyId,candidate_id:f.candidate.id,recruitment_id:recruitment.id});
  await e.policy(f);const key=randomUUID(),resolution=await e.resolve(f,[duplicate.candidate.id,f.candidate.id],0,key);
  assert.equal(await e.resolve(f,[f.candidate.id,duplicate.candidate.id],0,key),resolution);
  const approvedScope=await e.getResolution(f);assert.deepEqual([...approvedScope.candidate_ids].sort(),[f.candidate.id,duplicate.candidate.id].sort());assert.equal(approvedScope.owner_current,true);
  const p=await e.preview(f,'confirmed_subject',resolution);assert.equal(p.candidate_count,2);assert.equal(count(p,'public.candidates'),2);assert.equal(count(p,'public.applications'),3);
  assert.equal((await e.preview(f)).candidate_count,1);assert.ok(!JSON.stringify(p).includes(other.candidate.id));assert.ok(!JSON.stringify(p).includes(unconfirmed.candidate.id));
  await assert.rejects(e.resolve(f,[f.candidate.id,other.candidate.id],1));await assert.rejects(e.resolve(f,[duplicate.candidate.id],1));await assert.rejects(e.resolve(f,[],1));
  await assert.rejects(e.resolve(f,[f.candidate.id],0),conflict);await assert.rejects(e.resolve(f,[f.candidate.id],0,key),conflict);
  await e.resolve(f,[f.candidate.id,duplicate.candidate.id,unconfirmed.candidate.id],1);
  const stale=await e.preview(f,'confirmed_subject',resolution);assert.ok(stale.blockers.includes('subject_resolution_changed'));
  await assert.rejects(e.preview(f,'confirmed_subject',randomUUID()));await assert.rejects(e.preview(f,'all_tenants',resolution));
 });
 await t.test('manifest changes with contents even when row counts stay constant and binds policy/resolution versions',async()=>{
  const f=await h.seed();await e.policy(f);let resolution=await e.resolve(f);let prior=await e.preview(f,'confirmed_subject',resolution);
  await db.query('update public.candidates set email=$1 where id=$2',['new@example.test',f.candidate.id]);let next=await e.preview(f,'confirmed_subject',resolution);assert.notEqual(next.manifest_hash,prior.manifest_hash);assert.deepEqual(next.counts,prior.counts);prior=next;
  await db.query('update public.candidate_documents set redacted_text=$1 where id=$2',['PRIVATE changed CV',f.documentId]);next=await e.preview(f,'confirmed_subject',resolution);assert.notEqual(next.manifest_hash,prior.manifest_hash);prior=next;
  await e.policy(f,1,[{...retentionRules[0],duration_days:40}]);next=await e.preview(f,'confirmed_subject',resolution);assert.notEqual(next.manifest_hash,prior.manifest_hash);prior=next;
  resolution=await e.resolve(f,[f.candidate.id],1);next=await e.preview(f,'confirmed_subject',resolution);assert.notEqual(next.manifest_hash,prior.manifest_hash);
 });
 await t.test('session timezone never changes a manifest but content edits still invalidate it',async()=>{
  const f=await h.seed();await e.policy(f);const resolution=await e.resolve(f);
  await db.exec("set timezone='UTC'");const baseline=await e.preview(f,'confirmed_subject',resolution);
  try{
   await db.exec("set datestyle='SQL, DMY'");
   for(const zone of ['Europe/Warsaw','America/Los_Angeles','Asia/Kolkata']){
    await db.query("select set_config('TimeZone',$1,false)",[zone]);
    const p=await e.preview(f,'confirmed_subject',resolution);assert.equal(p.manifest_hash,baseline.manifest_hash,zone);assert.deepEqual(p.counts,baseline.counts);
   }
   await db.query('update public.candidates set email=$1 where id=$2',['timezone-change@example.test',f.candidate.id]);
   assert.notEqual((await e.preview(f,'confirmed_subject',resolution)).manifest_hash,baseline.manifest_hash);
  }finally{await db.exec("set timezone='UTC';set datestyle='ISO, YMD'");}
 });
 await t.test('new table, column and external-schema incoming FK fail closed and affect schema manifest',async()=>{
  const f=await h.seed(),baseline=await e.preview(f);
  for(const ddl of ["create table public.unmapped_candidate_payload(id uuid,payload jsonb)","alter table public.candidates add column private_extra text", "create schema extra;create table extra.unmapped(candidate_id uuid references public.candidates(id))"]){
   await h.asAdmin();await db.exec('begin');try{await db.exec(ddl);await h.asUser(f.owner);const p=await e.preview(f);assert.ok(p.blockers.includes('schema_dependency_unknown'));assert.notEqual(p.schema_signature,baseline.schema_signature);assert.notEqual(p.manifest_hash,baseline.manifest_hash);}finally{await db.exec('rollback');}
  }
 });
 await t.test('missing inventory baseline fails closed with no counts',async()=>{
  const f=await h.seed();await h.asAdmin();await db.exec('begin');
  try{
   // Privileged corruption simulation, rolled back completely; product roles
   // cannot disable this trigger or mutate the baseline.
   await db.exec('alter table private.erasure_inventory_baseline disable trigger immutable_history;delete from private.erasure_inventory_baseline');
   await h.asUser(f.owner);const p=await e.preview(f);assert.ok(p.blockers.includes('schema_dependency_unknown'));assert.deepEqual(p.counts,{});
  }finally{await db.exec('rollback');}
 });
 await t.test('unknown and malformed JSON request operations are blockers, never UUID substring matching',async()=>{
  const f=await h.seed();
  for(const [operation,payload]of [['unrecognized',[f.candidate.id]],['permission',{candidate:f.candidate.id}],['draft',[`prefix-${f.application.id}`,randomUUID(),'email']]]){
   await h.asAdmin();await db.exec('begin');try{
    await db.query('insert into private.contact_requests(company_id,actor_id,operation,request_key,payload,result_id) values($1,$2,$3,$4,$5::jsonb,$6)',[f.companyId,f.owner,operation,randomUUID(),JSON.stringify(payload),randomUUID()]);
    await h.asUser(f.owner);const p=await e.preview(f);assert.ok(p.blockers.includes('contact_request_adapter_unknown'));
   }finally{await db.exec('rollback');}
  }
 });
 await t.test('active screening is reported without cancelling, freezing or hiding candidate data',async()=>{
  const f=await h.seed(),started=await h.start(f);const before=await e.snapshot();await h.asUser(f.owner);const p=await e.preview(f);
  assert.ok(p.blockers.includes('active_screening'));assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1',[f.candidate.id])).rows[0].n,1);
  assert.deepEqual(await e.snapshot(),before);assert.ok(started.analysis_id);
 });
});

test('SC-010 R1 accepted schema baseline rejects drift that existed before migration installation',async t=>{
 const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
 let injected=false;
 const wrapped={
  query:(...args)=>db.query(...args),
  exec:async sql=>{
   if(sql.includes('-- SC-010-R1: owner-controlled configuration')&&!injected){
    await db.exec('alter table public.candidates add column unmapped_prior_payload jsonb');injected=true;
   }
   return db.exec(sql);
  },
 };
 const h=await setupRankingDatabase(wrapped),e=erasureHarness(h),f=await h.seed();assert.equal(injected,true);
 const p=await e.preview(f);assert.ok(p.blockers.includes('schema_dependency_unknown'));assert.equal(p.execution_enabled,false);
});
