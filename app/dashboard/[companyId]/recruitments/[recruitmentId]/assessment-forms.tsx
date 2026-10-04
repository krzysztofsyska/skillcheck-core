'use client';
import { useActionState, useState } from 'react';
import { SubmitButton } from '../../../../components/submit-button';
import { assessmentStatuses } from '../../../../../lib/assessment-fields';
import type { CandidateAssessment } from '../../../../../lib/supabase/database.types';
import type { EditorState } from '../../../../../lib/position-fields';
import { addAssessmentStage, saveAssessmentProgress } from './assessment-actions';

function Feedback({ state }: { state: EditorState }) {
  return <>{state.error && <p role="alert">{state.error}</p>}{state.saved && <p role="status">Zapisano.</p>}</>;
}

export function StageForm({ companyId, recruitmentId, nextSequence }: { companyId: string; recruitmentId: string; nextSequence: number }) {
  const [values, setValues] = useState({ name: '', description: '', sequence: String(nextSequence) });
  const [state, action] = useActionState(async (previous: EditorState, form: FormData) => {
    const result = await addAssessmentStage(companyId, recruitmentId, previous, form);
    if (result.saved) setValues({ name: '', description: '', sequence: String(Number(form.get('sequence')) + 1) });
    return result;
  }, {});
  return <form action={action}><Feedback state={state}/>
    <label>Nazwa etapu<input name="name" required maxLength={200} value={values.name} onChange={e => setValues({ ...values, name: e.target.value })}/></label>
    <label>Kolejność<input name="sequence" type="number" min={1} max={999999} step={1} required value={values.sequence} onChange={e => setValues({ ...values, sequence: e.target.value })}/></label>
    <label>Co sprawdzamy i jak?<textarea name="description" rows={5} maxLength={10000} value={values.description} onChange={e => setValues({ ...values, description: e.target.value })}/></label>
    <SubmitButton>Dodaj etap</SubmitButton>
  </form>;
}

export function AssessmentForm({ companyId, recruitmentId, applicationId, stageId, assessment }: {
  companyId: string; recruitmentId: string; applicationId: string; stageId: string; assessment?: CandidateAssessment;
}) {
  const [status, setStatus] = useState<string>(assessment?.status ?? 'pending');
  const [notes, setNotes] = useState(assessment?.notes ?? '');
  const [state, action] = useActionState(saveAssessmentProgress.bind(null, companyId, recruitmentId, applicationId, stageId, assessment?.updated_at ?? null), {});
  return <form action={action}><Feedback state={state}/>
    <label>Status etapu<select name="status" value={status} onChange={e => setStatus(e.target.value)}>{assessmentStatuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label>Notatka rekrutera<textarea name="notes" value={notes} onChange={e => setNotes(e.target.value)} rows={6} maxLength={10000} required={status === 'completed' || status === 'skipped'}/></label>
    <p>Zapisz wykonane zadanie, zaobserwowane zachowania i konkretne przykłady. Przy pominięciu podaj powód.</p>
    <SubmitButton>Zapisz postęp etapu</SubmitButton>
  </form>;
}
