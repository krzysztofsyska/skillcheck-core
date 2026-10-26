import Link from 'next/link';
import { notFound } from 'next/navigation';
import { companyAccess } from '../../../../../../../../lib/company-access';
import { loadScreeningContext, ScreeningNotFoundError } from '../../../../../../../../lib/screening-flow';
import { prepareScreening } from '../../../../../../../../lib/screening';
import { evidenceVerdictLabels, snapshotHash } from '../../../../../../../../lib/evidence-matrix';
import { EvidenceRun, EvidenceRow, type MatrixItem } from './controls';
import styles from './evidence.module.css';

type Route = { companyId: string; recruitmentId: string; applicationId: string };
const statusText = { pending: 'Oczekuje', running: 'W trakcie', done: 'Gotowe', failed: 'Błąd' };
const reviewText = { unreviewed: 'Niezweryfikowane', accepted: 'Zaakceptowane', rejected: 'Odrzucone przez człowieka', edited: 'Poprawione przez człowieka' };

export default async function EvidencePage({ params }: {params:Promise<Route>}) {
  const route = await params;
  const { client,canEdit } = await companyAccess(route.companyId);
  const context = await loadScreeningContext(client,route).catch(error => {
    if(error instanceof ScreeningNotFoundError) notFound();
    throw error;
  });
  let prepared: ReturnType<typeof prepareScreening> | null = null;
  let reason = '';
  try { prepared = prepareScreening(context); }
  catch(error) {reason = error instanceof Error ? error.message : 'Materiał nie jest gotowy.';}
  const history = await client.from('evidence_analysis').select('*')
    .eq('organization_id',route.companyId).eq('application_id',route.applicationId)
    .order('created_at',{ascending:false}).limit(10);
  if(history.error) throw new Error('Nie udało się odczytać zestawień. Sprawdź migrację kroku 3.');
  const analysis = history.data?.[0];
  const results = analysis?.status === 'done'
    ? await client.from('evidence_item').select('*').eq('organization_id',route.companyId)
      .eq('analysis_id',analysis.id).order('created_at',{ascending:true})
    : {data:[],error:null};
  if(results.error) throw new Error('Nie udało się wczytać macierzy dowodów.');
  const active = analysis?.status === 'pending' || analysis?.status === 'running';
  const current = !!prepared && !!analysis && analysis.materials_snapshot_hash === snapshotHash([{
    document_id: prepared.binding.document_id,version:prepared.binding.document_version,text:prepared.payload.cv_text,
  }]) && JSON.stringify(analysis.requirements_snapshot) === JSON.stringify(prepared.payload.criteria);
  const requirements = (analysis?.requirements_snapshot || prepared?.payload.criteria || []) as {id:string;kind:string;text:string}[];
  const labels = new Map(requirements.map(r=>[r.id,r.text]));
  const items = ((results.data || []) as MatrixItem[]).slice().sort((a,b)=>
    requirements.findIndex(r=>r.id===a.requirement_key)-requirements.findIndex(r=>r.id===b.requirement_key));
  const material = analysis?.materials_snapshot?.[0] as {document_id:string;version:number;text:string}|undefined;
  return <main className={`workspace ${styles.matrix}`}><section>
    <Link href={`/dashboard/${route.companyId}/recruitments/${route.recruitmentId}`}>← Rekrutacja</Link>
    <h1>Zestawienie dowodów i brakujących informacji</h1>
    <p>{context.position.title} · CV zatwierdzone przez człowieka</p>
    <p className="notice"><strong>Zestawienie przygotowane automatycznie — wymaga weryfikacji człowieka.</strong> Brak dowodu nie oznacza niespełnienia wymagania. Nie ma oceny ogólnej ani rekomendacji zatrudnienia.</p>
    <p><Link href={`/dashboard/${route.companyId}/candidates/${context.application.candidate_id}/cv`}>Materiały kandydata</Link>
      {' · '}<Link href={`/dashboard/${route.companyId}/positions/${context.position.id}`}>Wymagania stanowiska</Link></p>
    <h2>Analiza</h2>
    <p role="status">{analysis ? statusText[analysis.status] : 'Brak analizy'}{analysis && !current ? ' · wynik historyczny (dane zmieniły się)' : ''}</p>
    {analysis?.status === 'failed' && <p role="alert">{analysis.failure_message || 'Analiza nie została ukończona.'} Ponów po sprawdzeniu materiałów.</p>}
    <EvidenceRun route={route} canRun={canEdit && !!prepared && !active} active={!!active}
      disabledReason={!canEdit ? 'Masz dostęp tylko do odczytu.' : reason}/>
    {analysis?.status === 'done' && <>
      <h2>Macierz wymagań</h2>
      <div className={styles.scroll}><table>
        <thead><tr><th scope="col">Wymaganie</th><th scope="col">Werdykt</th><th scope="col">Dowody i źródła</th><th scope="col">Czego brakuje</th><th scope="col">Sugerowane pytanie</th><th scope="col">Weryfikacja człowieka</th></tr></thead>
        <tbody>{items.map(item=><tr key={item.id}>
          <th scope="row">{labels.get(item.requirement_key) ?? item.requirement_key}</th>
          <td><span className={`${styles.badge} ${styles[item.human_verdict ?? item.verdict]}`}>{evidenceVerdictLabels[item.human_verdict ?? item.verdict]}</span><p>{reviewText[item.human_status]}</p></td>
          <td>{item.evidence_quotes?.length ? <ul>{item.evidence_quotes.map((quote,i)=><li key={i}><blockquote>{quote.quote}</blockquote><a href="#evidence-source">CV v{quote.document_version}, pozycja {quote.start}–{quote.end}</a></li>)}</ul> : 'Nie znaleziono dosłownego cytatu.'}</td>
          <td>{item.human_missing_info ?? item.missing_info || '—'}</td>
          <td>{item.human_question ?? item.suggested_question || '—'}</td>
          <td><EvidenceRow key={item.id} item={item} analysisId={analysis.id} companyId={route.companyId} canEdit={canEdit}/></td>
        </tr>)}</tbody>
      </table></div>
      {material && <details id="evidence-source"><summary>Zatwierdzony tekst źródłowy z chwili analizy · CV v{material.version}</summary><pre className="cv-text">{material.text}</pre></details>}
    </>}
    {analysis && history.data && history.data.length > 1 && <details><summary>Historia zestawień ({history.data.length})</summary><ul>{history.data.map(entry=><li key={entry.id}>
      {new Date(entry.created_at).toLocaleString('pl-PL',{timeZone:'Europe/Warsaw'})} — {statusText[entry.status]} · {entry.model}
    </li>)}</ul></details>}
  </section></main>;
}
