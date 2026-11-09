'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { errorLabel, groupLabel, statusLabel, type BulkErrorReason, type BulkGroup, type BulkPhase } from '../../../../../../../lib/cv-bulk';
import { createProgressPoller } from '../../../../../../../lib/cv-bulk-poll';
import { bulkProgress } from '../actions';

export type BatchItem = {
  id: string; position: number; file_name: string | null; phase: BulkPhase; error_reason: BulkErrorReason | null; ocr_used: boolean;
  application_id: string | null; candidate_name: string | null; has_phone: boolean | null; group_key: BulkGroup | null;
  raw_score: number | null; duplicate_of_application: string | null;
  /** Server-computed: the group belongs to the analysis the ranking uses now. Missing means outdated. */
  group_analysis_id?: string | null; group_current?: boolean;
};
export type BatchStatus = {
  batch: { id: string; recruitment_id: string; status: 'uploading' | 'processing' | 'completed'; declared_files: number; reserved_slots: number; completed_at: string | null };
  items: BatchItem[];
};

type Props = { companyId: string; recruitmentId: string; batchId: string; initial: BatchStatus; billingHref: string };

/** Keyed by ids: a different batch/recruitment remounts, so no state or timer of the previous one survives. */
export function BatchProgress(props: Props) {
  return <BatchProgressInner key={`${props.companyId}:${props.recruitmentId}:${props.batchId}`} {...props} />;
}

function BatchProgressInner({ companyId, recruitmentId, batchId, initial, billingHref }: Props) {
  const [data, setData] = useState(initial);
  const [stale, setStale] = useState(false);
  const pollerRef = useRef<ReturnType<typeof createProgressPoller<BatchStatus>> | null>(null);
  useEffect(() => {
    if (initial.batch.status === 'completed') return;
    const poller = createProgressPoller<BatchStatus>({
      read: () => bulkProgress(companyId, recruitmentId, batchId) as Promise<BatchStatus | null>,
      onData: setData,
      onStale: setStale,
      isCompleted: d => d.batch.status === 'completed',
    });
    pollerRef.current = poller;
    poller.start();
    return () => { poller.stop(); pollerRef.current = null; };
  }, [companyId, recruitmentId, batchId]); // eslint-disable-line react-hooks/exhaustive-deps
  const finished = data.batch.status === 'completed';

  const items = data.items;
  const count = (phase: BulkPhase) => items.filter(i => i.phase === phase).length;
  const done = count('done'), errors = count('error');
  const settled = done + errors;
  const overLimit = items.filter(i => i.error_reason === 'over_limit').length;
  const app = (id: string) => `/dashboard/${companyId}/recruitments/${recruitmentId}/applications/${id}/screening`;
  return <section aria-live="polite">
    <p><strong>{finished ? 'Paczka zakończona.' : 'Przetwarzanie w toku — nie zamykaj tej strony do końca przetwarzania.'}</strong></p>
    {stale && !finished && <p role="status">Nie udało się odświeżyć postępu. Pokazane dane mogą być nieaktualne. <button type="button" onClick={() => pollerRef.current?.retry()}>Spróbuj ponownie</button></p>}
    <progress max={items.length || 1} value={settled} aria-label="Postęp paczki" /> <span>{settled} z {items.length}</span>
    <p>Gotowe: {done} · W toku: {count('analyzing')} · Oczekuje: {count('queued') + count('awaiting_upload')} · Błędy: {errors}</p>
    {overLimit > 0 && <p role="status">{overLimit} plików nie przetworzono, bo pakiet się wyczerpał. <Link href={billingHref}>Zamów pakiet PRESELEKCJA</Link> i wgraj je w nowej paczce.</p>}
    {finished && <p><Link href={`/dashboard/${companyId}/recruitments/${recruitmentId}#preselekcja`}>Zobacz grupy kandydatów w rekrutacji</Link></p>}
    <table>
      <thead><tr><th>#</th><th>Plik</th><th>Status</th><th>Kandydat</th><th>Grupa (propozycja)</th></tr></thead>
      <tbody>{items.map(i => <tr key={i.id}>
        <td>{i.position}</td>
        <td>{i.file_name ?? '—'}{i.ocr_used ? ' (OCR)' : ''}</td>
        <td>{statusLabel[i.phase]}{i.error_reason ? `: ${errorLabel[i.error_reason]}` : ''}
          {i.duplicate_of_application && <> — <Link href={app(i.duplicate_of_application)}>istniejące zgłoszenie</Link></>}</td>
        <td>{i.application_id && i.candidate_name ? <Link href={app(i.application_id)}>{i.candidate_name}</Link> : '—'}
          {i.application_id && i.has_phone === false && <span> · brak telefonu w CV</span>}</td>
        <td>{!i.group_key ? '—' : i.group_current
          ? `${groupLabel[i.group_key]}${i.raw_score !== null ? ` (${Math.round(Number(i.raw_score))} pkt)` : ''}`
          : <>{groupLabel[i.group_key]}<br /><strong>Wynik nieaktualny — wymaga ponownej analizy</strong></>}</td>
      </tr>)}</tbody>
    </table>
  </section>;
}
