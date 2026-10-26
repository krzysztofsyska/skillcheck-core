'use client';
import { useActionState, useEffect, useRef, useState } from 'react';
import { SubmitButton } from '../../../../components/submit-button';
import { assessmentStatuses } from '../../../../../lib/assessment-fields';
import { humanDecisions } from '../../../../../lib/interview-decision';
import type { CandidateAssessment } from '../../../../../lib/supabase/database.types';
import type { EditorState } from '../../../../../lib/position-fields';
import { addAssessmentStage, saveAssessmentProgress } from './assessment-actions';
import { autosaveInterviewNote, moveCandidateStage, saveHumanDecision,
  renameRecruitmentStage, reorderRecruitmentStage, removeUnusedRecruitmentStage } from './interview-actions';

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

export function StageControls({ companyId, recruitmentId, stageId, name, first, last }: {
  companyId: string; recruitmentId: string; stageId: string; name: string; first: boolean; last: boolean;
}) {
  const [renameState, rename] = useActionState(renameRecruitmentStage.bind(null, companyId, recruitmentId, stageId), {});
  const [upState, up] = useActionState(reorderRecruitmentStage.bind(null, companyId, recruitmentId, stageId, -1), {});
  const [downState, down] = useActionState(reorderRecruitmentStage.bind(null, companyId, recruitmentId, stageId, 1), {});
  const [deleteState, remove] = useActionState(removeUnusedRecruitmentStage.bind(null, companyId, recruitmentId, stageId), {});
  return <details><summary>Zmień etap</summary>
    <form action={rename}><Feedback state={renameState}/><label>Nowa nazwa etapu
      <input key={name} name="name" defaultValue={name} required maxLength={200}/></label><SubmitButton>Zapisz nazwę</SubmitButton></form>
    <form action={up}><Feedback state={upState}/><button type="submit" disabled={first}>Przesuń wyżej</button></form>
    <form action={down}><Feedback state={downState}/><button type="submit" disabled={last}>Przesuń niżej</button></form>
    <form action={remove} onSubmit={e => { if (!window.confirm('Usunąć wyłącznie nieużywany etap?')) e.preventDefault(); }}>
      <Feedback state={deleteState}/><button type="submit">Usuń nieużywany etap</button>
    </form>
  </details>;
}

export function CandidateStageForm({ companyId, recruitmentId, applicationId, currentStageId, stages }: {
  companyId: string; recruitmentId: string; applicationId: string; currentStageId: string | null;
  stages: { id: string; name: string }[];
}) {
  const [state, action] = useActionState(moveCandidateStage.bind(null, companyId, recruitmentId, applicationId), {});
  return <form action={action}><Feedback state={state}/>
    <label>Aktualny etap kandydata
      <select name="stageId" key={currentStageId ?? 'unassigned'} defaultValue={currentStageId ?? ''}>
        <option value="">Nieprzypisany</option>
        {stages.map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
      </select></label>
    <SubmitButton>Przesuń kandydata ręcznie</SubmitButton>
  </form>;
}

export function HumanDecisionForm({ companyId, recruitmentId, applicationId }: {
  companyId: string; recruitmentId: string; applicationId: string;
}) {
  const [state, action] = useActionState(saveHumanDecision.bind(null, companyId, recruitmentId, applicationId), {});
  return <form action={action}><Feedback state={state}/>
    <label>Decyzja człowieka
      <select name="decision" required defaultValue="">
        <option value="" disabled>Wybierz decyzję</option>
        {humanDecisions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
    <label>Uzasadnienie (obowiązkowe)
      <textarea name="reason" required minLength={10} maxLength={5000} rows={4} placeholder="Konkretny powód podjętej decyzji — minimum 10 znaków."/></label>
    <SubmitButton>Zapisz decyzję człowieka</SubmitButton>
    <p>System nie proponuje, nie wybiera i nie zapisuje decyzji automatycznie.</p>
  </form>;
}

export function AssessmentForm({ companyId, recruitmentId, applicationId, stageId, assessment }: {
  companyId: string; recruitmentId: string; applicationId: string; stageId: string; assessment?: CandidateAssessment;
}) {
  const [status, setStatus] = useState<string>(assessment?.status ?? 'pending');
  const [notes, setNotes] = useState(assessment?.notes ?? '');
  const [updatedAt, setUpdatedAt] = useState<string | null>(assessment?.updated_at ?? null);
  const lastSaved = useRef(assessment?.notes ?? '');
  const versionRef = useRef<string | null>(assessment?.updated_at ?? null);
  const latest = useRef(notes);
  const saving = useRef(false);
  const [noteState, setNoteState] = useState('Zapis automatyczny po zakończeniu pisania.');
  latest.current = notes;

  useEffect(() => {
    if (notes === lastSaved.current) return;
    let cancelled = false;
    const persist = async () => {
      if (saving.current) return;
      saving.current = true;
      const sent = latest.current;
      setNoteState('Zapisywanie notatki…');
      const result = await autosaveInterviewNote(companyId, recruitmentId, applicationId, stageId, sent, versionRef.current);
      saving.current = false;
      if (cancelled) return;
      if (result.saved && result.updatedAt) {
        lastSaved.current = sent;
        versionRef.current = result.updatedAt;
        setUpdatedAt(result.updatedAt);
        setNoteState('Notatka zapisana.');
        if (latest.current !== sent) setNotes(current => current); // next edit schedules a save
      } else {
        setNoteState(result.error ?? 'Nie zapisano notatki.');
      }
    };
    const timer = setTimeout(() => { void persist(); }, 900);
    return () => { clearTimeout(timer); cancelled = true; };
  }, [notes, companyId, recruitmentId, applicationId, stageId, updatedAt]);

  const [state, action] = useActionState(saveAssessmentProgress.bind(null, companyId, recruitmentId, applicationId, stageId), {});
  return <form action={action}><Feedback state={state}/>
    <input type="hidden" name="expectedUpdatedAt" value={updatedAt ?? ''}/>
    <label>Status etapu<select name="status" value={status} onChange={e => setStatus(e.target.value)}>{assessmentStatuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label>Notatka / obserwacje z rozmowy<textarea name="notes" value={notes} onChange={e => { setNotes(e.target.value); setNoteState('Niezapisane zmiany…'); }} rows={6} maxLength={10000} required={status === 'completed' || status === 'skipped'}/></label>
    <p role="status">{noteState}</p>
    <p>Notatki zapisują się automatycznie; autor, czas i każda edycja są rejestrowane. Przy zakończeniu lub pominięciu etapu wpisz uzasadnienie.</p>
    <SubmitButton>Zapisz status etapu</SubmitButton>
  </form>;
}
