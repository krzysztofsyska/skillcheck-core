import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { createClient } from '../../../../../../lib/supabase/server';
import { loadScreeningReport } from '../../../../../../lib/screening-report-source';
import { ScreeningReportError, type ScreeningReport } from '../../../../../../lib/screening-report';
import { ScreeningReportView } from './report-view';
import { PrintReportButton } from './print-button';
import styles from './report.module.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Raport preselekcji | SkillCheck', robots: { index: false, follow: false }, referrer: 'no-referrer' };

export default async function ReportPage({ params, searchParams }: {
  params: Promise<{ companyId: string; recruitmentId: string }>;
  searchParams: Promise<{ size?: string | string[] }>;
}) {
  const { companyId, recruitmentId } = await params;
  const { size } = await searchParams;
  let report: ScreeningReport;
  const path = `/dashboard/${companyId}/recruitments/${recruitmentId}`;
  try { report = await loadScreeningReport(await createClient(), companyId, recruitmentId, size); }
  catch (error) {
    if (error instanceof ScreeningReportError && error.code === 'unauthenticated') redirect('/login');
    if (error instanceof ScreeningReportError && error.code === 'not_found') notFound();
    const safe = error instanceof ScreeningReportError ? error : new ScreeningReportError('failed');
    return <main className="workspace"><section><Link href={path}>← Rekrutacja</Link><h1>Raport preselekcji</h1>
      <p role="status" className="notice">{safe.message}</p><Link href={`${path}/report`}>Odśwież raport</Link></section></main>;
  }
  return <main className={`workspace ${styles.report}`}><section>
    <nav className={styles.controls} aria-label="Działania raportu">
      <Link href={path}>← Rekrutacja</Link>
      <form method="get"><label htmlFor="report-size">Wielkość sugestii </label>
        <select id="report-size" name="size" defaultValue={report.targetSize}>{[5, 6, 7, 8, 9, 10].map(n => <option key={n}>{n}</option>)}</select>
        <button type="submit">Pokaż</button></form>
      <a className="button" href={`${path}/report/export?size=${report.targetSize}`}>Pobierz CSV</a>
      <PrintReportButton />
      <p>Eksport ponownie sprawdza dane. Plik może zawierać nowszy stan niż ten widok.</p>
    </nav>
    <ScreeningReportView report={report} basePath={path} />
  </section></main>;
}
