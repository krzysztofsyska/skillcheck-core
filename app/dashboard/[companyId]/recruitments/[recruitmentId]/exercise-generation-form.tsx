'use client';
import { useActionState, useState } from 'react';
import Link from 'next/link';
import { generateExerciseProposal } from './exercise-generation-action';
type Props = {
  companyId:string;recruitmentId:string;requestKey:string;positionStamp:string;companyStamp:string|null;
};
export function ExerciseGenerationForm(props:Props) {
  const [requestKey,setRequestKey]=useState(props.requestKey);
  // Only the explicit new-attempt button rotates the key. A new keyed child
  // clears both the previous result and the consent checkbox, without submitting.
  return <GenerationAttempt {...props} key={requestKey} requestKey={requestKey}
    onNewAttempt={()=>setRequestKey(crypto.randomUUID())}/>;
}
function GenerationAttempt({companyId,recruitmentId,requestKey,positionStamp,companyStamp,onNewAttempt}:Props&{onNewAttempt:()=>void}) {
  const [state,action,pending]=useActionState(generateExerciseProposal.bind(null,companyId,recruitmentId,requestKey,positionStamp,companyStamp),{});
  return <form action={action}>
    <p>AI przygotuje zadanie na podstawie profilu firmy i stanowiska. Dane kandydatów nie są przekazywane.
      Propozycję trzeba przeczytać i zatwierdzić przed użyciem. Limit wynosi do 20 prób na rekrutację; nieudane próby też go zużywają.</p>
    <fieldset disabled={pending||Boolean(state.exerciseId)||state.terminalFailure}>
      <label><input type="checkbox" name="confirm" value="yes" required/> Potwierdzam przekazanie profilu firmy i stanowiska do AI.</label>
      <button type="submit">{pending?'Przygotowywanie propozycji…':'Przygotuj propozycję AI'}</button>
    </fieldset>
    {state.error&&<p role="alert">{state.error}</p>}
    {state.terminalFailure&&!state.exerciseId&&<button type="button" disabled={pending} onClick={onNewAttempt}>Rozpocznij nową próbę AI (zużyje kolejną próbę z limitu)</button>}
    {state.exerciseId&&<p role="status">Propozycja jest gotowa. <Link href={`/dashboard/${companyId}/recruitments/${recruitmentId}/exercises/${state.exerciseId}`}>Przeczytaj i zatwierdź</Link></p>}
  </form>;
}
