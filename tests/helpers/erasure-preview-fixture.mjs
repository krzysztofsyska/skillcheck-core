import {randomUUID} from 'node:crypto';
import {verificationHarness} from './contact-verification-fixture.mjs';

// Explicit synthetic configuration, never production/legal defaults.
export const retentionRules=[{data_class:'candidate',trigger_event:'process_closed',duration_days:30,hold_review_days:7}];
export function erasureHarness(h){
 const {db}=h,v=verificationHarness(h);
 const policy=async(f,revision=0,rules=retentionRules,key=randomUUID())=>(await db.query('select public.configure_candidate_retention_policy($1,$2,$3::jsonb,$4) as id',[f.companyId,revision,JSON.stringify(rules),key])).rows[0].id;
 const getPolicy=async(f)=>(await db.query('select public.get_candidate_retention_policy($1) as value',[f.companyId])).rows[0].value;
 const resolve=async(f,ids=[f.candidate.id],revision=0,key=randomUUID())=>(await db.query('select public.confirm_erasure_subject($1,$2::uuid[],$3,$4) as id',[f.candidate.id,ids,revision,key])).rows[0].id;
 const getResolution=async(f)=>(await db.query('select public.get_erasure_subject_resolution($1) as value',[f.candidate.id])).rows[0].value;
 const preview=async(f,scope='candidate_record',resolution=null)=>(await db.query('select public.preview_candidate_erasure($1,$2,$3) as value',[f.candidate.id,scope,resolution])).rows[0].value;
 const rich=async()=>{
  let f=await h.seed();
  await db.query("update public.positions set required_behaviors=array['Odpowiedzialność: Standardowy'] where id=$1",[f.position.id]);
  const stamp=(await db.query('select updated_at::text stamp from public.positions where id=$1',[f.position.id])).rows[0].stamp;
  await db.query('select public.save_behavior_assessment($1,$2,$3,$4,$5,$6,$7)',[f.application.id,'responsibility','meets','PRIVATE behavioral evidence',0,stamp,f.position.id]);
  const stage=await h.insert('assessment_stages',{company_id:f.companyId,recruitment_id:f.recruitment.id,name:'Synthetic stage',sequence:1});
  await h.insert('candidate_assessments',{company_id:f.companyId,recruitment_id:f.recruitment.id,application_id:f.application.id,stage_id:stage.id,notes:'PRIVATE assessment note'});
  const definition={kind:'competency_test',title:'Synthetic task',instructions:'Do the task',expectedOutput:'A report',durationMinutes:20,criteria:[{competency:'Planning',below:'Missing',meets:'Present',above:'Detailed'}]};
  const definitionId=(await db.query('select public.save_exercise_definition($1,$2,$3::jsonb,0,$4,$5) id',[f.recruitment.id,randomUUID(),JSON.stringify(definition),f.position.id,stamp])).rows[0].id;
  await db.query('select public.save_exercise_observations($1,$2,0,$3,$4::jsonb)',[f.application.id,definitionId,'PRIVATE work sample',JSON.stringify([{criterionIndex:0,rating:'meets',evidence:'PRIVATE observation'}])]);
  f=await h.completedApplication(f,Array(5).fill('meets'));
  const criterion=(await db.query('select id from public.screening_criterion_results where analysis_id=$1 order by criterion_order limit 1',[f.analysis_id])).rows[0].id;
  f.reviewId=await h.review(f,f.analysis_id,'approved_with_changes',[{criterion_result_id:criterion,rating_override:'above',explanation_override:'PRIVATE correction'}]);
  f.shortlistId=await h.add(f,'manual',undefined,'PRIVATE shortlist note');
  await v.register(f);await v.permission(f);await v.preferences(f);
  const communicationId=await v.prepare(f),revision={scoped_permission_revision:1,preference_revision:1};
  const receiptId=await v.ingest(f,v.receipt(f,revision),{context:revision});await h.asUser(f.owner);
  const approvalId=await v.approve(communicationId,receiptId);await v.cancel(communicationId,2);
  return {...f,communicationId,receiptId,approvalId};
 };
 const snapshot=async()=>{
  await h.asAdmin();
  const tables=(await db.query("select schemaname,tablename from pg_tables where schemaname in ('public','private') order by schemaname,tablename")).rows;
  const rows={};for(const {schemaname,tablename}of tables)rows[`${schemaname}.${tablename}`]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') value from ${schemaname}.${tablename} t`)).rows[0].value;
  return rows;
 };
 return {policy,getPolicy,resolve,getResolution,preview,rich,snapshot,v};
}
