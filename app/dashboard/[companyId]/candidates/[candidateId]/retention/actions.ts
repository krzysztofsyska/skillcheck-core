'use server';
import { companyAccess } from '../../../../../../lib/company-access';
import { parseRules,parseSubject,parsePreview,revision,safeFailure,requestKey,type RetentionState } from '../../../../../../lib/erasure-preview';
async function access(companyId:string,candidateId:string){
 const a=await companyAccess(companyId);
 if(a.company.owner_id!==a.user.id)throw Error('OWNER_ONLY');
 const candidate=await a.client.from('candidates').select('id').eq('company_id',companyId).eq('id',candidateId).maybeSingle();
 if(candidate.error||!candidate.data)throw Error('UNAVAILABLE');return a.client;
}
export async function saveRetentionPolicy(companyId:string,candidateId:string,_state:RetentionState,form:FormData):Promise<RetentionState>{
 let client;try{client=await access(companyId,candidateId)}catch{return {error:'Ta czynność jest dostępna wyłącznie właścicielowi firmy.'}}
 let rules,expected,key;try{rules=parseRules(form);expected=revision(form.get('revision'));key=requestKey(form)}catch(e){return {error:(e as Error).message}}
 const result=await client.rpc('configure_candidate_retention_policy',{target_company:companyId,expected_revision:expected,policy_rules:rules,request_key:key});
 if(result.error||!result.data)return {error:safeFailure(result.error?.code)};
 return {saved:'Zapisano zasady przechowywania. Nie usunięto żadnych danych.',revision:expected+1};
}
export async function confirmSubject(companyId:string,candidateId:string,_state:RetentionState,form:FormData):Promise<RetentionState>{
 let client;try{client=await access(companyId,candidateId)}catch{return {error:'Ta czynność jest dostępna wyłącznie właścicielowi firmy.'}}
 let ids,expected,key;try{ids=parseSubject(form,candidateId);expected=revision(form.get('revision'));key=requestKey(form)}catch(e){return {error:(e as Error).message}}
 const result=await client.rpc('confirm_erasure_subject',{target_candidate:candidateId,candidate_ids:ids,expected_revision:expected,request_key:key});
 if(result.error||!result.data)return {error:safeFailure(result.error?.code)};
 return {saved:'Zapisano potwierdzenie tożsamości rekordów. Nie połączono ani nie usunięto danych.',revision:expected+1};
}
export async function previewErasure(companyId:string,candidateId:string,_state:RetentionState,form:FormData):Promise<RetentionState>{
 let client;try{client=await access(companyId,candidateId)}catch{return {error:'Ta czynność jest dostępna wyłącznie właścicielowi firmy.'}}
 const scope=String(form.get('scope_kind'));if(scope!=='candidate_record'&&scope!=='confirmed_subject')return {error:'Wybierz zakres podglądu.'};
 let resolutionId:string|undefined;
 if(scope==='confirmed_subject'){
  const result=await client.rpc('get_erasure_subject_resolution',{target_candidate:candidateId});
  if(result.error)return {error:safeFailure(result.error.code)};
  const r=result.data as {id?:string;owner_current?:boolean}|null;
  if(!r?.id||r.owner_current!==true)return {error:'Najpierw potwierdź rekordy tej samej osoby.'};resolutionId=r.id;
 }
 const result=await client.rpc('preview_candidate_erasure',{target_candidate:candidateId,scope_kind:scope,resolution_id:resolutionId});
 if(result.error)return {error:safeFailure(result.error.code)};
 try{return {preview:parsePreview(result.data)}}catch{return {error:'Podgląd jest niedostępny. Spróbuj ponownie później.'}}
}

export async function searchSubjectCandidates(companyId:string,candidateId:string,query:string,after:string|null){
 let client;try{client=await access(companyId,candidateId)}catch{return {error:'Nie udało się sprawdzić uprawnień.',candidates:[],next:null}};
 if(typeof query!=='string'||query.length>100||(after!==null&&!/^[0-9a-f-]{36}$/i.test(after)))return {error:'Nieprawidłowe wyszukiwanie.',candidates:[],next:null};
 let q=client.from('candidates').select('id,first_name,last_name').eq('company_id',companyId).order('id').limit(26);
 // Only literal surname prefix; no PostgREST expression assembled from user input.
 if(query.trim())q=q.ilike('last_name',query.trim().replace(/[\\%_]/g,'\\$&')+'%');
 if(after)q=q.gt('id',after);
 const result=await q;
 if(result.error)return {error:'Nie udało się wczytać listy. Spróbuj ponownie.',candidates:[],next:null};
 const candidates=result.data.slice(0,25);
 return {candidates,next:result.data.length>25?candidates[candidates.length-1].id:null,error:undefined};
}
