import Link from 'next/link';
import type { Metadata } from 'next';
import { companyAccess } from '../../../../lib/company-access';
import {
  companyExportHistoryOwnerOnlyMessage, companyExportHistoryView, loadCompanyReportExportHistory, parseCompanyExportCursor,
} from '../../../../lib/company-report-export-history';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Historia eksportów raportów', robots: { index: false, follow: false } };

/** SC-015-D3: kto i kiedy pobrał raporty kandydatów w całej firmie. Tylko właściciel (baza sprawdza ponownie). */
export default async function CompanyReportExports({ params, searchParams }: {
  params: Promise<{ companyId: string }>;
  searchParams: Promise<{ before?: string | string[]; id?: string | string[] }>;
}) {
  const { companyId } = await params;
  const { client, company, user } = await companyAccess(companyId);
  const back = <nav><Link href={`/dashboard/${companyId}`}>← Panel firmy</Link></nav>;
  if (user.id !== company.owner_id) {
    return <main className="workspace"><section>{back}<h1>Historia eksportów raportów</h1>
      <p className="notice">{companyExportHistoryOwnerOnlyMessage}</p></section></main>;
  }
  const { before, id } = await searchParams;
  const cursor = parseCompanyExportCursor(before, id);
  const history = await loadCompanyReportExportHistory(client, companyId, cursor);
  // Nazwy rekrutacji tylko do podpisów odnośników; brak nazwy nie ukrywa wpisu.
  const recruitmentIds = history.ok ? Array.from(new Set(history.entries.map(entry => entry.recruitmentId))) : [];
  const names = new Map<string, string>();
  if (recruitmentIds.length) {
    const { data } = await client.from('recruitments').select('id,name').eq('company_id', companyId).in('id', recruitmentIds);
    for (const row of data ?? []) names.set(row.id, row.name);
  }
  const view = companyExportHistoryView(companyId, history, names);

  return <main className="workspace"><section>{back}
    <p className="eyebrow">RAPORTY KANDYDATÓW</p>
    <h1>Historia eksportów raportów — {company.name}</h1>
    <p className="lead">Każde pobranie raportu kandydata (plik CSV) jest zapisywane: kto i kiedy je pobrał.
      Tu widzisz wszystkie pobrania w firmie, od najnowszych. Nie pokazujemy tu danych kandydatów —
      szczegóły zobaczysz po otwarciu raportu.</p>
    {cursor && <p><Link href={`/dashboard/${companyId}/eksporty`}>← Najnowsze pobrania</Link></p>}
    {view.kind === 'list'
      ? <><ul>{view.items.map(item => <li key={item.key}>{item.when} · {item.who} ·{' '}
          <Link href={item.recruitmentHref}>{item.recruitmentName}</Link> ·{' '}
          <Link href={item.reportHref}>Raport kandydata</Link></li>)}</ul>
        {view.nextHref && <p><Link href={view.nextHref}>Starsze pobrania →</Link></p>}</>
      : <p role="status">{view.message}</p>}
  </section></main>;
}
