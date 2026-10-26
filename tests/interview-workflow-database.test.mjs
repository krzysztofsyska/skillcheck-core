import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migrations = [
 '20260930000100_skillcheck_core.sql',
 '20261001000100_idempotent_onboarding.sql',
 '20261001000200_candidate_documents.sql',
 '20261002000100_behavior_assessments.sql',
 '20261002000200_behavior_conflict_response.sql',
 '20261002000300_exercise_definitions.sql',
 '20261004000100_exercise_observations.sql',
 '20261004000200_screening_results.sql',
 '20261026194700_evidence_matrix.sql',
 '20261026215500_interview_workbench.sql',
];
const ownerA='11000000-0000-0000-0000-000000000001';
const ownerB='11000000-0000-0000-0000-000000000002';
const viewer='11000000-0000-0000-0000-000000000003';

test('Step4: tenant RLS, review guard, autosave audit, stage history, explicit manual decision',async t=>{
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
 for(const name of migrations) {
   await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 }
 for(const id of [ownerA,ownerB,viewer]) await db.query('insert into auth.users values($1)',[id]);
 const user=async id=>{
   await db.exec('reset role; set role authenticated');
   await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||'']);
 };
 const admin=async()=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)");};
 async function insert(table, values){
   const keys=Object.keys(values);
   const sql=`insert into public.${table}(${keys.join(',')}) values (${keys.map((_,i)=>'$'+(i+1)).join(',')}) returning *`;
   return (await db.query(sql,Object.values(values))).rows[0];
 }
 async function seed(owner,label){
   await user(owner);
   const organization_id=(await db.query('select public.create_company($1) as id',['Company '+label])).rows[0].id;
   const position=await insert('positions',{company_id:organization_id,title:'Specjalista',tasks:['CRM'],kpis:['Raporty']});
   const recruitment=await insert('recruitments',{company_id:organization_id,position_id:position.id,name:'Test'});
   const candidate=await insert('candidates',{company_id:organization_id,first_name:'Jan',last_name:label});
   const application=await insert('applications',{company_id:organization_id,recruitment_id:recruitment.id,candidate_id:candidate.id});
   const document=await insert('candidate_documents',{company_id:organization_id,candidate_id:candidate.id,source_text:'CV',redacted_text:'Znam CRM.'});
   await db.query('select public.review_candidate_document($1,$2)',[document.id,1]);
   const stage=await insert('assessment_stages',{company_id:organization_id,recruitment_id:recruitment.id,name:'Rozmowa',sequence:1});
   return {organization_id,position,recruitment,candidate,application,document,stage};
 }
 const a=await seed(ownerA,'A'),b=await seed(ownerB,'B');
 await user(ownerA);
 await insert('company_members',{company_id:a.organization_id,user_id:viewer,role:'viewer'});
 await admin();
 const analyses=[];
 for(const [f,owner] of [[a,ownerA],[b,ownerB]]) {
   const analysis=await insert('evidence_analysis',{
     organization_id:f.organization_id,candidate_id:f.candidate.id,position_id:f.position.id,
     recruitment_id:f.recruitment.id,application_id:f.application.id,document_id:f.document.id,
     status:'done',model:'unit-test',created_by:owner,
     requirements_snapshot:JSON.stringify([{id:'task:1',kind:'task',text:'CRM'}]),
     materials_snapshot:JSON.stringify([{document_id:f.document.id,version:1,text:'Znam CRM.'}]),
     materials_snapshot_hash:'a'.repeat(64),
   });
   const evidence=await insert('evidence_item',{organization_id:f.organization_id,analysis_id:analysis.id,
     requirement_key:'task:1',verdict:'missing',suggested_question:'Jak pracujesz z CRM?'});
   analyses.push({analysis,evidence});
 }
 const input={
   organization_id:a.organization_id,recruitment_id:a.recruitment.id,
   application_id:a.application.id,analysis_id:analyses[0].analysis.id,
   evidence_item_id:analyses[0].evidence.id,origin:'generated',
   question_text:'Podaj przykład',sort_order:1000,
 };
 await user(ownerA);
 await assert.rejects(insert('interview_questions',input),e=>e.code==='42501');
 await db.query("update public.evidence_item set human_status='accepted' where id=$1",[analyses[0].evidence.id]);
 const q=await insert('interview_questions',input);
 assert.equal(q.created_by,ownerA);
 assert.equal(q.requirement_text,'CRM');
 assert.equal(q.requirement_key,'task:1');
 assert.equal((await db.query('select * from public.interview_question_revisions')).rows.length,1);
 await assert.rejects(insert('interview_questions',input),e=>e.code==='23505');
 // A cannot see B's workbench, and cannot link to B's evidence.
 assert.equal((await db.query('select * from public.evidence_analysis')).rows.length,1);
 assert.equal((await db.query('select * from public.interview_questions')).rows.length,1);
 await assert.rejects(insert('interview_questions',{...input,evidence_item_id:analyses[1].evidence.id}),e=>['23503','42501'].includes(e.code));
 await user(viewer);
 assert.equal((await db.query('select * from public.interview_questions')).rows.length,1);
 await assert.rejects(db.query("update public.interview_questions set question_text='Nie'"),e=>e.code==='42501');
 await assert.rejects(insert('interview_question_notes',{organization_id:a.organization_id,question_id:q.id,answer_text:'X',observation_text:''}),e=>e.code==='42501');
 await user(ownerA);
 const changed=(await db.query("update public.interview_questions set question_text='Pytanie poprawione' where id=$1 returning version,updated_by",[q.id])).rows[0];
 assert.equal(changed.version,2);
 assert.equal(changed.updated_by,ownerA);
 assert.equal((await db.query('select * from public.interview_question_revisions')).rows.length,2);
 const note=await insert('interview_question_notes',{organization_id:a.organization_id,question_id:q.id,
   answer_text:'Odpowiedź',observation_text:'Obserwacja'});
 assert.equal(note.updated_by,ownerA);
 const edited=(await db.query("update public.interview_question_notes set answer_text='Nowa odpowiedź' where id=$1 returning version",[note.id])).rows[0];
 assert.equal(edited.version,2);
 assert.equal((await db.query('select version from public.interview_note_revisions order by version')).rows.map(x=>x.version).join(','),'1,2');
 await assert.rejects(db.query("update public.interview_note_revisions set answer_text='x'"),e=>e.code==='42501');
 const move=await insert('application_stage_transitions',{
   organization_id:a.organization_id,recruitment_id:a.recruitment.id,application_id:a.application.id,
   stage_id:a.stage.id,expected_previous_event_id:null,reason:'Rekruter wybrał etap',
 });
 assert.equal(move.changed_by,ownerA);
 await assert.rejects(insert('application_stage_transitions',{
   organization_id:a.organization_id,recruitment_id:a.recruitment.id,application_id:a.application.id,
   stage_id:a.stage.id,expected_previous_event_id:null,reason:'Wyścig okien',
 }),e=>['40001','23514'].includes(e.code));
 const decisionBase={organization_id:a.organization_id,recruitment_id:a.recruitment.id,application_id:a.application.id};
 await assert.rejects(insert('human_candidate_decisions',{...decisionBase,justification:'Uzasadnienie'}),e=>['23502','23514'].includes(e.code));
 await assert.rejects(insert('human_candidate_decisions',{...decisionBase,decision:'on_hold',justification:'  '}),e=>e.code==='23514');
 await assert.rejects(insert('human_candidate_decisions',{...decisionBase,decision:'hired',justification:'nie wolno'}),e=>e.code==='23514');
 const decision=await insert('human_candidate_decisions',{...decisionBase,decision:'on_hold',justification:'Dalsza weryfikacja'});
 assert.equal(decision.decided_by,ownerA);
 await assert.rejects(db.query("update public.human_candidate_decisions set decision='completed'"),e=>e.code==='42501');
 await user(ownerB);
 assert.equal((await db.query('select * from public.interview_questions')).rows.length,0);
 assert.equal((await db.query('select * from public.human_candidate_decisions')).rows.length,0);
 assert.equal((await db.query('select * from public.application_stage_transitions')).rows.length,0);
 await user(null);
 assert.equal((await db.query('select count(*)::int n from public.interview_questions')).rows[0].n,0);
 await assert.rejects(insert('human_candidate_decisions',{...decisionBase,decision:'completed',justification:'auto'}),e=>e.code==='42501');
});
