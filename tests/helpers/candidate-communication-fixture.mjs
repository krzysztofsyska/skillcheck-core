import {randomUUID} from 'node:crypto';
export const windows=[{weekday:1,start_minute:540,end_minute:1020}];
export function communicationHarness(h){
 const {db}=h;
 const permission=async(f,state='unverified',revision=0,key=randomUUID(),recruitment=f.recruitment.id,channel='email',evidence='20000000-0000-0000-0000-000000000001')=>(await db.query('select public.record_contact_permission($1,$2,$3,$4,$5,$6,$7) as id',[f.candidate.id,recruitment,channel,state,evidence,revision,key])).rows[0].id;
 const preferences=async(f,revision=0,key=randomUUID(),blocked=[],timezone='Europe/Warsaw',schedule=windows)=>(await db.query('select public.set_contact_preferences($1,$2,$3::jsonb,$4::text[],$5,$6) as id',[f.candidate.id,timezone,JSON.stringify(schedule),blocked,revision,key])).rows[0].id;
 const prepare=async(f,key=randomUUID(),channel='email',shortlist=f.shortlistId)=>(await db.query('select public.prepare_candidate_communication($1,$2,$3,$4) as id',[f.application.id,shortlist,channel,key])).rows[0].id;
 const cancel=async(id,version=1,key=randomUUID())=>(await db.query('select public.cancel_candidate_communication($1,$2,$3) as id',[id,version,key])).rows[0].id;
 const list=async(f,time=null,id=null,size=50)=>(await db.query('select * from public.get_candidate_communications($1,$2,$3,$4)',[f.application.id,time,id,size])).rows;
 const history=async(id,time=null,after=null,size=50)=>(await db.query('select * from public.get_candidate_communication_history($1,$2,$3,$4)',[id,time,after,size])).rows;
 const ready=async(ratings=Array(5).fill('meets'))=>{const f=await h.completedApplication(await h.seed(),ratings);f.shortlistId=await h.add(f,'manual');return f;};
 return {permission,preferences,prepare,cancel,list,history,ready};
}
