import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {setupRankingDatabase,users} from './helpers/screening-ranking-fixture.mjs';
import {communicationHarness,windows} from './helpers/candidate-communication-fixture.mjs';
const code=expected=>error=>error.code===expected;

test('SC-010 B1 real SQL foundation, tenant isolation, deny-only permissions and draft lifecycle',async t=>{
 const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
 const h=await setupRankingDatabase(db),c=communicationHarness(h);
 await t.test('review and human shortlist create only a draft with immutable minimal history',async()=>{
  const f=await c.ready(),key=randomUUID(),id=await c.prepare(f,key);
  assert.equal(await c.prepare(f,key),id);
  const rows=await c.list(f);assert.equal(rows.length,1);assert.equal(rows[0].state,'draft');
  const serialized=JSON.stringify([rows,await c.history(id)]);
  for(const privateValue of ['PRIVATE original CV','SQL expertise','Synthetic fixture.'])assert.ok(!serialized.includes(privateValue));
  assert.equal((await db.query('select status from public.applications where id=$1',[f.application.id])).rows[0].status,'new');
  await assert.rejects(c.prepare(f,randomUUID(),'sms',randomUUID()));
 });
 await t.test('manual shortlist with insufficient evidence and NULL score remains an explicit human source',async()=>{
  const f=await c.ready(Array(5).fill('insufficient_data'));
  assert.equal((await h.row(f)).raw_score,null);assert.ok(await c.prepare(f));
 });
 await t.test('request replay is stable and changed payload or stale revision conflicts',async()=>{
  const f=await c.ready(),key=randomUUID(),id=await c.permission(f,'unverified',0,key);
  assert.equal(await c.permission(f,'unverified',0,key),id);
  await assert.rejects(c.permission(f,'revoked',0,key),code('PT409'));
  await assert.rejects(c.permission(f,'revoked',0),code('PT409'));
  await c.permission(f,'revoked',1);
  await assert.rejects(c.permission(f,'unverified',2));
  const prefKey=randomUUID(),pref=await c.preferences(f,0,prefKey);
  assert.equal(await c.preferences(f,0,prefKey),pref);
  await assert.rejects(c.preferences(f,0,prefKey,['sms']),code('PT409'));
  await assert.rejects(c.preferences(f,0),code('PT409'));
  assert.equal(await c.preferences(f,1),pref);
 });
 await t.test('untrusted callers cannot grant permission or manufacture verification evidence',async()=>{
  const f=await c.ready();
  await assert.rejects(c.permission(f,'granted'));
  await assert.rejects(c.permission(f,'unverified',0,randomUUID(),f.recruitment.id,'email',null),code('PT422'));
  await c.permission(f,'unverified',0,randomUUID(),f.recruitment.id,'email',randomUUID());
  assert.equal((await db.query('select state from public.candidate_contact_permissions where candidate_id=$1',[f.candidate.id])).rows[0].state,'unverified');
  await assert.rejects(c.permission(f,'revoked',0,randomUUID(),f.recruitment.id,'carrier-pigeon'));
 });
 await t.test('revocation and block cancel matching drafts and preferences cannot override denial',async()=>{
  for(const state of ['revoked','blocked']){
   const f=await c.ready();await c.prepare(f);await c.permission(f,state);
   assert.equal((await c.list(f))[0].state,'cancelled');
   await c.preferences(f);await assert.rejects(c.prepare(f));
  }
 });
 await t.test('company denial outranks recruitment scope and unrelated channels remain independent',async()=>{
  const f=await c.ready();await c.permission(f,'revoked',0,randomUUID(),null);
  await c.permission(f,'unverified');await assert.rejects(c.prepare(f));
  assert.ok(await c.prepare(f,randomUUID(),'sms'));
 });
 await t.test('preference blocked channels cancel drafts; unblocking never restores cancelled work',async()=>{
  const f=await c.ready();await c.prepare(f);await c.preferences(f,0,randomUUID(),['email']);
  assert.equal((await c.list(f))[0].state,'cancelled');await assert.rejects(c.prepare(f));
  await c.preferences(f,1);assert.equal((await c.list(f))[0].state,'cancelled');
 });
 await t.test('timezone and weekly window validation rejects malformed and oversized structures',async()=>{
  const f=await c.ready();
  for(const [zone,schedule]of [['Invalid/Place',windows],['Europe/Warsaw',[{weekday:0,start_minute:0,end_minute:60}]],['Europe/Warsaw',[{weekday:1,start_minute:100,end_minute:60}]],['Europe/Warsaw',[...windows,...windows]],['Europe/Warsaw',{arbitrary:'private note'}],['Europe/Warsaw',[{...windows[0],note:'PII'}]]])await assert.rejects(c.preferences(f,0,randomUUID(),[],zone,schedule));
  await assert.rejects(c.preferences(f,0,randomUUID(),['unknown']));
  for(const schedule of [[null],[1],['text'],[{weekday:1,start_minute:'NaN',end_minute:90}],[{weekday:'1',start_minute:0,end_minute:90}],[{weekday:1,start_minute:'0',end_minute:90}]])await assert.rejects(c.preferences(f,0,randomUUID(),[],'Europe/Warsaw',schedule),code('PT422'));
 });
 await t.test('removed and stale shortlist references cannot create new drafts',async()=>{
  const removed=await c.ready();await h.remove(removed.shortlistId);await assert.rejects(c.prepare(removed));
  const stale=await c.ready();await h.review(stale,stale.analysis_id);await assert.rejects(c.prepare(stale));
 });
 await t.test('cancel checks version and request payload, with idempotent replay and immutable audit',async()=>{
  const f=await c.ready(),id=await c.prepare(f),key=randomUUID();
  await assert.rejects(c.cancel(id,2),code('PT409'));
  assert.equal(await c.cancel(id,1,key),id);assert.equal(await c.cancel(id,1,key),id);
  await assert.rejects(c.cancel(id,2,key),code('PT409'));
  assert.equal((await c.list(f))[0].state,'cancelled');assert.ok((await c.history(id)).length>=2);
 });
 await t.test('owner and recruiter write; viewer reads; outsiders, anonymous and screening worker cannot operate',async()=>{
  const f=await c.ready(),id=await c.prepare(f);
  for(const [user,role]of [[users.recruiter,'recruiter'],[users.viewer,'viewer']])await h.insert('company_members',{company_id:f.companyId,user_id:user,role});
  await h.asUser(users.recruiter);await c.preferences(f);assert.equal((await c.list(f)).length,1);
  await h.asUser(users.viewer);assert.equal((await c.list(f)).length,1);assert.ok((await c.history(id)).length);
  for(const op of [()=>c.prepare(f),()=>c.permission(f),()=>c.preferences(f,1),()=>c.cancel(id)])await assert.rejects(op(),code('PT403'));
  for(const [user,role]of [[users.outsider,'authenticated'],[null,'anon'],[null,'screening_worker']]){
   await h.asUser(user,role);
   for(const op of [()=>c.list(f),()=>c.history(id),()=>c.prepare(f),()=>c.permission(f),()=>c.preferences(f,1),()=>c.cancel(id)])await assert.rejects(op(),code(role==='authenticated'?'PT404':'42501'));
  }
 });
 await t.test('dual-company ownership cannot connect one tenant candidate to another tenant recruitment or shortlist',async()=>{
  const left=await c.ready(),right=await c.ready();
  await assert.rejects(c.permission(left,'unverified',0,randomUUID(),right.recruitment.id));
  await assert.rejects(c.prepare(left,randomUUID(),'email',right.shortlistId));
  assert.equal((await c.list(left)).length,0);
 });
 await t.test('bounded pagination validates cursors and exposes no duplicate records',async()=>{
  const f=await c.ready();const first=await c.prepare(f);await c.cancel(first);await c.prepare(f);
  const page=await c.list(f,null,null,1);assert.equal(page.length,1);
  const next=await c.list(f,page[0].created_at,page[0].id,1);assert.equal(next.length,1);assert.notEqual(next[0].id,page[0].id);
  assert.equal((await c.list(f,next[0].created_at,next[0].id,1)).length,0);
  const events=await c.history(first,null,null,1),more=await c.history(first,events[0].created_at,events[0].id,1);assert.equal(more.length,1);assert.notEqual(more[0].id,events[0].id);
  await assert.rejects(c.list(f,null,null,0));await assert.rejects(c.list(f,null,null,201));
  await assert.rejects(c.list(f,new Date().toISOString(),null,10));
  await assert.rejects(c.history(first,null,randomUUID(),10));
 });
 await t.test('audit remains append-only even for privileged maintenance and evidence references stay private',async()=>{
  const f=await c.ready(),evidence=randomUUID();await c.permission(f,'unverified',0,randomUUID(),f.recruitment.id,'email',evidence);const id=await c.prepare(f);
  const permission=(await db.query('select * from public.candidate_contact_permissions where candidate_id=$1',[f.candidate.id])).rows[0];assert.equal(permission.source,'operator_recorded');assert.ok(!JSON.stringify(permission).includes(evidence));
  await c.preferences(f);assert.equal((await db.query('select source from public.candidate_contact_preferences where candidate_id=$1',[f.candidate.id])).rows[0].source,'operator_recorded');
  for(const table of ['contact_audit','contact_requests'])await assert.rejects(db.query(`select * from private.${table}`),code('42501'));
  await h.asAdmin();
  for(const [table,column,value]of [['public.candidate_communication_events','communication_id',id],['private.contact_audit','candidate_id',f.candidate.id],['private.contact_requests','company_id',f.companyId]]){
   await assert.rejects(db.query(`delete from ${table} where ${column}=$1`,[value]),code('42501'));
   await assert.rejects(db.query(`update ${table} set created_at=now() where ${column}=$1`,[value]),code('42501'));
  }
  assert.equal((await db.query('select evidence_ref from private.contact_audit where candidate_id=$1 and action=$2',[f.candidate.id,'unverified'])).rows[0].evidence_ref,evidence);
 });
 await t.test('database constraints reject forged cross-tenant relations and impossible delivery states',async()=>{
  const left=await c.ready(),right=await c.ready();await h.asAdmin();
  await assert.rejects(db.query('insert into public.candidate_communications(company_id,recruitment_id,candidate_id,application_id,shortlist_entry_id,channel,created_by) values($1,$2,$3,$4,$5,$6,$7)',[left.companyId,left.recruitment.id,right.candidate.id,left.application.id,left.shortlistId,'email',users.owner]),code('PT404'));
  await h.asUser();const id=await c.prepare(left);await h.asAdmin();
  for(const state of ['scheduled','sending','sent'])await assert.rejects(db.query('update public.candidate_communications set state=$1 where id=$2',[state,id]),code('23514'));
  await assert.rejects(db.query("insert into public.candidate_contact_permissions(company_id,candidate_id,channel,state,revision) values($1,$2,'email','granted',1)",[left.companyId,left.candidate.id]),code('23514'));
 });
 await t.test('new public tables are RLS protected, deny direct DML and have no worker/anonymous privileges',async()=>{
  await h.asAdmin();
  const tables=(await db.query("select c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and (c.relname like 'candidate_contact_%' or c.relname like 'candidate_communication%') and c.relkind='r' ")).rows;
  assert.ok(tables.length>=3);
  for(const table of tables){assert.equal(table.relrowsecurity,true,table.relname);await h.asUser();
   for(const sql of [`insert into public.${table.relname} default values`,`delete from public.${table.relname}`])await assert.rejects(db.query(sql),code('42501'));
   await h.asAdmin();for(const role of ['anon','screening_worker'])assert.equal((await db.query("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') as allowed",[role,`public.${table.relname}`])).rows[0].allowed,false);
  }
 });
});
