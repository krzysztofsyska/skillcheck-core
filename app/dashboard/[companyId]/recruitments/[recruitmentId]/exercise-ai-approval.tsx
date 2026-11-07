'use client';
import { useActionState } from 'react';
import { approveExerciseAiProposal, rejectExerciseAiProposal } from './exercise-ai-actions';
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

export function ExerciseAiRejection({companyId,context}: {companyId:string;context:ExerciseAiApprovalContext}) {
  const [state,action,pending]=useActionState(rejectExerciseAiProposal.bind(null,companyId,context),{});
  return <form action={action}>
    {state.error && <p role="alert">{state.error}</p>}
    {state.rejected ? <p role="status">Odrzucono propozycję. Jej treść i powód pozostają w historii; ta wersja nie może zostać zatwierdzona.</p> : <fieldset disabled={pending}>
      <legend>Odrzucenie propozycji</legend>
      <label>Powód odrzucenia<textarea name="reason" required maxLength={1000} rows={3}/></label>
      <button type="submit">{pending ? 'Odrzucanie…' : 'Odrzuć propozycję'}</button>
    </fieldset>}
  </form>;
}

