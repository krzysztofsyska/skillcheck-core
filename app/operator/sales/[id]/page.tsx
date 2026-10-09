import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { salesOperator, checkSalesError } from '../access';
import { PipelineForm } from '../pipeline-form';
import { uuidPattern, salesStages } from '../../../../lib/sales-pipeline';
import { salesLeadReplyHref } from '../../../../lib/sales-lead-reply';
import styles from '../sales.module.css';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Zgłoszenie sprzedażowe | SkillCheck', robots: { index: false, follow: false } };
const dates = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Warsaw' });
export default async function SalesDetail({ params, searchParams }: { params: Promise<{id: string}>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const client = await salesOperator();
  const { id } = await params;
  if (!uuidPattern.test(id)) notFound();
  const q = await searchParams;
  const search = typeof q.company === 'string' ? q.company.trim().slice(0, 100) : '';
  const before = typeof q.before === 'string' && /^\d{1,9}$/.test(q.before) ? Number(q.before) : 2147483647;
  const { data: rows, error } = await client.rpc('list_sales_pipeline', { target_lead: id });
  checkSalesError(error);
  const lead = rows?.[0]; if (!lead) notFound();
  const [{ data: history, error: historyError }, { data: companies, error: companyError }] = await Promise.all([
    client.rpc('sales_pipeline_history', { target_lead: id, before_version: before }),
    client.rpc('find_sales_companies', { search_text: search }),
  ]);
  checkSalesError(historyError);
  checkSalesError(companyError);
  const closed = lead.stage === 'won' || lead.stage === 'lost';
  return <main className={styles.page}>
    <nav><Link href="/operator/sales">← Proces sprzedaży</Link><a href={'/operator/sales/' + id}>Odśwież zgłoszenie</a></nav>
    <header><p className={styles.eyebrow}>ZGŁOSZENIE SPRZEDAŻOWE</p><h1>{lead.company_name}</h1><span className={styles.badge} data-stage={lead.stage}>{salesStages[lead.stage]}</span></header>
    <section className={styles.card} aria-label="Dane zgłoszenia">
      <p>{lead.first_name} · {lead.email} · {lead.phone || 'Telefon: nie podano'}</p>
      <p>Otrzymano: {dates.format(new Date(lead.created_at))}</p><p className={styles.note}>{lead.needs}</p>
      <a href={salesLeadReplyHref(lead.email)}>Odpowiedz e-mailem</a>
      <p className={styles.hint}>Otwiera Twoją pocztę. Wybierz nadawcę pomoc@skillcheck.pl. Korespondencja nie zapisuje się automatycznie w panelu.</p>
    </section>
    {closed ? <section className={styles.card}><h2>Zgłoszenie zakończone</h2><p className={styles.note}>{lead.note || 'Brak notatki.'}</p>
      <p>Firma klienta: {lead.linked_company_name || 'Bez powiązania'}</p>
      {lead.stage === 'lost' && lead.closed_at && <p>Zakończono {dates.format(new Date(lead.closed_at))}. Usunięcie danych po 6 miesiącach.</p>}
    </section> : <section className={styles.card}><h2>Ustalenia i następny krok</h2>
      <details><summary>Wyszukaj firmę do powiązania</summary>
        <p className={styles.hint}>Najpierw wyszukaj firmę, potem edytuj zgłoszenie. Wyszukiwanie przeładowuje stronę. Powiązanie nie daje dostępu do rekrutacji firmy.</p>
        <form method="get" className={styles.filters}><label>Nazwa firmy<input name="company" minLength={2} maxLength={100} defaultValue={search} required /></label><button>Wyszukaj firmy</button></form>
      </details>
      {search && <p role="status">Znaleziono {companies?.length || 0} firm (maksymalnie 20). Wybierz firmę poniżej; przy podobnych nazwach sprawdź identyfikator.</p>}
      <PipelineForm key={search} lead={lead} companies={companies || []} />
    </section>}
    <section className={styles.card}><h2>Historia zmian</h2><p className={styles.hint}>Daty według Europe/Warsaw. Historia pokazuje zapisane wersje ustaleń.</p>
      {!history?.length && <p>Brak wcześniejszych zmian w tym widoku.</p>}
      <ol className={styles.list}>{history?.map(event => <li key={event.version}>
        <strong>Wersja {event.version} · {salesStages[event.stage]}</strong><p>{dates.format(new Date(event.created_at))} · Kontakt: {event.next_contact_on || 'Nie ustalono'}</p>
        <p className={styles.note}>{event.note || 'Bez notatki'}</p>{event.company_id && <p>Firma: {event.company_id}</p>}
      </li>)}</ol>
      {before !== 2147483647 && <Link href={'/operator/sales/' + id}>Najnowsze zmiany</Link>}
      {history?.length === 20 && <Link href={'/operator/sales/' + id + '?before=' + history.at(-1)!.version}>Starsze zmiany →</Link>}
    </section>
  </main>;
}
