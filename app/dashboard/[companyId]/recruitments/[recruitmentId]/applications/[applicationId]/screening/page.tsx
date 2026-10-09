import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { companyAccess } from '../../../../../../../../lib/company-access';
import { prepareScreening, type PreparedScreening } from '../../../../../../../../lib/screening';
import { loadScreeningContext, ScreeningNotFoundError } from '../../../../../../../../lib/screening-flow';
import { screeningAiUserEnabled } from '../../../../../../../../lib/screening-dispatch';
import { ratingLabels, reviewLabels, screeningStatus, screeningPath, isUuid, statusLabels, type ScreeningRoute } from '../../../../../../../../lib/screening-ui';
import { AnalysisControl, RefreshStatus, ReviewControl } from './controls';
import styles from './screening.module.css';

const kinds = { task: 'Zadanie', kpi: 'Miernik sukcesu', competency: 'Kompetencja' };
export default async function Screening({ params, searchParams }: { params: Promise<ScreeningRoute>; searchParams: Promise<{ analysis?: string }> }) {
  const route = await params;
  const { companyId, recruitmentId } = route;
  const { client, canEdit } = await companyAccess(companyId);
  if (!Object.values(route).every(isUuid)) notFound();
  const context = await loadScreeningContext(client, route).catch(error => {
    if (error instanceof ScreeningNotFoundError) notFound();
    throw error;
  });
  let prepared: PreparedScreening | undefined;
  let reason = '';
  try { prepared = prepareScreening(context); } catch (error) { reason = error instanceof Error ? error.message : 'Sprawdź dane przed analizą.'; }
  const history = await client.from('screening_analysis_versions').select('id,analysis_version,execution_status,created_at')
    .eq('company_id', companyId).eq('application_id', route.applicationId).eq('recruitment_id', recruitmentId).order('analysis_version', { ascending: false });
  if (history.error) throw new Error('Nie udało się wczytać historii analiz.');
  const selectedId = (await searchParams).analysis ?? history.data[0]?.id;
  if (selectedId && !history.data.some(a => a.id === selectedId)) notFound();
  const result = selectedId ? await client.from('screening_analysis_versions')
    .select('id,analysis_version,execution_status,input_fingerprint,stale_at,input_cv_text_snapshot,latest_review_version,candidate_document_version')
    .eq('company_id', companyId).eq('application_id', route.applicationId).eq('id', selectedId).maybeSingle() : null;
  if (result?.error || (selectedId && !result?.data)) throw new Error('Nie udało się wczytać analizy.');
  const analysis = result?.data ?? null;
  const [findings, reviews] = analysis ? await Promise.all([
    client.from('screening_criterion_results').select('*').eq('company_id', companyId).eq('analysis_id', analysis.id).order('criterion_order'),
    client.from('screening_result_reviews').select('*').eq('company_id', companyId).eq('analysis_id', analysis.id).order('review_version', { ascending: false }),
  ]) : [{ data: [], error: null }, { data: [], error: null }];
  if (findings.error || reviews.error) throw new Error('Nie udało się wczytać wyników lub przeglądu.');
  const criteria = findings.data ?? [];
  const review = reviews.data?.[0];
  const overrides = review ? await client.from('screening_criterion_review_overrides').select('*').eq('company_id', companyId).eq('review_id', review.id) : { data: [], error: null };
  if (overrides.error) throw new Error('Nie udało się wczytać korekt.');
  const corrections = new Map(overrides.data?.map(o => [o.criterion_result_id, o]));
  const historical = !!analysis && analysis.id !== history.data[0]?.id;
  const stale = historical || screeningStatus(analysis, prepared?.fingerprint) === 'stale';
  const status = stale ? 'stale' : screeningStatus(analysis, prepared?.fingerprint);
  const enabled = screeningAiUserEnabled();
  const base = `/dashboard/${companyId}`;
  return <main className={`workspace ${styles.screening}`}><section>
    <Link href={`${base}/recruitments/${recruitmentId}`}>← Rekrutacja</Link>
    <h1>Analiza preselekcji</h1><p>{context.recruitment.name} · {context.position.title}</p>
    <p>Decyzję o dalszym udziale w rekrutacji podejmuje człowiek. Brak informacji w CV oznacza brak danych do oceny, a nie ocenę negatywną.</p>
    {!enabled && <p className="notice">Uruchamianie analizy AI jest obecnie wyłączone. Możesz przeglądać zapisane wyniki.</p>}
    {!canEdit && <p className="notice">Masz dostęp tylko do odczytu.</p>}
    <p><Link href={`${base}/candidates/${context.application.candidate_id}/cv`}>Sprawdź CV i anonimizację</Link> · <Link href={`${base}/positions/${context.position.id}`}>Sprawdź wymagania stanowiska</Link></p>
    {reason && <p role="status" className="notice">{reason}</p>}
    <h2>Stan analizy</h2>
    <p role="status">{!analysis && !prepared ? 'Materiał wymaga uzupełnienia' : statusLabels[status]}{analysis ? ` · wersja ${analysis.analysis_version}` : ''}</p>
    {stale && <p className="notice">To wynik historyczny lub oparty na nieaktualnym materiale. Nie można zatwierdzić go jako aktualnego.</p>}
    {status === 'failed' && <p>Nie udało się ukończyć analizy. Możesz ponowić próbę dla tego samego, nadal aktualnego materiału.</p>}
    <RefreshStatus active={!!analysis && ['pending', 'processing'].includes(analysis.execution_status) && !stale} />
    {canEdit && !historical && status !== 'processing' && <AnalysisControl key={`${analysis?.id ?? 'new'}:${status}`} route={route} requestId={randomUUID()}
      retryId={status === 'failed' ? analysis?.id : undefined} disabled={!enabled || !prepared}
      label={status === 'failed' ? 'Ponów analizę' : status === 'pending' ? 'Ponów wysłanie' : status === 'completed' && review?.disposition !== 'needs_reanalysis' ? 'Sprawdź aktualny wynik' : 'Uruchom analizę'} />}
    {prepared && <details><summary>Materiał przygotowany do analizy · CV v{prepared.binding.document_version}</summary>
      <ul>{prepared.payload.criteria.map(c => <li key={c.id}><strong>{kinds[c.kind]}:</strong> {c.text}</li>)}</ul>
      <pre className="cv-text">{prepared.payload.cv_text}</pre>
    </details>}
    {analysis?.execution_status === 'completed' && <>
      <h2>Wynik AI — oryginał</h2>
      <p>Oceny odnoszą się do kryteriów stanowiska. Nie stanowią rankingu kandydatów ani automatycznej decyzji o zatrudnieniu.</p>
      {criteria.map(c => { const correction = corrections.get(c.id); return <article className={styles.criterion} key={c.id}>
        <p>{kinds[c.criterion_kind]}</p><h3>{c.criterion_text_snapshot}</h3>
        <p><strong>{ratingLabels[c.rating]}</strong></p><p>{c.explanation}</p>
        <h4>Dowody w analizowanym CV</h4>
        {c.evidence.length ? c.evidence.map((e,i) => <blockquote key={i}>{e.quote}</blockquote>) : <p>Brak cytatów potwierdzających ocenę.</p>}
        {correction && <aside className={styles.correction}><h4>Korekta rekrutera · przegląd v{review?.review_version}</h4>
          <p><strong>{ratingLabels[correction.rating_override ?? c.rating]}</strong></p>
          <p>{correction.explanation_override ?? c.explanation}</p>
          {(correction.evidence_override ?? c.evidence).map((e,i) => <blockquote key={i}>{e.quote}</blockquote>)}
          {correction.evidence_override?.length === 0 && <p>Brak cytatów po korekcie.</p>}
        </aside>}
      </article>; })}
      <details><summary>CV użyte w tej analizie · wersja {analysis.candidate_document_version}</summary><pre className="cv-text">{analysis.input_cv_text_snapshot}</pre></details>
      {review && <section><h2>Ostatni przegląd</h2><p>{reviewLabels[review.disposition]} · wersja {review.review_version}</p><p>{review.review_note}</p></section>}
      {canEdit && !historical && <ReviewControl key={`${analysis.id}:${analysis.latest_review_version}:${stale}`} route={route} analysisId={analysis.id} version={analysis.latest_review_version} criteria={criteria} stale={stale} review={review} overrides={overrides.data ?? []} />}
      {(reviews.data?.length ?? 0) > 1 && <details><summary>Historia przeglądów</summary><ul>{reviews.data?.map(r => <li key={r.id}>v{r.review_version}: {reviewLabels[r.disposition]} — {r.review_note}</li>)}</ul></details>}
    </>}
    {history.data.length > 0 && <nav aria-label="Historia analiz"><h2>Historia analiz</h2><ul>{history.data.map(a => <li key={a.id}><Link href={`${screeningPath(route)}?analysis=${a.id}`} aria-current={a.id === analysis?.id ? 'page' : undefined}>Wersja {a.analysis_version} · {statusLabels[a.execution_status]}</Link></li>)}</ul></nav>}
    <h2>Do sprawdzenia w dalszych etapach</h2>
    <p><Link href={`${base}/recruitments/${recruitmentId}/interview-guide`}>Otwórz przewodnik rozmowy dla ośmiu obszarów zachowania</Link></p>
    <p>Samodzielność i sposób działania wymagają rozmowy, przykładów zachowań lub zadań. Nie wyciągamy wniosków o osobowości wyłącznie z CV.</p>
  </section></main>;
}
