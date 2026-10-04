import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
test('CV permissions, immutable source, review version and tenant boundaries',async(t)=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon nologin;create role authenticated nologin;create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`);
 for(const name of ['20260930000100_skillcheck_core','20261001000100_idempotent_onboarding','20261001000200_candidate_documents']) await db.exec(await readFile(new URL('../supabase/migrations/'+name+'.sql',import.meta.url),'utf8'));
 const ids=[1,2,3,4].map(n=>'00000000-0000-0000-0000-00000000000'+n);
 for(const id of ids) await db.query('insert into auth.users values($1)',[id]);
 const as=async(id,role='authenticated')=>{await db.exec('reset role;set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id??'']);};
 const denied=async(sql,args=[],code='42501')=>assert.rejects(db.query(sql,args),e=>e.code===code);
 const seed=async(id)=>{
  await as(id);const company=(await db.query("select public.create_company('Test') as id")).rows[0].id;
  const candidate=(await db.query("insert into public.candidates(company_id,first_name,last_name) values($1,'Test','User') returning id",[company])).rows[0].id;
  return {company,candidate};
 };
 const a=await seed(ids[0]),b=await seed(ids[1]);await as(ids[0]);
 await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'viewer'),($1,$3,'recruiter')",[a.company,ids[2],ids[3]]);
 const insert='insert into public.candidate_documents(company_id,candidate_id,source_text,redacted_text) values($1,$2,$3,$4) returning *';
 const doc=(await db.query(insert,[a.company,a.candidate,'Original personal data','SQL skills'])).rows[0];
 await t.test('anonymous and viewer writes denied; own viewer can read',async()=>{
  await as(null,'anon');await denied('select * from public.candidate_documents');await denied('select public.review_candidate_document($1,1)',[doc.id]);
  await as(ids[2]);assert.equal((await db.query('select * from public.candidate_documents')).rows.length,1);
  await denied(insert,[a.company,a.candidate,'source','draft']);
  assert.equal((await db.query("update public.candidate_documents set redacted_text='Other' returning id")).rows.length,0);
  assert.equal((await db.query('select public.review_candidate_document($1,1) as ok',[doc.id])).rows[0].ok,false);
 });
 await t.test('other tenant cannot read, edit, review or insert and cross-tenant parents fail',async()=>{
  await as(ids[1]);assert.equal((await db.query('select * from public.candidate_documents')).rows.length,0);
  await denied(insert,[a.company,a.candidate,'source','draft']);
  assert.equal((await db.query("update public.candidate_documents set redacted_text='Other' returning id")).rows.length,0);
  assert.equal((await db.query('select public.review_candidate_document($1,1) as ok',[doc.id])).rows[0].ok,false);
  await denied(insert,[b.company,a.candidate,'source','draft'],'23503');
 });
 await t.test('identity, source and approval metadata cannot be forged',async()=>{
  await as(ids[0]);
  for(const change of ["source_text='tampered'","company_id='"+b.company+"'","candidate_id='"+b.candidate+"'","status='reviewed'","version=10","reviewed_at=now()","reviewed_by='"+ids[0]+"'"]) await denied('update public.candidate_documents set '+change);
  await denied("insert into public.candidate_documents(company_id,candidate_id,source_text,redacted_text,status) values($1,$2,'x','x','reviewed')",[a.company,a.candidate]);
  await denied(insert,[a.company,a.candidate,'','draft'],'23514');
 });
 await t.test('review records real reviewer; later edit invalidates approval; stale review fails',async()=>{
  await as(ids[3]);
  assert.equal((await db.query('select public.review_candidate_document($1,1) as ok',[doc.id])).rows[0].ok,true);
  let row=(await db.query('select * from public.candidate_documents where id=$1',[doc.id])).rows[0];
  assert.equal(row.status,'reviewed');assert.equal(row.reviewed_by,ids[3]);assert.equal(row.version,2);
  row=(await db.query("update public.candidate_documents set redacted_text='Edited skills' where id=$1 and version=2 returning *",[doc.id])).rows[0];
  assert.equal(row.version,3);assert.equal(row.status,'draft');assert.equal(row.reviewed_by,null);assert.equal(row.reviewed_at,null);assert.equal(row.source_text,'Original personal data');
  assert.equal((await db.query('select public.review_candidate_document($1,2) as ok',[doc.id])).rows[0].ok,false);
  assert.equal((await db.query("update public.candidate_documents set redacted_text='Stale' where id=$1 and version=2 returning id",[doc.id])).rows.length,0);
  assert.equal((await db.query('select public.review_candidate_document($1,3) as ok',[doc.id])).rows[0].ok,true);
 });
});
