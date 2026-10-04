'use client';
import {useActionState,useState} from 'react';
import {saveExerciseObservations} from './exercise-observation-actions';
import {behaviorRatings} from '../../../../../lib/behavior-assessment';
import type {BehaviorRoute} from '../../../../../lib/behavior-context';
import type {ExerciseDefinitionEntry,ExerciseObservationEntry} from '../../../../../lib/supabase/database.types';
export function ExerciseObservationForm({route,rubric,entry}:{route:BehaviorRoute;rubric:ExerciseDefinitionEntry;entry?:ExerciseObservationEntry}) {
  const [opened]=useState({route,definitionId:rubric.id});
  const [version,setVersion]=useState(entry?.version??0);
  const [sample,setSample]=useState(entry?.work_sample??'');
  const [rows,setRows]=useState(rubric.definition.criteria.map((_,index)=>({rating:entry?.observations[index]?.rating??'insufficient_data',evidence:entry?.observations[index]?.evidence??''})));
  const [state,action,pending]=useActionState(async(previous:{error?:string;entryId?:string},form:FormData)=>{
    const result=await saveExerciseObservations(opened.route,opened.definitionId,version,previous,form);
    if(result.entryId)setVersion(v=>v+1);return result;
  },{});
  return <form action={action} onReset={event=>event.preventDefault()}>
    {state.error&&<p role="alert">{state.error}</p>}
    {state.entryId&&!state.error&&<p role="status">Zapisano wersję oceny {version}. Poprzednie wpisy pozostają w historii.</p>}
    <fieldset disabled={pending}><legend>Obserwacje wykonania — wersja zadania {rubric.version}</legend>
      <label>Tekst lub opis wykonanej pracy<textarea name="workSample" maxLength={20000} value={sample} onChange={e=>setSample(e.target.value)}/></label>
      {rubric.definition.criteria.map((criterion,index)=><fieldset key={index}><legend>{criterion.competency}</legend>
        <p>Poniżej wymagań: {criterion.below}</p><p>Zgodnie z wymaganiami: {criterion.meets}</p><p>Powyżej wymagań: {criterion.above}</p>
        <label>Ocena — {criterion.competency}<select name="rating" value={rows[index].rating} onChange={e=>setRows(values=>values.map((row,i)=>i===index?{...row,rating:e.target.value as typeof row.rating}:row))}>
          {behaviorRatings.map(([key,label])=><option key={key} value={key}>{label}</option>)}
        </select></label>
        <label>Dowody i uzasadnienie — {criterion.competency}<textarea name="evidence" maxLength={10000} required={rows[index].rating!=='insufficient_data'} value={rows[index].evidence}
          onChange={e=>setRows(values=>values.map((row,i)=>i===index?{...row,evidence:e.target.value}:row))}/></label>
      </fieldset>)}
      <button type="submit">{pending?'Zapisywanie…':'Zapisz obserwacje'}</button>
    </fieldset>
  </form>;
}
