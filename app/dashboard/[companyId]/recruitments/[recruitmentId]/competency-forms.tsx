'use client';
import {useActionState,useEffect,useRef,useState} from 'react';
import type {BehaviorRoute} from '../../../../../lib/behavior-context';
import type {ExerciseDefinition} from '../../../../../lib/exercise-definition';
import type {CompetencyAccess} from '../../../../../lib/competency-staff';
import {issueCompetencyGrant,rotateCompetencyGrant,revokeCompetencyGrant,saveCompetencyReview,type CompetencyActionState} from './competency-actions';

function Status({state}:{state:CompetencyActionState}) {
 return <>{state.error&&<p role="alert">{state.error}</p>}{state.message&&<p role="status">{state.message}</p>}
 {state.link&&<section><h3>Jednorazowy podgląd linku</h3><p>Skopiuj link i przekaż go kandydatowi własnym kanałem. Po odświeżeniu nie pokażemy go ponownie. Nie publikuj linku.</p>
 <label>Link do testu<textarea readOnly value={state.link} rows={3} spellCheck={false}/></label>
 <button type="button" onClick={()=>window.location.reload()}>Zamknij podgląd linku</button></section>}</>;
}
type GrantProps={route:BehaviorRoute;definitionId:string;grant?:CompetencyAccess;canIssue:boolean};
type GrantAction=(state:CompetencyActionState,form:FormData)=>Promise<CompetencyActionState>;
function useGrantAction(command:GrantAction,showLink:(link:string|undefined)=>void){
 const [requestKey,setRequestKey]=useState('');useEffect(()=>setRequestKey(crypto.randomUUID()),[]);
 const retry=useRef<GrantAction|null>(null);
 const [state,action,pending]=useActionState(async(_state:CompetencyActionState,form:FormData):Promise<CompetencyActionState>=>{
  // Preserve the original operation/revision as well as its key until a known
  // receipt. A refreshed row must not turn an uncertain retry into a rotation.
  const current=retry.current??=command;
  showLink(undefined);
  try{
   const result=await current({},form);
   if(result.confirmed){retry.current=null;setRequestKey(crypto.randomUUID());}
   showLink(result.link);
   return result;
  }catch{return {error:'Nie znamy wyniku operacji. Ponów ją, aby sprawdzić zapis. Poprzedniego podglądu linku nie należy używać.'};}
 },{});
 return {state,action,pending,requestKey};
}
export function CompetencyGrantForm({route,definitionId,grant,canIssue}:GrantProps){
 const [visibleLink,setVisibleLink]=useState<string>();
 const issue=issueCompetencyGrant.bind(null,route,definitionId);
 const rotate=rotateCompetencyGrant.bind(null,route,grant?.grantId??'',grant?.revision??0);
 const revoke=revokeCompetencyGrant.bind(null,route,grant?.grantId??'');
 const {state,action,pending,requestKey}=useGrantAction(grant?rotate:issue,setVisibleLink);
 const {state:revoked,action:revokeAction,pending:revoking,requestKey:revokeKey}=useGrantAction(revoke,setVisibleLink);
 const stopped=grant&&['revoked','withdrawn','expired'].includes(grant.state);
 return <div>{!stopped&&canIssue&&<form action={action}>
  <input type="hidden" name="requestKey" value={requestKey}/>
  {!grant&&<label>Rozpoczęcie w ciągu (godzin)<input type="number" name="hours" min={1} max={168} defaultValue={24} required/></label>}
  <button disabled={pending||revoking||!requestKey}>{grant?'Rotuj link i unieważnij poprzedni':'Wydaj dostęp do tej wersji'}</button>
 </form>}
 <Status state={{...state,link:pending||revoking||stopped?undefined:visibleLink}}/>
 {grant&&!stopped&&<form action={revokeAction}><input type="hidden" name="requestKey" value={revokeKey}/>
 <button disabled={pending||revoking||!revokeKey}>Odwołaj dostęp</button></form>}
 <Status state={revoked}/></div>;
}
export function CompetencyReviewForm({route,attemptId,version,definition}:{route:BehaviorRoute;attemptId:string;version:number;definition:ExerciseDefinition}){
 const [state,action,pending]=useActionState(saveCompetencyReview.bind(null,route,attemptId,version),{});
 const [rows,setRows]=useState(()=>definition.criteria.map(()=>({rating:'insufficient_data',evidence:''})));
 function update(index:number,field:'rating'|'evidence',value:string){
  setRows(current=>current.map((row,i)=>i===index?{...row,[field]:value}:row));
 }
 // A resolved action can contain an error. Retain the draft through React's
 // native form reset; a successfully revalidated review remounts with a new key.
 return <form action={action} onReset={event=>event.preventDefault()}><h3>Ocena rekrutera — nowa wersja</h3><p>Oceń wyłącznie dowody w oddanej pracy. Cytat musi dokładnie odpowiadać tekstowi kandydata.</p>
 {definition.criteria.map((criterion,i)=><fieldset key={i}><legend>{criterion.competency}</legend>
 <p>Poniżej: {criterion.below}</p><p>Zgodnie: {criterion.meets}</p><p>Powyżej: {criterion.above}</p>
 <label>Poziom<select name={'rating-'+i} value={rows[i].rating} onChange={event=>update(i,'rating',event.target.value)}>
 <option value="insufficient_data">Brak wystarczających danych</option><option value="below">Poniżej wymagań</option>
 <option value="meets">Zgodnie z wymaganiami</option><option value="above">Powyżej wymagań</option></select></label>
 <label>Dokładny cytat (puste przy braku danych)<textarea name={'evidence-'+i} maxLength={10000} rows={3} value={rows[i].evidence} onChange={event=>update(i,'evidence',event.target.value)}/></label>
 </fieldset>)}<button disabled={pending}>Zapisz ocenę z dowodami</button><Status state={state}/></form>;
}
