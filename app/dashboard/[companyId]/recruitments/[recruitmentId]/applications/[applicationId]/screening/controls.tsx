'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { startAnalysis, retryAnalysis, reviewAnalysis } from './actions';
import { ratingLabels, reviewLabels, screeningPath, type ScreeningFormState, type ScreeningRoute } from '../../../../../../../../lib/screening-ui';
import type { ScreeningCriterionResult, ScreeningResultReview, ScreeningCriterionReviewOverride } from '../../../../../../../../lib/supabase/database.types';

function Feedback({ state }: { state: ScreeningFormState }) {
  return <>{state.error && <p role="alert">{state.error}</p>}{state.message && <p role="status">{state.message}</p>}</>;
}

export function RefreshStatus({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    let ticks = 0;
    const timer = setInterval(() => { router.refresh(); if (++ticks >= 60) clearInterval(timer); }, 5000);
    return () => clearInterval(timer);
  }, [active, router]);
  return <button type="button" onClick={() => router.refresh()}>Odśwież stan</button>;
}

export function AnalysisControl({ route, requestId, retryId, label, disabled }: { route: ScreeningRoute; requestId: string; retryId?: string; label: string; disabled: boolean }) {
  const action = retryId ? retryAnalysis.bind(null, route, retryId) : startAnalysis.bind(null, route);
  const [state, submit, pending] = useActionState(action, {});
  return <form action={submit}>
    <input type="hidden" name="requestId" value={requestId} />
    <button disabled={disabled || pending}>{pending ? 'Wysyłanie…' : label}</button>
    <Feedback state={state} />
    {state.saved && <Link href={screeningPath(route)}>Otwórz najnowszy stan analizy</Link>}
  </form>;
}

export function ReviewControl({ route, analysisId, version, criteria, stale, review, overrides }: { route: ScreeningRoute; analysisId: string; version: number; criteria: ScreeningCriterionResult[]; stale: boolean; review?: ScreeningResultReview; overrides: ScreeningCriterionReviewOverride[] }) {
  const [state, submit, pending] = useActionState(reviewAnalysis.bind(null, route, analysisId), {});
  const [disposition, setDisposition] = useState<string>(stale ? 'needs_reanalysis' : review?.disposition ?? 'approved');
  const corrections = new Map(overrides.map(o => [o.criterion_result_id, o]));
  return <form action={submit}>
    <h2>Przegląd przez rekrutera</h2>
    <p>Zatwierdzasz analizę i dowody. Nie jest to decyzja o zatrudnieniu.</p>
    <input type="hidden" name="reviewVersion" value={version} />
    <fieldset disabled={pending}>
      <legend>Sposób zakończenia przeglądu</legend>
      <label>Wybierz działanie <select name="disposition" value={stale ? 'needs_reanalysis' : disposition} onChange={e => setDisposition(e.target.value)}>
        {Object.entries(reviewLabels).map(([value, label]) => <option key={value} value={value} disabled={stale && value !== 'needs_reanalysis'}>{label}</option>)}
      </select></label>
      {!stale && disposition === 'approved_with_changes' && <div>
        <p>Zaznacz kryteria do korekty. Cytaty kopiuj dokładnie z analizowanej wersji CV.</p>
        {criteria.map(c => { const correction = corrections.get(c.id); return <fieldset key={c.id}>
          <legend>{c.criterion_text_snapshot}</legend>
          <label><input type="checkbox" name={`change:${c.id}`} defaultChecked={!!correction} /> Zapisz korektę tego kryterium</label>
          <label>Ocena po korekcie <select name={`rating:${c.id}`} defaultValue={correction?.rating_override ?? c.rating}>{Object.entries(ratingLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          {Array.from({ length: 5 }, (_, i) => <label key={i}>Dokładny cytat {i + 1} <textarea name={`quote:${c.id}:${i}`} maxLength={2000} rows={2} defaultValue={(correction?.evidence_override ?? c.evidence)[i]?.quote ?? ''} /></label>)}
          <label>Uzasadnienie korekty <textarea name={`explanation:${c.id}`} maxLength={4000} rows={3} defaultValue={correction?.explanation_override ?? c.explanation ?? ''} /></label>
        </fieldset>; })}
      </div>}
      <label>Notatka rekrutera <textarea name="note" maxLength={10000} rows={3} defaultValue={review?.review_note ?? ''} /></label>
      <label><input type="checkbox" name="confirmed" required /> Sprawdziłem/am wyniki oraz cytaty w CV.</label>
      <button>Zapisz przegląd</button>
    </fieldset>
    <Feedback state={state} />
  </form>;
}
