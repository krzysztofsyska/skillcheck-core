'use client';
import { useActionState, useState } from 'react';
import { behaviorRatings } from '../../../../../lib/behavior-assessment';
import type { ExerciseDefinition } from '../../../../../lib/exercise-definition';
import type { PairedAssessorActionState } from './paired-assessor-actions';

type Action = (previous: PairedAssessorActionState, form: FormData) => Promise<PairedAssessorActionState>;
export function PairedAssessorAssignmentForm({ action, ids, userId }: { action: Action; ids: string[]; userId: string }) {
  const [state, submit, pending] = useActionState(action, {});
  return <form action={submit}>
    {state.error && <p role="alert">{state.error}</p>}
    <fieldset disabled={pending || state.saved}><legend>Przypisz dwie osoby</legend>
      {['first', 'second'].map((name, i) => <label key={name}>Asesor {i + 1}
        <select name={name} defaultValue={ids[i]}>{ids.map(id => <option value={id} key={id}>{id === userId ? 'Ty' : id}</option>)}</select>
      </label>)}<button>{pending ? 'Zapisywanie…' : 'Przypisz asesorów'}</button>
    </fieldset>
  </form>;
}

export function PairedAssessorForm({ action, definition }: { action: Action; definition: ExerciseDefinition }) {
  const [state, submit, pending] = useActionState(action, {});
  const [rows, setRows] = useState(definition.criteria.map(() => ({ rating: 'insufficient_data', evidence: '', context: '' })));
  function update(index: number, field: 'rating' | 'evidence' | 'context', value: string) {
    setRows(current => current.map((row, i) => i === index ? { ...row, [field]: value } : row));
  }
  return <form action={submit} onReset={event => event.preventDefault()}>
    {state.error && <p role="alert">{state.error}</p>}
    {state.saved && <p role="status">Arkusz został oddany. Porównanie pojawi się po oddaniu obu arkuszy.</p>}
    <fieldset disabled={pending || state.saved}><legend>Twój niezależny arkusz</legend>
      {definition.criteria.map((criterion, index) => <fieldset key={index}><legend>{criterion.competency}</legend>
        <p>Poniżej wymagań: {criterion.below}</p><p>Zgodnie z wymaganiami: {criterion.meets}</p><p>Powyżej wymagań: {criterion.above}</p>
        <label>Ocena<select name="rating" value={rows[index].rating} onChange={event => update(index, 'rating', event.target.value)}>
          {behaviorRatings.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>Dowód<textarea name="evidence" maxLength={4000} minLength={rows[index].rating === 'insufficient_data' ? undefined : 10}
          required={rows[index].rating !== 'insufficient_data'} value={rows[index].evidence} onChange={event => update(index, 'evidence', event.target.value)} /></label>
        <label>Kontekst obserwacji<textarea name="context" maxLength={2000} minLength={rows[index].rating === 'insufficient_data' ? undefined : 5}
          required={rows[index].rating !== 'insufficient_data'} value={rows[index].context} onChange={event => update(index, 'context', event.target.value)} /></label>
      </fieldset>)}<button>{pending ? 'Zapisywanie…' : 'Oddaj swój arkusz'}</button>
    </fieldset>
  </form>;
}
