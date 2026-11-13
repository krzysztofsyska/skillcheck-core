import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { activeBoot,users } from './helpers/competency-active-fixture.mjs';
import { parseFollowupState } from '../lib/process-followup.ts';
import { lifecycleHarness,lifecycleRules } from './helpers/erasure-lifecycle-fixture.mjs';
const signature='8ad238e75d4d4ccb82e03b89f368ba06483580781494fe1f7f9306a3c9c7f73f';
const rejected=e=>['42501','PT404'].includes(e.code);
const body={tasks:'Faktyczne zadania wykonane.',onboarding:'Wdrożenie zapewniono.',resources:'Zasoby dostępne.',support:'Wsparcie udzielone.',autonomy:'Samodzielna praca.',evidence:'Syntetyczny wynik zadania zgodny z kryteriami.',outcome:'met',probation:'passed',retained:'yes'};
test('SC-PROCESS B: purposes, evidence, independent permission, freeze and erasure inventory',async t=>{
 const {db,h,call,seed,x}=await activeBoot(t,{fullChain:true});
 const a=await seed(),b=await seed({owner:users.otherOwner});
 await h.asAdmin();
 await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter'),($1,$3,'viewer')",[a.companyId,users.recruiter,users.viewer]);
 const create=(f,purpose='post_hire',date='2025-01-01')=>call('public.process_followup_create',[f.application.id,purpose,date,'Kryteria zatwierdzone: samodzielne zadanie.','Wynik początkowy: dowody wymagają sprawdzenia.']);
 const read=f=>call('public.process_followup_read',[f.application.id]);
 let post,promotion;
 await t.test('owner creates separate immutable purposes; no automatic personnel decision',async()=>{
  await h.asUser(users.owner);post=await create(a);promotion=await create(a,'promotion');
  const r=await read(a);assert.equal(r.can_create,true);assert.deepEqual(r.cases.map(c=>c.purpose).sort(),['post_hire','promotion']);
  assert.equal(r.cases[0].observations.length,0);assert.ok(r.cases.every(c=>c.can_record&&c.can_manage));
  await assert.rejects(create(a,'unknown'),e=>e.code==='22023');
  await assert.rejects(create(a,'post_hire','2999-01-01'),e=>e.code==='22023');
  await h.asAdmin();await assert.rejects(db.query("update private.process_followup_cases set purpose='internal_assessment' where id=$1",[post]),rejected);
 });
 await t.test('recruiter requires explicit grant for the exact case/purpose; revocation immediate',async()=>{
  await h.asUser(users.recruiter);assert.deepEqual((await read(a)).cases,[]);await assert.rejects(create(a),rejected);
  await assert.rejects(call('public.process_followup_record',[post,30,JSON.stringify(body)]),rejected);
  await h.asUser(users.owner);await call('public.process_followup_grant',[post,users.recruiter,true]);
  await h.asUser(users.recruiter);let r=await read(a);assert.equal(r.cases.length,1);assert.equal(r.cases[0].id,post);assert.equal(r.cases[0].can_manage,false);assert.deepEqual(r.cases[0].grants,[]);
  await assert.rejects(call('public.process_followup_grant',[post,users.recruiter,true]),rejected);
  await assert.rejects(call('public.process_followup_record',[promotion,30,JSON.stringify(body)]),rejected);
  await call('public.process_followup_record',[post,30,JSON.stringify(body)]);
  await h.asAdmin();await db.query('delete from public.company_members where company_id=$1 and user_id=$2',[a.companyId,users.recruiter]);
  await h.asUser(users.owner);await call('public.process_followup_grant',[post,users.recruiter,false]);
  await h.asAdmin();await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter')",[a.companyId,users.recruiter]);
  await h.asUser(users.recruiter);assert.deepEqual((await read(a)).cases,[]);await assert.rejects(call('public.process_followup_record',[post,90,JSON.stringify(body)]),rejected);
 });
 await t.test('checkpoint evidence: missing measurement distinct from a negative outcome; snapshots remain',async()=>{
  await h.asUser(users.owner);
  const unknown={...body,outcome:'not_measured',probation:'not_measured',retained:'not_measured',evidence:'Brak obserwacji z powodu niedostępności danych.'};
  await call('public.process_followup_record',[post,90,JSON.stringify(unknown)]);
  await call('public.process_followup_record',[post,180,JSON.stringify({...body,outcome:'not_met',probation:'failed',retained:'no'})]);
  const c=(await read(a)).cases.find(c=>c.id===post);assert.deepEqual(c.observations.map(o=>o.body.outcome),['met','not_measured','not_met']);assert.equal(c.criteria,'Kryteria zatwierdzone: samodzielne zadanie.');
  await assert.rejects(call('public.process_followup_record',[post,30,JSON.stringify(body)]),e=>e.code==='PT409');
  for(const invalid of [{...body,evidence:'\t\n'},{...body,evidence:'\u00a0\ufeff'},{...body,evidence:'\u0007text'},{...body,evidence:''},{...body,outcome:null},{...body,outcome:'hire'},{...body,extra:'x'}])await assert.rejects(call('public.process_followup_record',[promotion,30,JSON.stringify(invalid)]),e=>e.code==='22023');
  await call('public.process_followup_record',[promotion,30,JSON.stringify({...body,evidence:'🦊'.repeat(2000)})]);
  assert.doesNotThrow(()=>parseFollowupState({can_create:true,cases:[c]}));
  parseFollowupState(await read(a));
  await assert.rejects(call('public.process_followup_record',[promotion,90,JSON.stringify({...body,evidence:'🦊'.repeat(2001)})]),e=>e.code==='22023');
  for(const bad of ['\u00a0\ufeff'.repeat(20),'\t'.repeat(20),'abc\u0007'.repeat(5)])await assert.rejects(call('public.process_followup_create',[a.application.id,'post_hire','2025-01-01',bad,'Wynik początkowy syntetyczny']),e=>e.code==='22023');
  const today=(await db.query('select current_date::text d')).rows[0].d;
  const fresh=await create(a,'internal_assessment',today);await assert.rejects(call('public.process_followup_record',[fresh,30,JSON.stringify(body)]),e=>e.code==='22023');
 });
 await t.test('viewer, outsider, anon and foreign tenant denied uniformly',async()=>{
  for(const user of [users.viewer,users.outsider,users.otherOwner,null]){await h.asUser(user);await assert.rejects(read(a),rejected);await assert.rejects(call('public.process_followup_record',[post,30,JSON.stringify(body)]),rejected);}
  await h.asUser(users.owner);await assert.rejects(read(b),rejected);
  await assert.rejects(call('public.process_followup_grant',[post,users.otherOwner,true]),rejected);
  await h.asUser(null,'anon');await assert.rejects(read(a),rejected);
 });
 await t.test('recruitment metrics separate measured negative, missing and unauthorized populations',async()=>{
  const metrics=(f,day=30)=>call('public.process_followup_recruitment_metrics',[f.companyId,f.recruitment.id,day]);
  await h.asUser(users.owner);
  let r=await metrics(a);assert.equal(r.population,1);assert.deepEqual(r.probation,{positive:1,measured:1,missing:0,rate:100});assert.deepEqual(r.retention,{positive:1,measured:1,missing:0,rate:100});
  r=await metrics(a,90);assert.deepEqual(r.probation,{positive:0,measured:0,missing:1,rate:null});
  r=await metrics(a,180);assert.deepEqual(r.retention,{positive:0,measured:1,missing:0,rate:0});
  await assert.rejects(metrics(a,45),e=>e.code==='22023');
  await assert.rejects(call('public.process_followup_recruitment_metrics',[a.companyId,b.recruitment.id,30]),rejected);
  await h.asUser(users.recruiter);assert.equal((await metrics(a)).population,0,'revoked case is not counted');
  await h.asUser(users.owner);await call('public.process_followup_grant',[promotion,users.recruiter,true]);
  await h.asUser(users.recruiter);assert.equal((await metrics(a)).population,0,'promotion permission does not grant post-hire access');
  await h.asUser(users.owner);await call('public.process_followup_grant',[post,users.recruiter,true]);
  await h.asUser(users.recruiter);assert.equal((await metrics(a)).probation.rate,100);
  await h.asUser(users.viewer);await assert.rejects(metrics(a),rejected);
  await h.asUser(users.otherOwner);await assert.rejects(metrics(a),rejected);
  await h.asUser(users.owner);const newest=await create(a);
  r=await metrics(a);assert.equal(r.population,1,'one application counted once');assert.deepEqual(r.probation,{positive:0,measured:0,missing:1,rate:null},'latest authorized case has no observation');
  await h.asUser(users.recruiter);assert.equal((await metrics(a)).probation.rate,100,'hidden newer case does not disclose its existence or affect accessible population');
  await h.asUser(users.owner);await call('public.process_followup_grant',[newest,users.recruiter,true]);
  await h.asUser(users.recruiter);assert.equal((await metrics(a)).probation.rate,null);
 });
 await t.test('candidate-linked rows are all inventoried and hidden/immutable after freeze',async()=>{
  await h.asAdmin();await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter')",[b.companyId,users.recruiter]);
  await h.asUser(users.otherOwner);const id=await create(b);await call('public.process_followup_grant',[id,users.recruiter,true]);await call('public.process_followup_record',[id,30,JSON.stringify(body)]);
  await h.asAdmin();
  assert.equal((await db.query('select private.erasure_schema_signature() s')).rows[0].s,signature);
  const rows=(await db.query('select adapter from private.erasure_inventory_rows($1,$2)',[b.companyId,[b.candidate.id]])).rows;
  for(const adapter of ['private.process_followup_cases','private.process_followup_grants','private.process_followup_observations'])assert.ok(rows.some(r=>r.adapter===adapter),adapter);
  const life=lifecycleHarness(h);await h.asUser(b.owner);await life.policy(b,0,lifecycleRules);b.resolutionId=await life.resolve(b,[b.candidate.id]);await x.configure();const frozen=await life.freeze(b);await h.asUser(b.owner);
  assert.equal((await call('public.process_followup_recruitment_metrics',[b.companyId,b.recruitment.id,30])).population,0,'frozen candidate omitted from every count');
  await assert.rejects(read(b),e=>e.code==='PT409');await assert.rejects(call('public.process_followup_record',[id,90,JSON.stringify(body)]),e=>e.code==='PT409');
  await x.transition(frozen.request_id,0,'authorized');await x.transition(frozen.request_id,1,'erasing');await x.purge(frozen.request_id,2);
  await h.asAdmin();for(const table of ['cases','grants','observations']) assert.equal((await db.query(`select count(*)::int n from private.process_followup_${table} where application_id=$1`,[b.application.id])).rows[0].n,0);
  assert.ok((await db.query('select count(*)::int n from private.process_followup_cases where application_id=$1',[a.application.id])).rows[0].n>0);
 });
 await t.test('tables and helpers closed to API; rollback preserves evidence and erasure',async()=>{
  await h.asAdmin();for(const table of ['cases','grants','observations']){
   for(const role of ['anon','authenticated'])assert.equal((await db.query('select has_table_privilege($1,$2,$3) p',[role,`private.process_followup_${table}`,'select,insert,update,delete'])).rows[0].p,false);
  }
  const before=(await db.query('select count(*)::int n from private.process_followup_cases')).rows[0].n;
  await db.exec(await readFile(new URL('../supabase/rollbacks/20261113090000_sc_process_followup_r17_down.sql',import.meta.url),'utf8'));
  assert.equal((await db.query('select count(*)::int n from private.process_followup_cases')).rows[0].n,before);
  assert.equal((await db.query('select private.erasure_schema_signature() s')).rows[0].s,signature);
  await h.asUser(users.owner);await assert.rejects(read(a),rejected);
 });
});
