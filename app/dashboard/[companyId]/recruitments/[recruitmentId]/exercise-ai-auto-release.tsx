'use client';
import { useActionState, useState } from 'react';
import { setExerciseAiAutoRelease } from './exercise-ai-auto-release-action';
import type { ExerciseAiAutoReleaseState } from '../../../../../lib/exercise-ai-review';

type Mode = 'manual' | 'auto';
type Props = { companyId: string; recruitmentId: string; current: boolean | null; editable: boolean };

/** Przełącznik R1-SWITCH. `current === null` znaczy, że obecnego trybu nie udało się odczytać. */
export function ExerciseAiAutoReleaseSwitch({ companyId, recruitmentId, current, editable }: Props) {
  // Wybór jest kontrolowany, więc po błędzie zapisu formularz zachowuje zaznaczenie.
  const [mode, setMode] = useState<Mode | null>(current === null ? null : current ? 'auto' : 'manual');
  const save = setExerciseAiAutoRelease.bind(null, companyId, recruitmentId);
  const [state, action, pending] = useActionState(async (previous: ExerciseAiAutoReleaseState, form: FormData) => {
    const next = await save(previous, form);
    if (!next.error && next.autoRelease !== undefined) setMode(next.autoRelease ? 'auto' : 'manual');
    return next;
  }, {});
  const saved = state.autoRelease === undefined ? current : state.autoRelease;
  return <form action={action}>
    <h2>Zatwierdzanie zadań przygotowanych przez AI</h2>
    {saved === null
      ? <p role="alert">Nie udało się odczytać obecnego trybu. Wybierz tryb i zapisz go ponownie.</p>
      : <p>Obecny tryb: <strong>{saved ? 'Automatycznie' : 'Zatwierdzam zadania sam'}</strong>.</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {!state.error && state.autoRelease !== undefined && <p role="status">Zapisano tryb zatwierdzania.</p>}
    <fieldset disabled={pending || !editable}>
      <legend>Tryb zatwierdzania dla tej rekrutacji</legend>
      <label><input type="radio" name="mode" value="manual" required checked={mode === 'manual'} onChange={() => setMode('manual')}/>
        {' '}<strong>Zatwierdzam zadania sam</strong> (domyślnie) — każde zadanie przygotowane przez AI czeka, aż je przeczytasz i zatwierdzisz.</label>
      <label><input type="radio" name="mode" value="auto" required checked={mode === 'auto'} onChange={() => setMode('auto')}/>
        {' '}<strong>Automatycznie</strong> — nowe zadania przygotowane przez AI są zatwierdzane od razu, bez Twojej lektury.
        Zapisujemy, że zatwierdził je automat. Twoje poprawki zadania nadal czekają na Twoje zatwierdzenie.</label>
      <p>W obu trybach test kompetencji może dostać tylko kandydat z krótkiej listy tej rekrutacji. To ustawienie niczego nie wysyła kandydatom.</p>
      {!editable && <p>Rekrutacja jest zamknięta albo stanowisko jest zarchiwizowane — trybu nie można zmienić.</p>}
      <button type="submit">{pending ? 'Zapisywanie…' : 'Zapisz tryb zatwierdzania'}</button>
    </fieldset>
  </form>;
}
