'use client';

import { useActionState } from 'react';
import { reviewEvidenceRow } from './actions';
import type { ScreeningCriterionResult } from '../../../../../../../../lib/supabase/database.types';
import type { ScreeningRoute, ScreeningFormState } from '../../../../../../../../lib/screening-ui';
import styles from './screening.module.css';

const verdictLabels = {
  supported: 'Potwierdzone',
  partial: 'Częściowo potwierdzone',
  missing: 'Brak informacji',
  contradicted: 'Sprzeczne dane',
} as const;
const humanLabels = {
  unreviewed: 'Niezweryfikowane',
  accepted: 'Zaakceptowane',
  rejected: 'Odrzucone',
  edited: 'Skorygowane',
} as const;

function MatrixRow({ criterion, route, analysisId, documentId, documentVersion, editable }: {
  criterion: ScreeningCriterionResult; route: ScreeningRoute; analysisId: string;
  documentId: string; documentVersion: number; editable: boolean;
}) {
  const [state, submit, pending] = useActionState<ScreeningFormState, FormData>(
    reviewEvidenceRow.bind(null, route, analysisId, criterion.id), {},
  );
  const humanEdited = criterion.human_status === 'edited';
  const verdict = humanEdited ? criterion.human_verdict ?? criterion.verdict : criterion.verdict;
  const evidence = humanEdited ? criterion.human_evidence ?? criterion.evidence : criterion.evidence;
  const missingInfo = humanEdited ? criterion.human_missing_info ?? criterion.missing_info : criterion.missing_info;
  const question = humanEdited ? criterion.human_suggested_question ?? criterion.suggested_question : criterion.suggested_question;
  return <tr>
    <th scope="row"><small>{criterion.criterion_kind} · {criterion.criterion_id}</small><br />{criterion.criterion_text_snapshot}</th>
    <td><strong className={`${styles.badge} ${verdict ? styles[verdict] : ''}`}>{verdict ? verdictLabels[verdict] : 'Analiza starszego typu'}</strong></td>
    <td>{evidence.length ? evidence.map((item, index) =>
      <div key={index}><blockquote>{item.quote}</blockquote>
        <small>Źródło: CV v{documentVersion}, dokument {documentId}, pozycja {item.start}–{item.end} (UTF-16)</small>
      </div>
    ) : 'Nie znaleziono zweryfikowanych cytatów.'}</td>
    <td>{missingInfo || '—'}</td>
    <td>{question || '—'}</td>
    <td><strong>{humanLabels[criterion.human_status]}</strong>{criterion.updated_at &&
      <p><small>Aktualizacja: {new Date(criterion.updated_at).toLocaleString('pl-PL')}<br />
        Autor: {criterion.updated_by ?? '—'}</small></p>}{criterion.human_note && <p>{criterion.human_note}</p>}</td>
    <td>{editable && <form action={submit} className={styles.matrixForm}>
      <input type="hidden" name="updatedAt" value={criterion.updated_at ?? ''} />
      <label>Werdykt po edycji<select name="verdict" defaultValue={criterion.human_verdict ?? criterion.verdict ?? 'missing'}>
        {Object.entries(verdictLabels).map(([key,label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <label>Czego brakuje<textarea name="missingInfo" maxLength={4000} rows={2} defaultValue={criterion.human_missing_info ?? criterion.missing_info ?? ''} /></label>
      <label>Pytanie do rozmowy<textarea name="question" maxLength={4000} rows={2} defaultValue={criterion.human_suggested_question ?? criterion.suggested_question ?? ''} /></label>
      <label>Cytaty (jeden na linię, z zatwierdzonego CV)<textarea name="quotes" maxLength={11000} rows={3}
        defaultValue={evidence.map(item => item.quote).join('\n')} /></label>
      <label>Notatka człowieka<textarea name="note" maxLength={10000} rows={2} defaultValue={criterion.human_note ?? ''} /></label>
      <div className={styles.rowActions}>
        <button name="intent" value="accepted" disabled={pending}>Akceptuj</button>
        <button name="intent" value="rejected" disabled={pending}>Odrzuć</button>
        <button name="intent" value="edited" disabled={pending}>Edytuj</button>
        <button name="intent" value="note" disabled={pending}>Zapisz notatkę</button>
      </div>
      {state.error && <p role="alert">{state.error}</p>}
      {state.message && <p role="status">{state.message}</p>}
    </form>}</td>
  </tr>;
}

export function EvidenceMatrix({ criteria, route, analysisId, documentId, documentVersion, editable }: {
  criteria: ScreeningCriterionResult[]; route: ScreeningRoute; analysisId: string;
  documentId: string; documentVersion: number; editable: boolean;
}) {
  return <section aria-label="Macierz dowodów">
    <h2>Macierz wymagań i dowodów</h2>
    <p className="notice">Analiza AI jest zestawieniem informacji z CV, a nie oceną kandydata.
      Każdy wiersz i cytat wymaga weryfikacji przez człowieka.</p>
    <div className={styles.matrixOverflow}><table className={styles.matrix}>
      <thead><tr>
        <th scope="col">Wymaganie</th><th scope="col">Werdykt</th><th scope="col">Cytaty i źródła</th>
        <th scope="col">Brakujące informacje</th><th scope="col">Pytanie</th>
        <th scope="col">Status człowieka</th><th scope="col">Weryfikacja i korekta</th>
      </tr></thead>
      <tbody>{criteria.length ? criteria.map(row => <MatrixRow key={row.id} criterion={row}
        route={route} analysisId={analysisId} documentId={documentId} documentVersion={documentVersion}
        editable={editable} />) : <tr><td colSpan={7}>Brak wyników dla wymagań.</td></tr>}</tbody>
    </table></div>
  </section>;
}
