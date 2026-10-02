'use client';
import { useActionState, useState } from 'react';
import { SubmitButton } from '../../../../components/submit-button';
import { behaviorRatings } from '../../../../../lib/behavior-assessment';
import type { BehaviorAssessmentEntry } from '../../../../../lib/supabase/database.types';
import { saveBehaviorAssessment } from './behavior-actions';

export function BehaviorForm({ companyId, recruitmentId, applicationId, areaKey, positionId, positionUpdatedAt, assessment }: {
  companyId: string; recruitmentId: string; applicationId: string; areaKey: string; positionId: string;
  positionUpdatedAt: string; assessment?: BehaviorAssessmentEntry;
}) {
  const [rating, setRating] = useState<string>(assessment?.rating ?? 'insufficient_data');
  const [evidence, setEvidence] = useState(assessment?.evidence ?? '');
  // Freeze the context that the editor opened. A revalidation from another form
  // must not silently adopt a changed profile while retaining an unsaved opinion.
  const [opened, setOpened] = useState({ version: assessment?.version ?? 0, positionId, positionUpdatedAt });
  const [state, action] = useActionState(async (previous: { error?: string; saved?: boolean }, form: FormData) => {
    const result = await saveBehaviorAssessment(companyId, recruitmentId, applicationId, areaKey,
      opened.version, opened.positionId, opened.positionUpdatedAt, previous, form);
    if (result.saved) setOpened({ ...opened, version: opened.version + 1 });
    return result;
  }, {});
  // React actions reset native form controls after resolving (also when an
  // action returns a validation error). Keep this revision editor intact.
  return <form action={action} onReset={event => event.preventDefault()}>
    {state.error && <p role="alert">{state.error}</p>}{state.saved && <p role="status">Zapisano nową wersję oceny.</p>}
    <label>Ocena względem wymagań<select name="rating" value={rating} onChange={e => setRating(e.target.value)}>
      {behaviorRatings.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>
    <label>Dowody i uzasadnienie<textarea name="evidence" rows={6} maxLength={10000} value={evidence}
      onChange={e => setEvidence(e.target.value)} required={rating !== 'insufficient_data'}/></label>
    <p>Opisz sytuację lub zadanie, konkretne działania i rezultat. Oddziel relację kandydata od własnej obserwacji.
      Przy braku danych wskaż, co wymaga dalszego sprawdzenia. Poprawka pozostawi poprzednią wersję w historii.</p>
    <SubmitButton>Zapisz ocenę z uzasadnieniem</SubmitButton>
  </form>;
}
