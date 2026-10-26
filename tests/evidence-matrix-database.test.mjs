import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const sqlFiles = [
 '20260930000100_skillcheck_core.sql',
 '20261001000100_idempotent_onboarding.sql',
 '20261001000200_candidate_documents.sql',
 '20261002000100_behavior_assessments.sql',
 '20261002000200_behavior_conflict_response.sql',
 '20261002000300_exercise_definitions.sql',
 '20261004000100_exercise_observations.sql',
 '20261004000200_screening_results.sql',
 '20261026194700_evidence_matrix.sql',
];
const ownerA='11000000-0000-0000-0000-000000000001';
const ownerB='11000000-0000-0000-0000-000000000002';
const viewer='11000000-0000-0000-0000-000000000003';

test('evidence matrix tenant RLS, read-only clients and human review audit',async t=>{
 const db=new PGlite();
 t.after(()=>db.close());
 await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
  $$;
  grant usage on schema auth to anon,authenticated;
  grant execute on function auth.uid() to anon,authenticated;
 `);
 for(const name of sqlFiles) await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 for(const id of [ownerA,ownerB,viewer])await db.query('insert into auth.users values($1)',[id]);
 const user=async id=>{await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
 const admin=async()=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)");};
 async function insert(table,values){
  const names=Object.keys(values);
  return (await db.query(`insert into public.${table}(${names.join(',')}) values(${names.map((_,i)=>'$'+(i+1)).join(',')}) returning *`,Object.values(values))).rows[0];
 }
 async function seed(id,label){
  await user(id);
  const organization_id=(await db.query('select public.create_company($1) id',['Company '+label])).rows[0].id;
  const position=await insert('positions',{company_id:organization_id,title:'Specjalista',tasks:['CRM'],kpis:['Raporty']});
  const recruitment=await insert('recruitments',{company_id:organization_id,position_id:position.id,name:'Test'});
  const candidate=await insert('candidates',{company_id:organization_id,first_name:'Jan',last_name:label});
  const application=await insert('applications',{company_id:organization_id,recruitment_id:recruitment.id,candidate_id:candidate.id});
  const document=await insert('candidate_documents',{company_id:organization_id,candidate_id:candidate.id,source_text:'Oryginał',redacted_text:'CRM i raporty.'});
  await db.query('select public.review_candidate_document($1,$2)',[document.id,1]);
  return {organization_id,position,recruitment,candidate,application,document};
 }
 const a=await seed(ownerA,'A'),b=await seed(ownerB,'B');
 await user(ownerA);
 await insert('company_members',{company_id:a.organization_id,user_id:viewer,role:'viewer'});
 await admin();
 const analyses=[];
 for(const [index,f] of [a,b].entries()){
  analyses.push(await insert('evidence_analysis',{
   organization_id:f.organization_id,candidate_id:f.candidate.id,position_id:f.position.id,
   recruitment_id:f.recruitment.id,application_id:f.application.id,document_id:f.document.id,
   status:'done',model:'test-llm',created_by:index?ownerB:ownerA,
   requirements_snapshot:JSON.stringify([{id:'task:1',kind:'task',text:'CRM'}]),
   materials_snapshot:JSON.stringify([{document_id:f.document.id,version:1,text:'CRM i raporty.'}]),
   materials_snapshot_hash:'a'.repeat(64),
  }));
 }
 const row=await insert('evidence_item',{organization_id:a.organization_id,analysis_id:analyses[0].id,
  requirement_key:'task:1',verdict:'supported',
  evidence_quotes:JSON.stringify([{quote:'CRM',document_id:a.document.id,document_version:1,start:0,end:3}]),
 });
 await insert('evidence_item',{organization_id:b.organization_id,analysis_id:analyses[1].id,requirement_key:'task:1',verdict:'missing'});
 await user(ownerA);
 assert.equal((await db.query('select * from public.evidence_analysis')).rows.length,1);
 assert.equal((await db.query('select * from public.evidence_item')).rows.length,1);
 assert.equal((await db.query('update public.evidence_item set human_status=$1 where organization_id=$2 returning id',['accepted',b.organization_id])).rows.length,0);
 await assert.rejects(db.query("update public.evidence_analysis set status='failed'"),e=>e.code==='42501');
 await assert.rejects(db.query("update public.evidence_item set verdict='missing'"),e=>e.code==='42501');
 await user(viewer);
 assert.equal((await db.query('select * from public.evidence_item')).rows.length,1);
 // PostgreSQL may filter unauthorized UPDATE via RLS (0 rows) instead of throwing.
 // Both outcomes must preserve existing human review.
 try {
   const deniedUpdate=await db.query("update public.evidence_item set human_status='rejected' returning id");
   assert.equal(deniedUpdate.rows.length,0,'viewer must not modify human review');
 } catch(e) { assert.equal(e.code,'42501'); }
 await user(ownerA);
 const updated=(await db.query("update public.evidence_item set human_status='accepted',human_note='sprawdzono' where id=$1 returning reviewed_by,reviewed_at",[row.id])).rows[0];
 assert.equal(updated.reviewed_by,ownerA);
 assert.ok(updated.reviewed_at);
 await user(ownerB);
 assert.equal((await db.query('select * from public.evidence_analysis')).rows.length,1);
 assert.equal((await db.query('select * from public.evidence_item')).rows.length,1);
 await user(null);
 assert.equal((await db.query('select count(*)::int n from public.evidence_analysis')).rows[0].n,0);
});
