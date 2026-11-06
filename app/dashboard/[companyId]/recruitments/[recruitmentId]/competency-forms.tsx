'use client';
import {useActionState,useEffect,useState} from 'react';
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
export function CompetencyGrantForm({route,definitionId,grant,canIssue}:GrantProps){
 const [requestKey,setRequestKey]=useState('');useEffect(()=>setRequestKey(crypto.randomUUID()),[]);
 const issue=issueCompetencyGrant.bind(null,route,definitionId);
 const rotate=rotateCompetencyGrant.bind(null,route,grant?.grantId??'',grant?.revision??0);
 const revoke=revokeCompetencyGrant.bind(null,route,grant?.grantId??'');
 const [state,action,pending]=useActionState(grant?rotate:issue,{});
 const [revoked,revokeAction,revoking]=useActionState(revoke,{});
 const stopped=grant&&['revoked','withdrawn','expired'].includes(grant.state);
 return <div>{!stopped&&canIssue&&<form action={action}>
  <input type="hidden" name="requestKey" value={requestKey}/>
  {!grant&&<label>Rozpoczęcie w ciągu (godzin)<input type="number" name="hours" min={1} max={168} defaultValue={24} required/></label>}
  <button disabled={pending||!requestKey}>{grant?'Rotuj link i unieważnij poprzedni':'Wydaj dostęp do tej wersji'}</button>
 </form>}
 <Status state={state}/>
 {grant&&!stopped&&<form action={revokeAction}><input type="hidden" name="requestKey" value={requestKey}/>
 <button disabled={revoking||!requestKey}>Odwołaj dostęp</button></form>}
 <Status state={revoked}/></div>;
}
export function CompetencyReviewForm({route,attemptId,version,definition}:{route:BehaviorRoute;attemptId:string;version:number;definition:ExerciseDefinition}){
 const [state,action,pending]=useActionState(saveCompetencyReview.bind(null,route,attemptId,version),{});
 return <form action={action}><h3>Ocena rekrutera — nowa wersja</h3><p>Oceń wyłącznie dowody w oddanej pracy. Cytat musi dokładnie odpowiadać tekstowi kandydata.</p>
 {definition.criteria.map((criterion,i)=><fieldset key={i}><legend>{criterion.competency}</legend>
 <p>Poniżej: {criterion.below}</p><p>Zgodnie: {criterion.meets}</p><p>Powyżej: {criterion.above}</p>
 <label>Poziom<select name={'rating-'+i} defaultValue="insufficient_data">
 <option value="insufficient_data">Brak wystarczających danych</option><option value="below">Poniżej wymagań</option>
 <option value="meets">Zgodnie z wymaganiami</option><option value="above">Powyżej wymagań</option></select></label>
 <label>Dokładny cytat (puste przy braku danych)<textarea name={'evidence-'+i} maxLength={10000} rows={3}/></label>
 </fieldset>)}<button disabled={pending}>Zapisz ocenę z dowodami</button><Status state={state}/></form>;
}
