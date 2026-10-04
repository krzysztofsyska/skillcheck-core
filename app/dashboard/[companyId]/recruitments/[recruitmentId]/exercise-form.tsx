'use client';
import { useActionState, useRef, useState } from 'react';
import Link from 'next/link';
import type { ExerciseDefinition, ExerciseCriterion } from '../../../../../lib/exercise-definition';
import type { ExerciseEditorContext } from '../../../../../lib/exercise-editor';
import { saveExerciseDefinition } from './exercise-actions';

const blankCriterion = (): ExerciseCriterion => ({ competency: '', below: '', meets: '', above: '' });
export function ExerciseForm({ companyId, context, initial }: {
  companyId: string; context: ExerciseEditorContext; initial?: ExerciseDefinition;
}) {
  // Keep the profile/version the user saw, even if another form revalidates the page.
  const [opened, setOpened] = useState(context);
  const [kind, setKind] = useState(initial?.kind ?? 'competency_test');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [instructions, setInstructions] = useState(initial?.instructions ?? '');
  const [output, setOutput] = useState(initial?.expectedOutput ?? '');
  const [duration, setDuration] = useState(String(initial?.durationMinutes ?? 20));
  const [criteria, setCriteria] = useState(() => (initial?.criteria ?? [blankCriterion()]).map((value, id) => ({ id, ...value })));
  const nextId = useRef(criteria.length);
  const [state, action, pending] = useActionState(async (previous: { error?: string; entryId?: string }, form: FormData) => {
    const result = await saveExerciseDefinition(companyId, opened, previous, form);
    if (result.entryId) setOpened(current => ({ ...current, expectedVersion: current.expectedVersion + 1 }));
    return result;
  }, {});
  const updateCriterion = (id: number, field: keyof ExerciseCriterion, value: string) =>
    setCriteria(current => current.map(criterion => criterion.id === id ? { ...criterion, [field]: value } : criterion));
  return <form action={action} onReset={event => event.preventDefault()}>
    {state.error && <p role="alert">{state.error}</p>}
    {state.entryId && <p role="status">Zapisano wersję {opened.expectedVersion}. Kolejny zapis zachowa poprzednią wersję w historii.{' '}
      <Link href={`/dashboard/${companyId}/recruitments/${opened.recruitmentId}/exercises/${opened.exerciseId}`}>Otwórz historię zadania</Link></p>}
    <fieldset disabled={pending}>
      <legend>Instrukcja zadania</legend>
      <label>Rodzaj zadania<select name="kind" value={kind} onChange={event => setKind(event.target.value as ExerciseDefinition['kind'])}>
        <option value="competency_test">Test kompetencji</option><option value="assessment_center">Assessment Center</option>
      </select></label>
      <label>Tytuł<input name="title" required maxLength={200} value={title} onChange={event => setTitle(event.target.value)}/></label>
      <label>Instrukcja dla osoby wykonującej zadanie<textarea name="instructions" required maxLength={10000} rows={6} value={instructions} onChange={event => setInstructions(event.target.value)}/></label>
      <label>Oczekiwany rezultat<textarea name="expectedOutput" required maxLength={4000} rows={3} value={output} onChange={event => setOutput(event.target.value)}/></label>
      <label>Czas zadania w minutach<input name="durationMinutes" type="number" min={1} max={180} step={1} required value={duration} onChange={event => setDuration(event.target.value)}/></label>
      <h2>Kryteria oceny</h2>
      <p>Opisz obserwowalne działania i rezultaty. Przy braku dowodów nie przypisuj oceny poniżej wymagań.</p>
      {criteria.map((criterion, index) => <fieldset key={criterion.id}>
        <legend>Kryterium {index + 1}</legend>
        <label>Kompetencja<input name="competency" required maxLength={200} value={criterion.competency} onChange={event => updateCriterion(criterion.id, 'competency', event.target.value)}/></label>
        {([['below', 'Poniżej wymagań'], ['meets', 'Zgodnie z wymaganiami'], ['above', 'Powyżej wymagań']] as const).map(([field, label]) =>
          <label key={field}>{label}<textarea name={field} required maxLength={2000} rows={3} value={criterion[field]} onChange={event => updateCriterion(criterion.id, field, event.target.value)}/></label>)}
        <button type="button" disabled={criteria.length === 1} onClick={() => setCriteria(current => current.filter(row => row.id !== criterion.id))}>Usuń kryterium {index + 1}</button>
      </fieldset>)}
      <button type="button" disabled={criteria.length >= 12} onClick={() => {
        const id = nextId.current++; setCriteria(current => [...current, { id, ...blankCriterion() }]);
      }}>Dodaj kryterium</button>
      <p>{criteria.length} z maksymalnie 12 kryteriów. Zapis dotyczy definicji zadania, nie oceny kandydata.</p>
      <button type="submit">{pending ? 'Zapisywanie…' : 'Zapisz wersję zadania'}</button>
    </fieldset>
  </form>;
}
