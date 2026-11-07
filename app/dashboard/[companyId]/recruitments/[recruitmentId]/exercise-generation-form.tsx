'use client';
import { useActionState } from 'react';
import Link from 'next/link';
import { generateExerciseProposal } from './exercise-generation-action';
export function ExerciseGenerationForm({companyId,recruitmentId,requestKey,positionStamp,companyStamp}:{
  companyId:string;recruitmentId:string;requestKey:string;positionStamp:string;companyStamp:string|null;
}) {
  const [state,action,pending]=useActionState(generateExerciseProposal.bind(null,companyId,recruitmentId,requestKey,positionStamp,companyStamp),{});
  return <form action={action}>
    <p>AI przygotuje zadanie na podstawie profilu firmy i stanowiska. Dane kandydatów nie są przekazywane.
      Propozycję trzeba przeczytać i zatwierdzić przed użyciem. Limit wynosi do 20 prób na rekrutację; nieudane próby też go zużywają.</p>
    <fieldset disabled={pending||Boolean(state.exerciseId)}>
      <label><input type="checkbox" name="confirm" value="yes" required/> Potwierdzam przekazanie profilu firmy i stanowiska do AI.</label>
      <button type="submit">{pending?'Przygotowywanie propozycji…':'Przygotuj propozycję AI'}</button>
    </fieldset>
    {state.error&&<p role="alert">{state.error}</p>}
    {state.exerciseId&&<p role="status">Propozycja jest gotowa. <Link href={`/dashboard/${companyId}/recruitments/${recruitmentId}/exercises/${state.exerciseId}`}>Przeczytaj i zatwierdź</Link></p>}
  </form>;
}
