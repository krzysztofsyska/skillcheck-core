'use client';
import { useActionState } from 'react';
import { approveExerciseAiProposal } from './exercise-ai-actions';
import type { ExerciseAiApprovalContext } from '../../../../../lib/exercise-ai-review';

export function ExerciseAiApproval({companyId,context}: {companyId:string;context:ExerciseAiApprovalContext}) {
  const [state,action,pending]=useActionState(approveExerciseAiProposal.bind(null,companyId,context),{});
  return <form action={action}>
    {state.error && <p role="alert">{state.error}</p>}
    {state.approved ? <p role="status">Zatwierdzono tę wersję propozycji. Zadanie nie zostało wysłane do kandydatów.</p> : <fieldset disabled={pending}>
      <legend>Zatwierdzenie wersji zadania</legend>
      <label><input type="checkbox" name="confirm" value="yes" required/> Przeczytałem zadanie, kryteria i zapisany profil stanowiska. Zatwierdzam tę wersję.</label>
      <button type="submit">{pending ? 'Zatwierdzanie…' : 'Zatwierdź propozycję'}</button>
    </fieldset>}
  </form>;
}

