'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { errorLabel, groupLabel, statusLabel, type BulkErrorReason, type BulkGroup, type BulkPhase } from '../../../../../../../lib/cv-bulk';
import { bulkProgress } from '../actions';

export type BatchItem = {
  id: string; position: number; file_name: string | null; phase: BulkPhase; error_reason: BulkErrorReason | null; ocr_used: boolean;
  application_id: string | null; candidate_name: string | null; has_phone: boolean | null; group_key: BulkGroup | null;
  raw_score: number | null; duplicate_of_application: string | null;
};
export type BatchStatus = {
  batch: { id: string; recruitment_id: string; status: 'uploading' | 'processing' | 'completed'; declared_files: number; reserved_slots: number; completed_at: string | null };
  items: BatchItem[];
};

export function BatchProgress({ companyId, recruitmentId, batchId, initial, billingHref }:
  { companyId: string; recruitmentId: string; batchId: string; initial: BatchStatus; billingHref: string }) {
  const [data, setData] = useState(initial);
  const finished = data.batch.status === 'completed';
  useEffect(() => {
    if (finished) return;
    let stop = false;
    const tick = async () => {
      const next = await bulkProgress(companyId, batchId).catch(() => null) as BatchStatus | null;
      if (!stop && next) setData(next);
      if (!stop) setTimeout(tick, 4000);
    };
    const timer = setTimeout(tick, 1500);
    return () => { stop = true; clearTimeout(timer); };
  }, [companyId, batchId, finished]);

  const items = data.items;
  const count = (phase: BulkPhase) => items.filter(i => i.phase === phase).length;
  const done = count('done'), errors = count('error');
  const settled = done + errors;
  const overLimit = items.filter(i => i.error_reason === 'over_limit').length;
  const app = (id: string) => `/dashboard/${companyId}/recruitments/${recruitmentId}/applications/${id}/screening`;
  return <section aria-live="polite">
    <p><strong>{finished ? 'Paczka zakończona.' : 'Przetwarzanie w toku — możesz zamknąć tę stronę, wynik pojawi się w rekrutacji.'}</strong></p>
    <progress max={items.length || 1} value={settled} aria-label="Postęp paczki" /> <span>{settled} z {items.length}</span>
    <p>Gotowe: {done} · W toku: {count('analyzing')} · Oczekuje: {count('queued') + count('awaiting_upload')} · Błędy: {errors}</p>
    {overLimit > 0 && <p role="status">{overLimit} plików nie przetworzono, bo pakiet się wyczerpał. <Link href={billingHref}>Dokup kolejną piątkę CV</Link> i wgraj je w nowej paczce.</p>}
    {finished && <p><Link href={`/dashboard/${companyId}/recruitments/${recruitmentId}#preselekcja`}>Zobacz grupy kandydatów w rekrutacji</Link></p>}
    <table>
      <thead><tr><th>#</th><th>Plik</th><th>Status</th><th>Kandydat</th><th>Grupa (propozycja)</th></tr></thead>
      <tbody>{items.map(i => <tr key={i.id}>
        <td>{i.position}</td>
        <td>{i.file_name ?? '—'}{i.ocr_used ? ' (OCR)' : ''}</td>
        <td>{statusLabel[i.phase]}{i.error_reason ? `: ${errorLabel[i.error_reason]}` : ''}
          {i.duplicate_of_application && <> — <Link href={app(i.duplicate_of_application)}>istniejące zgłoszenie</Link></>}</td>
        <td>{i.application_id && i.candidate_name ? <Link href={app(i.application_id)}>{i.candidate_name}</Link> : '—'}
          {i.application_id && i.has_phone === false && <strong> · brak telefonu (voicebot nie zadzwoni)</strong>}</td>
        <td>{i.group_key ? `${groupLabel[i.group_key]}${i.raw_score !== null ? ` (${Math.round(Number(i.raw_score))} pkt)` : ''}` : '—'}</td>
      </tr>)}</tbody>
    </table>
  </section>;
}
