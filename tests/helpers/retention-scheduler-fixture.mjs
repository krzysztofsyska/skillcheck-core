import {randomUUID} from 'node:crypto';
import {executionHarness} from './erasure-execution-fixture.mjs';

// All policy values and clock aging in this fixture are synthetic local inputs.
export function retentionHarness(h){
 const x=executionHarness(h),{db}=h;
 const schedule=async(f,mode='suggest_only',revision=0,policyRevision=1,key=randomUUID())=>(await db.query('select public.configure_retention_schedule($1,$2,$3,$4,25,$5) value',[f.companyId,revision,policyRevision,mode,key])).rows[0].value;
 const revoke=async(f,revision=1,key=randomUUID())=>(await db.query('select public.revoke_retention_schedule($1,$2,$3) value',[f.companyId,revision,key])).rows[0].value;
 const scheduleStatus=async(f)=>(await db.query('select public.get_retention_schedule($1) value',[f.companyId])).rows[0].value;
 const tick=async(limit=25)=>{await h.asAdmin();await db.exec('set role erasure_scheduler');return(await db.query('select private.tick_retention_schedule($1) value',[limit])).rows[0].value;};
 const close=async(f)=>{await h.asUser(f.owner);await db.query("update public.applications set status='rejected' where id=$1",[f.application.id]);await db.query("update public.recruitments set status='closed' where id=$1",[f.recruitment.id]);};
 const age=async(f,ids=[f.candidate.id])=>{await h.asAdmin();await db.query("update private.retention_candidate_clocks set observed_at=clock_timestamp()-interval '40 days',closed_at=case when closed_at is null then null else clock_timestamp()-interval '40 days' end,consent_at=case when consent_at is null then null else clock_timestamp()-interval '40 days' end where candidate_id=any($1::uuid[])",[ids]);};
 return {...x,schedule,revoke,scheduleStatus,tick,close,age};
}
