import Link from 'next/link';
import { notFound } from 'next/navigation';
import { companyAccess } from '../../../../../../../../lib/company-access';
import { ScreeningNotFoundError } from '../../../../../../../../lib/screening-flow';
import { isUuid, screeningPath, type ScreeningRoute } from '../../../../../../../../lib/screening-ui';
import {
  CandidateReportError, loadCandidateReport, noMissingDataDisclaimer,
  requirementStatusLabels, type CandidateReport, type CandidateRequirement,
} from '../../../../../../../../lib/candidate-report';
import { criterionKindLabels, requirementMarkLabels, requirementMarkOrder, type RequirementMark } from '../../../../../../../../lib/requirement-flags';
import styles from '../screening/screening.module.css';

export const dynamic = 'force-dynamic';
// Bez danych kandydata w tytule i w adresie strony.
export const metadata = { title: 'Raport kandydata | SkillCheck', robots: { index: false, follow: false }, referrer: 'no-referrer' };

const groupHeadings: Record<RequirementMark, string> = {
  required: 'Wymagania konieczne',
  unmarked: 'Wymagania nieoznaczone',
  additional: 'Wymagania dodatkowe',
};
const groupIntros: Record<RequirementMark, string> = {
  required: 'Rekruter oznaczył te wymagania jako konieczne na tym stanowisku.',
  unmarked: 'Nikt jeszcze nie zdecydował, czy te wymagania są konieczne, czy dodatkowe. Oznacz je w profilu stanowiska.',
  additional: 'Rekruter oznaczył te wymagania jako dodatkowe.',
};

function RequirementCard({ requirement }: { requirement: CandidateRequirement }) {
  return <article className={styles.criterion}>
    <p>{criterionKindLabels[requirement.kind]}</p>
    <h4>{requirement.text}</h4>
    <p><strong>{requirementStatusLabels[requirement.status]}</strong>
      {requirement.corrected && <small> · skorygowane przez rekrutera</small>}</p>
    {requirement.status === 'in_progress' &&
      <p className="notice">Analiza tego wymagania jeszcze się nie skończyła. To nie znaczy, że w CV nic o nim nie ma.</p>}
    {requirement.status === 'rejected' &&
      <p className="notice">Rekruter odrzucił ten wiersz analizy. Pytanie ustal samodzielnie na podstawie wymagania.</p>}
    {requirement.status === 'legacy' &&
      <p className="notice">Ta analiza jest starszego typu i nie zawiera cytatów z CV dla tego wymagania.</p>}
    {!!requirement.quotes.length && <>
      <h5>Cytat z CV</h5>
      {requirement.quotes.map((quote, index) => <blockquote key={index}>{quote.quote}
        <footer><small>Pozycja w sprawdzonym tekście CV: {quote.start}–{quote.end}</small></footer></blockquote>)}
    </>}
    {requirement.missingInfo && <><h5>Czego brakuje</h5><p>{requirement.missingInfo}</p></>}
    {requirement.question && <><h5>Pytanie na rozmowę</h5><p>{requirement.question}</p></>}
  </article>;
}

export default async function CandidateReportPage({ params }: { params: Promise<ScreeningRoute> }) {
  const route = await params;
  const { companyId, recruitmentId, applicationId } = route;
  const { client } = await companyAccess(companyId);
  if (!Object.values(route).every(isUuid)) notFound();
  const base = `/dashboard/${companyId}/recruitments/${recruitmentId}`;
  let report: CandidateReport;
  try { report = await loadCandidateReport(client, route); }
  catch (error) {
    if (error instanceof ScreeningNotFoundError) notFound();
    if (error instanceof CandidateReportError) {
      return <main className="workspace"><section><Link href={base}>← Rekrutacja</Link>
        <h1>Raport kandydata</h1><p role="status" className="notice">{error.message}</p>
        <Link href={`${base}/applications/${applicationId}/report`}>Odśwież raport</Link></section></main>;
    }
    throw error;
  }
  const { summary } = report;

  return <main className={`workspace ${styles.screening}`}><section>
    <Link href={base}>← Rekrutacja</Link>
    <p className="eyebrow">SKILLCHECK · RAPORT KANDYDATA</p>
    <h1>Raport kandydata</h1>
    <p>{report.recruitmentName} · {report.positionTitle}</p>
    <p><small>Zgłoszenie {applicationId.slice(0, 8)} · wygenerowano {new Date(report.generatedAt).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })} (Warszawa)</small></p>
    <p className="notice">Raport zestawia wymagania stanowiska z informacjami z CV i wspiera ocenę człowieka.
      Nie jest decyzją o zatrudnieniu i nie zawiera wyniku ogólnego. {noMissingDataDisclaimer}</p>

    <h2>Podsumowanie</h2>
    {!report.analysisStatus && <p role="status">Dla tego zgłoszenia nie ma jeszcze analizy CV.
      {' '}<Link href={screeningPath(route)}>Uruchom analizę</Link>, aby wypełnić raport.</p>}
    {(report.analysisStatus === 'pending' || report.analysisStatus === 'processing') &&
      <p role="status">Analiza CV jeszcze trwa. Wymagania czekają na wynik — to nie to samo co brak informacji w CV.</p>}
    {(report.analysisStatus === 'failed' || report.analysisStatus === 'cancelled') &&
      <p role="status">Ostatnia analiza nie zakończyła się wynikiem. <Link href={screeningPath(route)}>Sprawdź jej stan</Link>.</p>}
    {report.legacyAnalysis && <p className="notice">Część wymagań pochodzi z analizy starszego typu, bez zestawienia dowodów.
      {' '}<Link href={screeningPath(route)}>Uruchom nową analizę</Link>.</p>}
    {report.reanalysisRequested && <p className="notice">Rekruter odesłał tę analizę do powtórzenia, więc jej wyniki nie są tu pokazywane jako aktualne.
      {' '}<Link href={screeningPath(route)}>Uruchom analizę ponownie</Link>.</p>}
    {report.stale && <p className="notice">CV albo wymagania zmieniły się po tej analizie, więc wynik może być nieaktualny.
      {' '}<Link href={screeningPath(route)}>Uruchom analizę ponownie</Link>.</p>}
    {!summary.requiredTotal
      ? <p>Żadne wymaganie nie jest jeszcze oznaczone jako konieczne. Oznacz wymagania w profilu stanowiska,
          żeby raport zaczynał się od tych, na których Ci zależy.</p>
      : <p>Z {summary.requiredTotal} wymagań koniecznych: {summary.requiredSupported} ma potwierdzenie w CV,
          {' '}{summary.requiredGaps} wymaga wyjaśnienia na rozmowie, {summary.requiredPending} czeka na wynik analizy
          albo na sprawdzenie przez człowieka.</p>}
    <p>Pozostałe wymagania: {summary.unmarkedTotal} nieoznaczonych, {summary.additionalTotal} dodatkowych.</p>
    {report.analysisVersion !== null && <p><small>Analiza w wersji {report.analysisVersion}, CV v{report.documentVersion}.</small></p>}

    {requirementMarkOrder.map(mark => {
      const rows = report.requirements.filter(requirement => requirement.mark === mark);
      return <div key={mark}>
        <h3>{groupHeadings[mark]} ({requirementMarkLabels[mark].toLowerCase()})</h3>
        <p>{groupIntros[mark]}</p>
        {/* Zasada pustych sekcji: grupa bez wymagań zostaje na stronie. */}
        {rows.length ? rows.map(requirement => <RequirementCard key={requirement.id} requirement={requirement} />)
          : <p>Brak wymagań w tej grupie.</p>}
      </div>;
    })}

    <h2>Dalsze kroki</h2>
    <ul>
      <li><Link href={screeningPath(route)}>Macierz wymagań i dowodów</Link></li>
      <li><Link href={`${base}/applications/${applicationId}/interview`}>Przygotowanie do rozmowy</Link></li>
      <li><Link href={`${base}/report`}>Porównanie kandydatów</Link></li>
    </ul>
  </section></main>;
}
