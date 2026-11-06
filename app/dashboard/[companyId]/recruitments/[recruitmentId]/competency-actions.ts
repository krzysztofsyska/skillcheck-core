'use server';
import {revalidatePath} from 'next/cache';
import {loadBehaviorContext,type BehaviorRoute} from '../../../../../lib/behavior-context';
import {exerciseUuid} from '../../../../../lib/exercise-context';
import {competencyActionError,parseCompetencyAccess} from '../../../../../lib/competency-staff';
import {evaluateCompetencyTest} from '../../../../../lib/competency-test';
import {staffWorkSample} from '../../../../../lib/competency-staff-response';
export type CompetencyActionState={error?:string;message?:string;link?:string};
function enabled(){return process.env.COMPETENCY_CANDIDATE_PREVIEW==='true'&&
 (process.env.VERCEL_ENV==='preview'||process.env.NODE_ENV==='development');}
const path=(r:BehaviorRoute)=>`/dashboard/${r.companyId}/recruitments/${r.recruitmentId}/applications/${r.applicationId}/exercises`;
async function access(r:BehaviorRoute) {
 if(!enabled())return null;
 const context=await loadBehaviorContext(r);return context.canEdit?context:null;
}
async function grantAction(route:BehaviorRoute,kind:'issue'|'rotate'|'revoke',target:string,revision:number,form:FormData):Promise<CompetencyActionState> {
 const context=await access(route);if(!context)return {error:'Brak uprawnień do zarządzania testem.'};
 const {client}=context,requestKey=String(form.get('requestKey')??'');
 if(!exerciseUuid.test(target)||!exerciseUuid.test(requestKey))return {error:'Odśwież formularz dostępu.'};
 let origin:URL;
 try{origin=new URL(process.env.COMPETENCY_BROKER_ORIGIN??'');if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)throw new Error();}
 catch{return {error:'Środowisko testów nie jest jeszcze gotowe.'};}
 const status=await client.rpc('list_competency_test_access',{target:route.applicationId});
 if(status.error)return {error:competencyActionError(status.error.code)};
 const current=parseCompetencyAccess(status.data);
 if(current.cancelled)return {error:'Dostęp do tego zgłoszenia został wycofany.'};
 let result;
 if(kind==='issue'){
  if(!current.shortlisted)return {error:'Wydanie dostępu wymaga aktywnego wpisu na shortliście.'};
  if(current.access.some(g=>g.definitionId===target))return {message:'Ta wersja ma już wydany dostęp. Odśwież status; sekret można zastąpić przez rotację.'};
  const definition=await client.from('exercise_definition_entries').select('id,definition').eq('company_id',route.companyId).eq('recruitment_id',route.recruitmentId).eq('id',target).maybeSingle();
  if(definition.error||definition.data?.definition.kind!=='competency_test')return {error:'Nie znaleziono wersji testu.'};
  const hours=Number(form.get('hours'));if(!Number.isInteger(hours)||hours<1||hours>168)return {error:'Termin rozpoczęcia: od 1 do 168 godzin.'};
  // The client cannot choose a company, actor, token or arbitrary target time.
  const startBy=new Date(Date.now()+hours*3600000).toISOString();
  result=await client.rpc('create_competency_test_grant',{target_application:route.applicationId,target_definition:target,start_by:startBy,request_key:requestKey});
 }else{
  const grant=current.access.find(g=>g.grantId===target);
  if(!grant)return {error:'Nie znaleziono dostępu w tym zgłoszeniu.'};
  if(kind==='rotate'){
   if(!current.shortlisted||!Number.isSafeInteger(revision)||revision!==grant.revision)return {error:'Odśwież aktualny dostęp i shortlistę.'};
   result=await client.rpc('rotate_competency_test_grant',{target,expected_revision:revision,request_key:requestKey});
  }else result=await client.rpc('revoke_competency_test_grant',{target,request_key:requestKey});
 }
 if(result.error)return {error:competencyActionError(result.error.code)};
 revalidatePath(path(route));
 const value=result.data;
 if(kind==='revoke')return {message:'Dostęp odwołany. Poprzedni link i sesje są nieważne.'};
 if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.token!=='string'||!/^[0-9a-f]{64}$/.test(value.token))
  return {message:'Operacja została wcześniej zapisana. Sekretu nie można odczytać ponownie; użyj rotacji.'};
 return {link:origin.origin+'/zadanie-kompetencyjne#grant='+value.token};
}
export async function issueCompetencyGrant(route:BehaviorRoute,definitionId:string,_state:CompetencyActionState,form:FormData){return grantAction(route,'issue',definitionId,0,form);}
export async function rotateCompetencyGrant(route:BehaviorRoute,grantId:string,revision:number,_state:CompetencyActionState,form:FormData){return grantAction(route,'rotate',grantId,revision,form);}
export async function revokeCompetencyGrant(route:BehaviorRoute,grantId:string,_state:CompetencyActionState,form:FormData){return grantAction(route,'revoke',grantId,0,form);}
export async function saveCompetencyReview(route:BehaviorRoute,attemptId:string,version:number,_state:CompetencyActionState,form:FormData):Promise<CompetencyActionState>{
 const context=await access(route);if(!context)return {error:'Brak uprawnień do oceny.'};
 if(!exerciseUuid.test(attemptId)||!Number.isSafeInteger(version)||version<0)return {error:'Odśwież wersję oceny.'};
 const {client}=context,response=await client.rpc('read_competency_test_response',{target:attemptId});
 if(response.error||!response.data||typeof response.data!=='object'||Array.isArray(response.data)||typeof response.data.definitionId!=='string')return {error:'Odpowiedź jest niedostępna.'};
 const definition=await client.from('exercise_definition_entries').select('definition').eq('company_id',route.companyId).eq('recruitment_id',route.recruitmentId).eq('id',response.data.definitionId).maybeSingle();
 if(definition.error||!definition.data)return {error:'Wersja zadania jest niedostępna.'};
 try{
  const answer=staffWorkSample(response.data,route,attemptId);
  const observations=definition.data.definition.criteria.map((_,i)=>({criterionIndex:i,rating:String(form.get('rating-'+i)??''),evidence:String(form.get('evidence-'+i)??'')}));
  const reviewed=evaluateCompetencyTest(definition.data.definition,{workSample:answer},observations);
  const result=await client.rpc('save_competency_test_review',{target:attemptId,expected_version:version,observations:reviewed.criterionResults.map(({criterionIndex,rating,evidence})=>({criterionIndex,rating,evidence}))});
  if(result.error)return {error:competencyActionError(result.error.code)};
  revalidatePath(path(route));return {message:'Zapisano nową wersję oceny z dowodami.'};
 }catch(error){return {error:error instanceof Error?error.message:'Sprawdź ocenę i cytaty.'};}
}
