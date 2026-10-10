import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {setupRankingDatabase,users} from './helpers/screening-ranking-fixture.mjs';
import {verificationHarness} from './helpers/contact-verification-fixture.mjs';
const code=expected=>error=>error.code===expected;

test('SC-010 B2 signed verifier boundary and actual SQL approval lifecycle',async t=>{
 const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
 const h=await setupRankingDatabase(db),v=verificationHarness(h);
 await t.test('verifier is a dormant NOLOGIN capability and ordinary roles cannot inherit it',async()=>{
  await h.asAdmin();
  const role=(await db.query("select rolcanlogin,rolsuper,rolbypassrls from pg_roles where rolname='contact_verifier'")).rows[0];
  assert.deepEqual(role,{rolcanlogin:false,rolsuper:false,rolbypassrls:false});
  assert.equal((await db.query("select count(*)::int n from pg_auth_members where roleid='contact_verifier'::regrole")).rows[0].n,0);
  for(const name of ['anon','authenticated','screening_worker']){
   const row=(await db.query("select has_function_privilege($1,'private.ingest_verified_contact_receipt(jsonb,jsonb)','EXECUTE') allowed",[name])).rows[0];
   assert.equal(row.allowed,false,name);
  }
 });
 await t.test('owner, viewer, outsider, anonymous and worker cannot mint private evidence',async()=>{
  const f=await v.ready();
  for(const [id,role]of [[users.owner,'authenticated'],[users.viewer,'authenticated'],[users.outsider,'authenticated'],[null,'anon'],[null,'screening_worker']]){
   await h.asUser(id,role);
   await assert.rejects(db.query("select private.ingest_verified_contact_receipt('{}'::jsonb,'{}'::jsonb)"),code('42501'));
  }
 });
 await t.test('signed Ed25519 receipt traverses real verifier SQL and human shortlist to immutable approval',async()=>{
  const f=await v.ready(),id=await v.prepare(f),r=v.receipt(f),receiptId=await v.ingest(f,r);
  assert.equal(receiptId,r.receipt_id);await h.asUser();
  assert.deepEqual(await v.status(id),{approval_id:null,is_current:false,reason:'not_approved'});
  const key=randomUUID(),approval=await v.approve(id,receiptId,1,key);
  assert.equal(await v.approve(id,receiptId,1,key),approval);
  assert.deepEqual(await v.status(id),{approval_id:approval,is_current:true,reason:'current'});
  const rows=(await db.query('select * from public.candidate_communication_approvals where id=$1',[approval])).rows;
  assert.equal(rows[0].approved_by,users.owner);assert.equal(rows[0].review_id,f.reviewId);
  assert.equal((await v.list(f))[0].state,'draft');
  assert.equal((await db.query('select status from public.applications where id=$1',[f.application.id])).rows[0].status,'new');
  assert.ok(!JSON.stringify([rows,await v.history(id),await v.status(id)]).includes(r.destination));
  await assert.rejects(v.approve(id,randomUUID(),1,key),code('PT409'));
  await h.asAdmin();
  const point=(await db.query('select * from private.candidate_verified_contact_points where company_id=$1',[f.companyId])).rows[0];
  assert.ok(!JSON.stringify(point).includes(r.destination));assert.equal(Number(point.version),1);
  for(const table of ['candidate_verified_contact_receipts','candidate_verified_contact_points'])await assert.rejects(db.query(`delete from private.${table} where company_id=$1`,[f.companyId]));
 });
 await t.test('manual NULL-score shortlist is eligible without inventing a score',async()=>{
  const f=await v.ready(Array(5).fill('insufficient_data')),id=await v.prepare(f),r=await v.ingest(f);await h.asUser();
  assert.equal((await h.row(f)).raw_score,null);assert.ok(await v.approve(id,r));assert.equal((await v.status(id)).is_current,true);
 });
 await t.test('same signed replay is idempotent and never creates another encrypted contact generation',async()=>{
  const f=await v.ready(),r=v.receipt(f),id=await v.ingest(f,r);
  assert.equal(await v.ingest(f,r),id);
  await assert.rejects(v.ingest(f,{...r,nonce:randomUUID()}),/NOT_ACCEPTED/);
  await assert.rejects(v.ingest(f,{...r,receipt_id:randomUUID()}),/NOT_ACCEPTED/);
  await h.asAdmin();assert.equal((await db.query('select count(*)::int n from private.candidate_verified_contact_points where company_id=$1',[f.companyId])).rows[0].n,1);
 });
 await t.test('receipt ingress rejects stale revisions, wrong tenant binding, disabled registry and malformed SQL types',async()=>{
  for(const kind of ['preference','scoped','global','blocked','issuer','policy','tenant','recruitment','generation']){
   const f=await v.ready(),r=v.receipt(f);
   if(kind==='preference')await v.preferences(f);
   if(kind==='scoped')await v.permission(f,'unverified');
   if(kind==='global')await v.permission(f,'unverified',0,randomUUID(),null);
   if(kind==='blocked')await v.preferences(f,0,randomUUID(),['email']);
   if(kind==='issuer'||kind==='policy'){await h.asAdmin();await db.query(`update private.${kind==='issuer'?'contact_trusted_issuers':'contact_policy_templates'} set enabled=false where company_id=$1`,[f.companyId]);}
   if(kind==='generation')await v.ingest(f);
   if(kind==='tenant')r.company_id=randomUUID();
   if(kind==='recruitment')r.recruitment_id=randomUUID();
   await assert.rejects(v.ingest(f,r,{context:{company_id:r.company_id,recruitment_id:r.recruitment_id}}),/CONTACT_VERIFICATION_/);
  }
  const f=await v.ready();let params;
  await v.ingest(f,v.receipt(f),{execute:async(_sql,args)=>{params=args;}});
  for(const changes of [{global_permission_revision:'0'},{proof_type:'verified'},{issued_at:'tomorrow'},{expires_at:new Date(Date.now()-1000).toISOString()},{issued_at:new Date(Date.now()+10000).toISOString()},{expires_at:new Date(Date.now()+3600000).toISOString()},{destination:'leak@example.test'},{candidate_id:null}]){
   await v.asVerifier();await assert.rejects(db.query('select private.ingest_verified_contact_receipt($1::jsonb,$2::jsonb)',[JSON.stringify({...JSON.parse(params[0]),...changes}),params[1]]));
  }
 });
 await t.test('denials in either scope override a trusted signature and replay never revives cancelled work',async()=>{
  for(const scope of ['global','scoped']){
   const f=await v.ready(),id=await v.prepare(f),r=v.receipt(f),rid=await v.ingest(f,r);await h.asUser();await v.approve(id,rid);
   await v.permission(f,'revoked',0,randomUUID(),scope==='global'?null:f.recruitment.id);
   assert.equal((await v.status(id)).is_current,false);
   assert.equal(await v.ingest(f,r),rid);await h.asUser();assert.equal((await v.list(f))[0].state,'cancelled');
   const revised=scope==='global'?{global_permission_revision:1,expected_contact_version:1}:{scoped_permission_revision:1,expected_contact_version:1};
   await assert.rejects(v.ingest(f,v.receipt(f,revised),{context:revised}),/NOT_ACCEPTED/);
  }
 });
 await t.test('contact replacement stales prior approval and fresh receipt supports new immutable approval',async()=>{
  const f=await v.ready(),id=await v.prepare(f),r1=await v.ingest(f);await h.asUser();const a1=await v.approve(id,r1);
  const change={expected_contact_version:1,destination:'replacement@example.test'},r2=await v.ingest(f,v.receipt(f,change),{context:change});await h.asUser();
  assert.equal((await v.status(id)).is_current,false);const a2=await v.approve(id,r2,2);assert.notEqual(a1,a2);assert.equal((await v.status(id)).is_current,true);
  const rows=(await db.query('select * from public.candidate_communication_approvals where communication_id=$1 order by communication_version',[id])).rows;
  assert.equal(rows.length,2);assert.equal(Number(rows[0].contact_version),1);assert.equal(Number(rows[1].contact_version),2);
 });
 await t.test('approval freshness follows every mutable source without rewriting old approval',async()=>{
  for(const kind of ['cancel','preference','permission','contact','review','cv','shortlist','position','recruitment','application','issuer','policy']){
   const f=await v.ready(),id=await v.prepare(f),rid=await v.ingest(f);await h.asUser();const approval=await v.approve(id,rid);
   if(kind==='cancel')await v.cancel(id,2);
   if(kind==='preference')await v.preferences(f);
   if(kind==='permission')await v.permission(f,'unverified');
   if(kind==='contact')await db.query('update public.candidates set email=$1 where id=$2',['changed@example.test',f.candidate.id]);
   if(kind==='review')await h.review(f,f.analysis_id);
   if(kind==='cv')await db.query('update public.candidate_documents set redacted_text=$1 where id=$2',['Changed content.',f.documentId]);
   if(kind==='shortlist')await h.remove(f.shortlistId);
   if(kind==='position')await db.query("update public.positions set title='Changed' where id=$1",[f.position.id]);
   if(kind==='recruitment')await db.query("update public.recruitments set status='closed' where id=$1",[f.recruitment.id]);
   if(kind==='application')await db.query("update public.applications set status='rejected' where id=$1",[f.application.id]);
   if(kind==='issuer'||kind==='policy'){await h.asAdmin();await db.query(`update private.${kind==='issuer'?'contact_trusted_issuers':'contact_policy_templates'} set enabled=false where company_id=$1`,[f.companyId]);await h.asUser();}
   const status=await v.status(id);assert.equal(status.approval_id,approval,kind);assert.equal(status.is_current,false,kind);
   assert.equal((await db.query('select count(*)::int n from public.candidate_communication_approvals where id=$1',[approval])).rows[0].n,1);
  }
 });
 await t.test('approvals enforce tenant RLS, viewer read-only, exact receipt scope and no direct mutations',async()=>{
  const f=await v.ready(),id=await v.prepare(f),rid=await v.ingest(f);await h.asUser();
  await h.insert('company_members',{company_id:f.companyId,user_id:users.viewer,role:'viewer'});
  await h.asUser(users.viewer);await assert.rejects(v.approve(id,rid));assert.equal((await v.status(id)).is_current,false);
  await h.asUser();await v.approve(id,rid);
  for(const role of [users.otherOwner,users.outsider]){await h.asUser(role);await assert.rejects(v.status(id),code('PT404'));await assert.rejects(v.approve(id,rid,2));assert.equal((await db.query('select * from public.candidate_communication_approvals where communication_id=$1',[id])).rows.length,0);}
  await h.asUser();
  for(const table of ['candidate_communication_approvals']){
   await assert.rejects(db.query(`update public.${table} set approved_by=$1 where communication_id=$2`,[users.viewer,id]),code('42501'));
   await assert.rejects(db.query(`delete from public.${table} where communication_id=$1`,[id]),code('42501'));
  }
  for(const table of ['contact_trusted_issuers','contact_policy_templates','candidate_verified_contact_receipts','candidate_verified_contact_points'])await assert.rejects(db.query(`select * from private.${table}`),code('42501'));
  const other=await v.ready(),otherId=await v.prepare(other);await assert.rejects(v.approve(otherId,rid));
 });

});
