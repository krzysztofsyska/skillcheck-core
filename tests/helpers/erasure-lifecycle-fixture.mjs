import {randomUUID} from 'node:crypto';
import {erasureHarness} from './erasure-preview-fixture.mjs';

// Explicit synthetic test policy; never operator/legal defaults.
export const lifecycleRules=['candidate','assessment','screening','communication','audit','external','backup','exports'].map(data_class=>({data_class,trigger_event:'record_created',duration_days:30,hold_review_days:7}));
export function lifecycleHarness(h){
 const {db}=h,e=erasureHarness(h);
 // Public RPC arguments below are finalized with the lifecycle builder.
 const ticket=async(f,scope='confirmed_subject',resolution=f.resolutionId)=>(await db.query('select public.issue_candidate_erasure_preview($1,$2,$3) value',[f.candidate.id,scope,resolution])).rows[0].value;
 const authorize=async(f,preview,key=randomUUID())=>(await db.query('select public.request_candidate_erasure($1,$2) value',[preview.preview_ticket_id,key])).rows[0].value;
 const cancel=async(f,request,generation,key=randomUUID())=>(await db.query('select public.cancel_candidate_erasure($1,$2,$3) value',[request,generation,key])).rows[0].value;
 const status=async(f)=>(await db.query('select public.get_candidate_erasure_status($1) value',[f.candidate.id])).rows[0].value;
 const ready=async({rich=false,ids,owner}={})=>{
  const f=rich?await e.rich():await h.seed(owner);await h.asUser(f.owner);
  await e.policy(f,0,lifecycleRules);f.resolutionId=await e.resolve(f,ids??[f.candidate.id]);return f;
 };
 const freeze=async(f)=>{await h.asUser(f.owner);const p=await ticket(f);const requestId=await authorize(f,p);return {...await status(f),request_id:requestId};};
 return {...e,h,db,ticket,authorize,cancel,status,ready,freeze};
}
