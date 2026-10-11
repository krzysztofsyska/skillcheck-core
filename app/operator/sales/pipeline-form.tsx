'use client';
import { useActionState, useState } from 'react';
import { savePipeline } from './actions';
import { salesStages } from '../../../lib/sales-pipeline';
import type { SalesPipelineRow } from '../../../lib/supabase/database.types';
import styles from './sales.module.css';
export function PipelineForm({ lead, companies }: { lead: SalesPipelineRow; companies: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(savePipeline, { message: '', done: false });
  const [stage, setStage] = useState(lead.stage);
  const [note, setNote] = useState(lead.note);
  const [date, setDate] = useState(lead.next_contact_on || '');
  const [company, setCompany] = useState(lead.company_id || '');
  const terminal = stage === 'won' || stage === 'lost';
  const options = lead.company_id && !companies.some(c => c.id === lead.company_id)
    ? [{ id: lead.company_id, name: lead.linked_company_name || 'Powiązana firma' }, ...companies] : companies;
  return <form action={action} onReset={event => event.preventDefault()} className={styles.form}>
    <input type="hidden" name="lead_id" value={lead.id} /><input type="hidden" name="version" value={lead.version} />
    <label>Etap sprzedaży<select name="stage" value={stage} onChange={e => setStage(e.target.value as typeof stage)}>
      {Object.entries(salesStages).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>
    <label>Notatka dla zespołu<textarea name="note" value={note} onChange={e => setNote(e.target.value)} maxLength={2000} rows={5} aria-describedby="note-help" /></label>
    <p id="note-help" className={styles.hint}>Do 2000 znaków. Zapisuj ustalenia handlowe; pomiń dane kandydatów i informacje wrażliwe. Poprzednie wersje są widoczne w historii.</p>
    <label>Data następnego kontaktu<input type="date" name="next_contact" min="2000-01-01" max="2100-12-31" value={date} onChange={e => setDate(e.target.value)} readOnly={terminal} /></label>
    <label>Powiązana firma<select name="company_id" value={company} onChange={e => setCompany(e.target.value)}>
      <option value="">Bez powiązania</option>{options.map(c => <option key={c.id} value={c.id}>{c.name} · {c.id}</option>)}
    </select></label>
    {terminal && <label className={styles.confirm}><input name="confirm_close" value="yes" type="checkbox" required />
      {stage === 'lost' ? 'Kończę rozmowę bez umowy. Dane zostaną usunięte po 6 miesiącach.' : 'Potwierdzam wygraną i właściwą firmę. Ten zapis nie tworzy umowy ani płatności.'} Zakończenie blokuje dalszą edycję.</label>}
    {terminal && <p className={styles.hint}>Przy zakończeniu termin następnego kontaktu zostanie wyczyszczony.</p>}
    <button type="submit" disabled={pending}>{pending ? 'Zapisywanie…' : 'Zapisz zmiany'}</button>
    <p role="status" aria-live="polite">{state.message}</p>
  </form>;
}
