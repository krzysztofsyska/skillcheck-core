'use server';
import {companyAccess} from '../../../../lib/company-access';
import {requestKey,revision} from '../../../../lib/erasure-preview';
import {parseTicket,uuid,lifecycleFailure,type LifecycleState} from '../../../../lib/erasure-lifecycle';
async function owner(companyId:string){const a=await companyAccess(companyId);if(a.company.owner_id!==a.user.id)throw Error('OWNER_ONLY');return a.client;}
export async function issueErasureTicket(companyId:string,candidateId:string,_state:LifecycleState,form:FormData):Promise<LifecycleState>{
 let client;try{client=await owner(companyId);uuid(candidateId)}catch{return {error:'Ta czynność jest dostępna wyłącznie właścicielowi firmy.'}}
 const scope=String(form.get('scope_kind'));if(scope!=='candidate_record'&&scope!=='confirmed_subject')return {error:'Wybierz zakres żądania.'};
 // Bind the route tenant before minting an authorization preview. Later actions operate on DB-owned requests.
 const candidate=await client.from('candidates').select('id').eq('company_id',companyId).eq('id',candidateId).maybeSingle();
 if(candidate.error||!candidate.data)return {error:'Rekord jest niedostępny. Sprawdź listę żądań.'};
 let resolutionId:string|undefined;
 if(scope==='confirmed_subject'){
  const r=await client.rpc('get_erasure_subject_resolution',{target_candidate:candidateId});
  if(r.error)return {error:lifecycleFailure(r.error.code)};
  const resolution=r.data as {id?:string;owner_current?:boolean}|null;
  if(!resolution?.id||resolution.owner_current!==true)return {error:'Najpierw potwierdź rekordy tej samej osoby.'};resolutionId=resolution.id;
 }
 const result=await client.rpc('issue_candidate_erasure_preview',{target_candidate:candidateId,scope_kind:scope,resolution_id:resolutionId});
 if(result.error)return {error:lifecycleFailure(result.error.code)};
 try{return {ticket:parseTicket(result.data)}}catch{return {error:'Nie otrzymano poprawnego podglądu. Przygotuj go ponownie.'}}
}
export async function authorizeErasure(companyId:string,_state:LifecycleState,form:FormData):Promise<LifecycleState>{
 let client;try{client=await owner(companyId)}catch{return {error:'Ta czynność jest dostępna wyłącznie właścicielowi firmy.'}}
 if(form.get('confirmed')!=='on')return {error:'Potwierdź zakres i wstrzymanie zmian.'};
 let ticket,key;try{ticket=uuid(form.get('preview_ticket_id'));key=requestKey(form)}catch{return {error:'Nieprawidłowe żądanie. Przygotuj nowy podgląd.'}}
 const result=await client.rpc('request_candidate_erasure',{preview_ticket_id:ticket,request_key:key});
 if(result.error||!result.data)return {error:lifecycleFailure(result.error?.code)};
 return {requestId:result.data,saved:'Zatwierdzono żądanie i wstrzymano zmiany danych. Nie wykonano usunięcia.'};
}
export async function cancelErasure(companyId:string,_state:LifecycleState,form:FormData):Promise<LifecycleState>{
 let client;try{client=await owner(companyId)}catch{return {error:'Ta czynność jest dostępna wyłącznie właścicielowi firmy.'}}
 if(form.get('confirmed')!=='on')return {error:'Potwierdź anulowanie żądania.'};
 let id,generation,key;try{id=uuid(form.get('request_id'));generation=revision(form.get('generation'));key=requestKey(form)}catch{return {error:'Odśwież listę żądań i spróbuj ponownie.'}}
 const result=await client.rpc('cancel_candidate_erasure',{target_request:id,expected_generation:generation,request_key:key});
 if(result.error||!result.data)return {error:lifecycleFailure(result.error?.code)};
 return {requestId:result.data,saved:'Anulowano żądanie. Nie przywrócono niezależnie cofniętych zgód ani anulowanych zaproszeń.'};
}
