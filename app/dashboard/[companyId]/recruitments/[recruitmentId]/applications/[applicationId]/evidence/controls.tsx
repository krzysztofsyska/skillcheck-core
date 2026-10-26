'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { evidenceVerdictLabels, type EvidenceQuote } from '../../../../../../../../lib/evidence-matrix';

type Route = { companyId: string; recruitmentId: string; applicationId: string };
export function EvidenceRun({ route, canRun, active, disabledReason }: { route: Route; canRun: boolean; active: boolean; disabledReason?: string }) {
  const router = useRouter();
  const [pending,setPending] = useState(false);
  const [error,setError] = useState('');
  useEffect(() => {
    if (!active && !pending) return;
    const timer = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(timer);
  }, [active,pending,router]);
  async function run() {
    setPending(true); setError(''); router.refresh();
    try {
      const result = await fetch('/api/evidence',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(route)});
      const data = await result.json();
      if (!result.ok) setError(data.error || 'Nie udało się przygotować zestawienia.');
    } catch { setError('Nie udało się połączyć z serwerem. Możesz ponowić.'); }
    finally { setPending(false); router.refresh(); }
  }
  return <div aria-live="polite">
    <button type="button" disabled={!canRun || pending || active} onClick={run}>
      {pending || active ? 'Zestawianie dowodów…' : 'Zestaw dowody'}
    </button>
    {disabledReason && <p role="status">{disabledReason}</p>}
    {error && <p role="alert">{error}</p>}
    {(active || pending) && <p role="status">Trwa analiza. Stan odświeży się automatycznie.</p>}
  </div>;
}

export type MatrixItem = {
  id: string; requirement_key: string; verdict: keyof typeof evidenceVerdictLabels;
  evidence_quotes: EvidenceQuote[]; missing_info: string; suggested_question: string;
  human_status: 'unreviewed' | 'accepted' | 'rejected' | 'edited'; human_note: string;
  human_verdict: keyof typeof evidenceVerdictLabels | null;
  human_missing_info: string | null; human_question: string | null;
};

export function EvidenceRow({ item, analysisId, companyId, canEdit }: {
  item: MatrixItem; analysisId: string; companyId: string; canEdit: boolean;
}) {
  const router = useRouter();
  const [status,setStatus] = useState(item.human_status);
  const [verdict,setVerdict] = useState(item.human_verdict || item.verdict);
  const [missing,setMissing] = useState(item.human_missing_info ?? item.missing_info);
  const [question,setQuestion] = useState(item.human_question ?? item.suggested_question);
  const [note,setNote] = useState(item.human_note);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  async function save() {
    setBusy(true);setError('');
    try {
      const response = await fetch('/api/evidence',{method:'PATCH',headers:{'content-type':'application/json'},
        body:JSON.stringify({organization_id:companyId,analysis_id:analysisId,item_id:item.id,
          human_status:status,human_note:note,human_verdict:status === 'edited'?verdict:null,
          human_missing_info:status === 'edited'?missing:null,human_question:status === 'edited'?question:null})});
      const data = await response.json();
      if(!response.ok) setError(data.error || 'Nie zapisano weryfikacji.');
      else router.refresh();
    } catch {setError('Brak połączenia. Ponów zapis.');}
    finally {setBusy(false);}
  }
  return <section>
    <label>Weryfikacja człowieka
      <select aria-label="Status weryfikacji" value={status} disabled={!canEdit||busy}
        onChange={event=>setStatus(event.target.value as MatrixItem['human_status'])}>
        <option value="unreviewed">Niezweryfikowane</option>
        <option value="accepted">Zaakceptuj</option>
        <option value="rejected">Odrzuć zestawienie</option>
        <option value="edited">Edytuj</option>
      </select>
    </label>
    {status === 'edited' && <>
      <label>Werdykt po korekcie
        <select value={verdict} onChange={e=>setVerdict(e.target.value as MatrixItem['verdict'])} disabled={!canEdit||busy}>
          {Object.entries(evidenceVerdictLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}
        </select>
      </label>
      <label>Brakujące informacje <textarea value={missing} maxLength={2000} onChange={e=>setMissing(e.target.value)} disabled={!canEdit||busy} /></label>
      <label>Sugerowane pytanie <textarea value={question} maxLength={2000} onChange={e=>setQuestion(e.target.value)} disabled={!canEdit||busy} /></label>
    </>}
    <label>Notatka <textarea value={note} maxLength={3000} onChange={e=>setNote(e.target.value)} disabled={!canEdit||busy} /></label>
    {canEdit && <button type="button" onClick={save} disabled={busy}>{busy?'Zapisuję…':'Zapisz weryfikację'}</button>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
