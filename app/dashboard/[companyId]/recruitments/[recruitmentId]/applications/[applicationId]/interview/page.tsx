import Link from 'next/link';
import { notFound } from 'next/navigation';
import { companyAccess } from '../../../../../../../../lib/company-access';
import { prepareScreening } from '../../../../../../../../lib/screening';
import { loadScreeningContext, ScreeningNotFoundError } from '../../../../../../../../lib/screening-flow';
import { screeningStatus, screeningPath, isUuid, type ScreeningRoute } from '../../../../../../../../lib/screening-ui';
import { buildInterviewGaps } from '../../../../../../../../lib/interview-gaps';
import styles from '../screening/screening.module.css';

const kinds = { task: 'Zadanie', kpi: 'Miernik sukcesu', competency: 'Kompetencja' };
const verdictLabels = { partial: 'Częściowo potwierdzone', missing: 'Brak informacji', contradicted: 'Sprzeczne dane' } as const;

export default async function CandidateInterview({ params }: { params: Promise<ScreeningRoute> }) {
  const route = await params;
  const { companyId, recruitmentId } = route;
  const { client } = await companyAccess(companyId);
  if (!Object.values(route).every(isUuid)) notFound();
  const context = await loadScreeningContext(client, route).catch(error => {
    if (error instanceof ScreeningNotFoundError) notFound();
    throw error;
  });
  let fingerprint: string | undefined;
  try { fingerprint = prepareScreening(context).fingerprint; } catch { fingerprint = undefined; }
  const latest = await client.from('screening_analysis_versions')
    .select('id,analysis_version,execution_status,input_fingerprint,stale_at,candidate_document_version')
    .eq('company_id', companyId).eq('application_id', route.applicationId).eq('recruitment_id', recruitmentId)
    .order('analysis_version', { ascending: false }).limit(1).maybeSingle();
  if (latest.error) throw new Error('Nie udało się wczytać analizy.');
  const analysis = latest.data;
  const rows = analysis?.execution_status === 'completed'
    ? await client.from('screening_criterion_results').select('*').eq('company_id', companyId).eq('analysis_id', analysis.id).order('criterion_order')
    : { data: [], error: null };
  if (rows.error) throw new Error('Nie udało się wczytać macierzy dowodów.');
  const matrix = buildInterviewGaps(rows.data ?? []);
  const stale = !!analysis && screeningStatus(analysis, fingerprint) === 'stale';
  const base = `/dashboard/${companyId}/recruitments/${recruitmentId}`;

  return <main className={`workspace ${styles.screening}`}><section>
    <Link href={base}>← Rekrutacja</Link>
    <h1>Przygotowanie do rozmowy</h1>
    <p>{context.recruitment.name} · {context.position.title}</p>
    <p className="notice">Pytania wynikają z zestawienia wymagań i dowodów z CV. Pomagają uzupełnić brakujące informacje.
      Nie są oceną kandydata. Aplikacja nie oznacza kandydatów do zatrudnienia ani do odrzucenia. Kolejny krok wybiera człowiek.</p>

    {!analysis && <p role="status">Dla tego zgłoszenia nie ma jeszcze zestawienia dowodów. <Link href={screeningPath(route)}>Uruchom analizę</Link>, aby przygotować pytania o brakujące informacje.</p>}
    {analysis && analysis.execution_status !== 'completed' && <p role="status">Zestawienie dowodów nie jest jeszcze gotowe. <Link href={screeningPath(route)}>Sprawdź stan analizy</Link>.</p>}
    {analysis?.execution_status === 'completed' && matrix.total === 0 && <p role="status">Ostatnia analiza jest starszego typu i nie zawiera zestawienia dowodów. <Link href={screeningPath(route)}>Uruchom nową analizę</Link>.</p>}
    {stale && <p className="notice">Materiał (CV lub wymagania) zmienił się po analizie. Pytania mogą być nieaktualne. <Link href={screeningPath(route)}>Uruchom analizę ponownie</Link>.</p>}

    {matrix.total > 0 && <>
      <p role="status">Analiza w wersji {analysis?.analysis_version}, CV v{analysis?.candidate_document_version}: {matrix.supported} z {matrix.total} wymagań ma potwierdzenie w CV, {matrix.gaps.length} do wyjaśnienia na rozmowie.</p>
      <h2>Tematy do wyjaśnienia</h2>
      {matrix.gaps.length === 0 && <p>Wszystkie wymagania mają potwierdzenie w CV. Na rozmowie sprawdź je przykładami z pracy kandydata.</p>}
      {matrix.gaps.map(gap => <article className={styles.criterion} key={gap.id}>
        <p>{kinds[gap.kind]}</p>
        <h3>{gap.requirement}</h3>
        {gap.verdict && <p><strong className={`${styles.badge} ${styles[gap.verdict]}`}>{verdictLabels[gap.verdict]}</strong>
          {gap.source === 'edited' && <small> · skorygowane przez człowieka</small>}</p>}
        {gap.source === 'rejected' && <p className="notice">Rekruter odrzucił ten wiersz analizy. Ustal pytanie samodzielnie na podstawie wymagania.</p>}
        {gap.missingInfo && <><h4>Czego brakuje</h4><p>{gap.missingInfo}</p></>}
        <h4>Pytanie na rozmowę</h4>
        <p>{gap.question ?? 'Poproś o konkretny przykład z pracy, który pokazuje to wymaganie: sytuację, własne działania i rezultat.'}</p>
      </article>)}
      <p>Brak informacji w CV oznacza brak danych, a nie ocenę negatywną. Zapisz odpowiedź i to, czego nadal nie udało się ustalić.</p>
    </>}

    <h2>Dalsze kroki</h2>
    <ul>
      <li><Link href={screeningPath(route)}>Macierz wymagań i dowodów</Link></li>
      <li><Link href={`${base}/interview-guide`}>Przewodnik rozmowy dla ośmiu obszarów zachowania</Link></li>
      <li><Link href={`${base}#candidates`}>Etapy, notatki i decyzja człowieka</Link></li>
    </ul>
  </section></main>;
}
