'use client';
import { useActionState } from 'react';
import { saveFollowup, type FollowupFormState } from './actions';
import { followupPurposes, observationFields, outcomeLabels, probationLabels, retainedLabels, checkpoints } from '../../../../../../../../lib/process-followup';
type Props = { companyId: string; recruitmentId: string; applicationId: string; caseId?: string; operation: 'create' | 'record' | 'grant'; completed?: number[]; members?: { user_id: string; label: string }[] };
export function FollowupForm({ companyId, recruitmentId, applicationId, caseId, operation, completed = [], members = [] }: Props) {
  const [state, action, pending] = useActionState(saveFollowup.bind(null, companyId, recruitmentId, applicationId), {} as FollowupFormState);
  const select = (name: string, label: string, values: Record<string,string>) => <label>{label}<select name={name} required defaultValue="not_measured">{Object.entries(values).map(([k,v]) => <option key={k} value={k}>{v}</option>)}</select></label>;
  return <form action={action}>
    <input type="hidden" name="operation" value={operation}/>{caseId && <input type="hidden" name="case_id" value={caseId}/>}
    {operation === 'create' && <>
      {select('purpose','Odrębny cel oceny',followupPurposes)}
      <label>Data rozpoczęcia pracy lub okresu oceny<input type="date" name="start_date" required/></label>
      <label>Kryteria i oczekiwane zadania<textarea name="criteria" required rows={4}/></label>
      <label>Wynik początkowy i dowody z poprzednich etapów<textarea name="initial_result" required rows={4}/></label>
      <p>Zapis tworzy niezmienny punkt odniesienia. Zapisz konkretne kryteria, wynik i źródła dowodów; nie kopiuj CV ani danych kontaktowych. Przy braku wyniku opisz ten brak.</p>
    </>}
    {operation === 'record' && <>
      <label>Okres obserwacji<select name="checkpoint" required>{checkpoints.filter(n => !completed.includes(n)).map(n => <option key={n} value={n}>{n} dni</option>)}</select></label>
      {Object.entries(observationFields).map(([k,v]) => <label key={k}>{v}<textarea name={k} required rows={3}/></label>)}
      {select('outcome','Wykonanie kryteriów',outcomeLabels)}
      {select('probation','Faktyczny wynik okresu próbnego',probationLabels)}
      {select('retained','Faktyczny stan zatrudnienia',retainedLabels)}
      <p>Wpisz „brak pomiaru” z uzasadnieniem, gdy nie masz dowodów. Zapis nie zmienia decyzji kadrowej. Każdy okres można zapisać tylko raz, po jego upływie.</p>
    </>}
    {operation === 'grant' && <>
      <label>Rekruter<select name="target_user" required>{members.map(m => <option key={m.user_id} value={m.user_id}>{m.label}</option>)}</select></label>
      <label>Dostęp do tego celu<select name="allowed"><option value="true">Nadaj dostęp</option><option value="false">Odbierz dostęp</option></select></label>
      <p>Dostęp obejmuje odczyt i dopisywanie obserwacji tylko w tym celu oceny. Uprawnienia rekrutacyjne nie nadają go automatycznie.</p>
    </>}
    {state.error && <p role="alert">{state.error}</p>}{state.saved && <p role="status">Zapisano.</p>}
    <button disabled={pending || (operation === 'record' && completed.length >= 3) || (operation === 'grant' && !members.length)}>{pending ? 'Zapisywanie…' : operation === 'create' ? 'Utwórz cel oceny' : operation === 'grant' ? 'Zmień dostęp' : 'Zapisz obserwację'}</button>
  </form>;
}
