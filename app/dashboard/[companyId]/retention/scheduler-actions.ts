'use server';
import {companyAccess} from '../../../../lib/company-access';
import {revision,requestKey} from '../../../../lib/erasure-preview';
import {uuid} from '../../../../lib/erasure-lifecycle';
import {delegationInput,schedulerFailure,type SchedulerActionState} from '../../../../lib/retention-scheduler';
async function owner(companyId:string){const a=await companyAccess(companyId);if(a.company.owner_id!==a.user.id)throw Error('OWNER_ONLY');return a.client;}
export async function configureSchedule(companyId:string,_state:SchedulerActionState,form:FormData):Promise<SchedulerActionState>{
 let client;try{client=await owner(companyId)}catch{return {error:'Ta czynność jest dostępna wyłącznie właścicielowi firmy.'}}
 let input;try{input=delegationInput(form)}catch(e){return {error:e instanceof Error?e.message:'Sprawdź formularz.'}}
 const result=await client.rpc('configure_retention_schedule',{target_company:companyId,expected_revision:input.expected_revision,policy_revision:input.policy_revision,execution_mode:input.execution_mode,max_batch:input.max_batch,request_key:input.request_key});
 if(result.error)return {error:schedulerFailure(result.error.code)};
 try{uuid(result.data)}catch{return {error:'Nie otrzymano potwierdzenia zapisu. Sprawdź monitor przed ponowieniem.'}}
 return {saved:input.execution_mode==='automatic'?'Zapisano delegację automatycznego zatwierdzania dla tej wersji polityki. Możliwość wykonania nadal zależy od warunków widocznych w monitorze.':'Zapisano tryb propozycji. Każde usunięcie wymaga osobnej zgody właściciela.'};
}
export async function revokeSchedule(companyId:string,_state:SchedulerActionState,form:FormData):Promise<SchedulerActionState>{
 let client;try{client=await owner(companyId)}catch{return {error:'Ta czynność jest dostępna wyłącznie właścicielowi firmy.'}}
 if(form.get('confirmed')!=='on')return {error:'Potwierdź wycofanie delegacji.'};
 let expected,key;try{expected=revision(form.get('expected_revision'));key=requestKey(form);if(expected<1)throw Error()}catch{return {error:'Odśwież monitor i spróbuj ponownie.'}}
 const result=await client.rpc('revoke_retention_schedule',{target_company:companyId,expected_revision:expected,request_key:key});
 if(result.error)return {error:schedulerFailure(result.error.code)};
 try{uuid(result.data)}catch{return {error:'Nie otrzymano potwierdzenia wycofania. Sprawdź monitor.'}}
 return {saved:'Wycofano delegację dla kolejnych działań harmonogramu. Rozpoczęte nieodwracalne usuwanie wymaga dokończenia; sprawdź listę żądań.'};
}
