'use client';

import Link from 'next/link';
import { useActionState, useRef } from 'react';
import { groupLabel, groupStateNotice, type BulkGroup } from '../../../../../../lib/cv-bulk';
import { SubmitButton } from '../../../../../components/submit-button';
import { movePreselectionGroup } from './actions';

export type GroupRow = {
  application_id: string; candidate_name: string; has_phone: boolean; group_key: BulkGroup; source: 'auto' | 'manual';
  raw_score: number | null; coverage: number | null; updated_at: string;
  /** The saved score no longer matches the candidate's current analysis (CV, position or re-analysis). */
  stale: boolean;
  /** Current analysis without human review: not outdated, but the score is not shown yet. */
  unreviewed: boolean;
};

function MoveForm({ companyId, recruitmentId, row }: { companyId: string; recruitmentId: string; row: GroupRow }) {
  // React clears uncontrolled fields after every form action, including a validation error.
  // Keep what was typed after a failed save; let the reset happen after a successful one.
  const saved = useRef(false);
  const move = movePreselectionGroup.bind(null, companyId, recruitmentId, row.application_id, row.updated_at);
  const [state, action] = useActionState(async (previous: Awaited<ReturnType<typeof move>>, form: FormData) => {
    const next = await move(previous, form);
    saved.current = !next.error;
    return next;
  }, {});
  return <details><summary>Przenieś</summary><form action={action} onReset={event => { if (!saved.current) event.preventDefault(); }}>
    {state.error && <p role="alert">{state.error}</p>}
    <label>Nowa grupa<select name="group" defaultValue={row.group_key}>
      {(Object.keys(groupLabel) as BulkGroup[]).map(g => <option key={g} value={g}>{groupLabel[g]}</option>)}</select></label>
    <label>Uzasadnienie (opcjonalnie)<input name="note" maxLength={500} /></label>
    <SubmitButton>Zapisz zmianę grupy</SubmitButton>
  </form></details>;
}

export function PreselectionGroups({ companyId, recruitmentId, rows, canEdit }: { companyId: string; recruitmentId: string; rows: GroupRow[]; canEdit: boolean }) {
  if (!rows.length) return <p>Brak wyników automatycznej preselekcji. Wgraj paczkę CV, aby system przygotował grupy.</p>;
  return <>
    <p>Grupy to propozycja systemu na podstawie analizy CV względem kryteriów stanowiska (niezatwierdzonej jeszcze przez człowieka).
      Nie zmieniają statusu kandydata. Każdą zmianę grupy zapisujemy z autorem i czasem.</p>
    {(Object.keys(groupLabel) as BulkGroup[]).map(group => {
      const list = rows.filter(r => r.group_key === group);
      return <section key={group} aria-label={groupLabel[group]}>
        <h3>{groupLabel[group]} ({list.length})</h3>
        {list.length ? <ol>{list.map(r => <li key={r.application_id}>
          <Link href={`/dashboard/${companyId}/recruitments/${recruitmentId}/applications/${r.application_id}/screening`}>{r.candidate_name}</Link>
          {r.stale || r.unreviewed ? <strong> · {groupStateNotice[r.stale ? 'stale' : 'unreviewed']}</strong> : <>
            {r.raw_score !== null && <> · {Math.round(Number(r.raw_score))} pkt</>}
            {r.coverage !== null && <> · pokrycie kryteriów {Math.round(Number(r.coverage) * 100)}%</>}
          </>}
          {r.source === 'manual' && <> · przeniesiony ręcznie</>}
          {!r.has_phone && <span> · brak telefonu w CV</span>}
          {canEdit && <MoveForm companyId={companyId} recruitmentId={recruitmentId} row={r} />}
        </li>)}</ol> : <p>Brak kandydatów.</p>}
      </section>;
    })}
  </>;
}
