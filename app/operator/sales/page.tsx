import type { Metadata } from 'next';
import Link from 'next/link';
import { salesOperator, checkSalesError } from './access';
import { salesStages, dueFilters, isSalesStage } from '../../../lib/sales-pipeline';
import styles from './sales.module.css';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Proces sprzedaży | SkillCheck', robots: { index: false, follow: false } };
export default async function SalesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const client = await salesOperator();
  const params = await searchParams;
  const stage = typeof params.stage === 'string' && isSalesStage(params.stage) ? params.stage : 'all';
  const due = typeof params.due === 'string' && Object.hasOwn(dueFilters, params.due) ? params.due : 'all';
  const page = typeof params.page === 'string' && /^\d{1,6}$/.test(params.page) ? Math.max(1, Number(params.page)) : 1;
  const { data, error } = await client.rpc('list_sales_pipeline', { stage_filter: stage, due_filter: due, page_offset: (page - 1) * 20 });
  checkSalesError(error);
  if (!data) throw new Error('Nie udało się odczytać procesu sprzedaży.');
  const link = (p: number) => '/operator/sales?' + new URLSearchParams({ stage, due, page: String(p) });
  return <main className={styles.page}>
    <nav><Link href="/operator/leads">Zgłoszenia kontaktowe</Link><Link href="/">Strona główna</Link></nav>
    <header><p className={styles.eyebrow}>SKILLCHECK · SPRZEDAŻ</p><h1>Proces sprzedaży</h1>
      <p>Od pierwszego kontaktu do decyzji klienta. Terminy „na dziś” i „zaległe” według Europe/Warsaw.</p></header>
    <form className={styles.filters} method="get">
      <label>Etap<select name="stage" defaultValue={stage}><option value="all">Wszystkie etapy</option>{Object.entries(salesStages).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <label>Termin<select name="due" defaultValue={due}>{Object.entries(dueFilters).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <button type="submit">Pokaż</button><Link href="/operator/sales">Wyczyść filtry</Link>
    </form>
    <p>Strona {page}{data.length ? ` · ${data[0].total_count} zgłoszeń spełnia filtry` : ''}</p>
    {!data.length && <p role="status" className={styles.empty}>Brak zgłoszeń w tym widoku. Zmień filtry lub wróć do pierwszej strony.</p>}
    <ol className={styles.list}>{data.map(lead => <li key={lead.id} className={styles.card}>
      <div className={styles.cardTitle}><h2><Link href={'/operator/sales/' + lead.id}>{lead.company_name}</Link></h2><span className={styles.badge} data-stage={lead.stage}>{salesStages[lead.stage]}</span></div>
      <p>{lead.first_name} · {lead.email}</p>
      <p>Następny kontakt: <strong>{lead.next_contact_on || 'Nie ustalono'}</strong></p>
      {lead.linked_company_name && <p>Firma klienta: {lead.linked_company_name}</p>}
      <Link href={'/operator/sales/' + lead.id}>Otwórz zgłoszenie →</Link>
    </li>)}</ol>
    <nav aria-label="Strony zgłoszeń">{page > 1 && <Link href={link(page - 1)}>Poprzednia strona</Link>}{data.length > 0 && page * 20 < Number(data[0].total_count) && <Link href={link(page + 1)}>Następna strona</Link>}</nav>
    <p className={styles.hint}>Przypomnienia są widoczne w panelu. Nie wysyłają dodatkowych e-maili.</p>
  </main>;
}
