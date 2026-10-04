import Link from 'next/link';
import { notFound } from 'next/navigation';
import { exerciseContext, exerciseUuid } from '../../../../../../../lib/exercise-context';
import { parseHistoryBefore, behaviorSchemaMissing } from '../../../../../../../lib/behavior-assessment';
import { ExerciseForm } from '../../exercise-form';
export default async function Exercise({params,searchParams}: {
  params:Promise<{companyId:string;recruitmentId:string;exerciseId:string}>; searchParams:Promise<{before?:string}>;
}) {
  const {companyId,recruitmentId,exerciseId} = await params;
  const {client,base,editable,position,user} = await exerciseContext(companyId,recruitmentId);
  if (!exerciseUuid.test(exerciseId)) notFound();
  let before: number | null;
  try { before = parseHistoryBefore((await searchParams).before); } catch { notFound(); }
  const latest = await client.from('latest_exercise_definitions').select('*').eq('company_id',companyId).eq('recruitment_id',recruitmentId).eq('exercise_id',exerciseId).maybeSingle();
  if (latest.error) {
    if (!behaviorSchemaMissing(latest.error.code)) throw new Error('Nie udało się wczytać zadania.');
    return <main className="workspace"><section><Link href={base}>← Zadania</Link><p>Moduł zadań nie jest jeszcze dostępny w tym środowisku.</p></section></main>;
  }
  if (!latest.data) notFound();
  let query = client.from('exercise_definition_entries').select('*').eq('company_id',companyId).eq('recruitment_id',recruitmentId).eq('exercise_id',exerciseId).order('version',{ascending:false}).limit(21);
  if (before) query = query.lt('version',before);
  const history = await query;
  if (history.error) throw new Error('Nie udało się wczytać historii zadania.');
  const rows = history.data.slice(0,20), entry = latest.data;
  const changed = entry.position_id !== position.id || entry.position_updated_at !== position.updated_at;
  return <main className="workspace"><section><Link href={base}>← Zadania</Link><h1>{entry.definition.title}</h1>
    {changed && <p role="status">Profil stanowiska zmienił się od ostatniego zapisu. Sprawdź instrukcję i kryteria przed zapisaniem nowej wersji.</p>}
    {editable && !before && <ExerciseForm companyId={companyId} initial={entry.definition} context={{recruitmentId,exerciseId,expectedVersion:entry.version,positionId:position.id,positionUpdatedAt:position.updated_at}}/>}
    <h2>Historia definicji</h2>
    {rows.map(row => <article key={row.id}><h3>Wersja {row.version} — {row.definition.title}</h3>
      <p>{row.created_at} · Autor: {row.author_id === user.id ? 'Ty' : row.author_id}</p>
      <p>{row.definition.kind === 'competency_test' ? 'Test kompetencji' : 'Assessment Center'} · {row.definition.durationMinutes} min</p>
      <h4>Instrukcja</h4><p className="cv-text">{row.definition.instructions}</p>
      <h4>Oczekiwany rezultat</h4><p className="cv-text">{row.definition.expectedOutput}</p>
      {row.definition.criteria.map((criterion,i) => <div key={i}><h4>{criterion.competency}</h4><p>Poniżej wymagań: {criterion.below}</p><p>Zgodnie z wymaganiami: {criterion.meets}</p><p>Powyżej wymagań: {criterion.above}</p></div>)}
      <details><summary>Profil stanowiska z chwili zapisu</summary><h4>{row.position_snapshot.title}</h4><p className="cv-text">{row.position_snapshot.description}</p>
        <p>Samodzielność: {row.position_snapshot.autonomy_level ?? 'Nie określono'}</p>
        {(['tasks','kpis','required_competencies','required_behaviors'] as const).map((key,i) => <div key={key}><h4>{['Zadania','KPI','Kompetencje','Wymagania zachowań'][i]}</h4><ul>{row.position_snapshot[key].map((text,j)=><li key={j}>{text}</li>)}</ul></div>)}
      </details>
    </article>)}
    {!rows.length && <p>Brak wcześniejszych wersji.</p>}
    {before && <p><Link href={`${base}/${exerciseId}`}>Najnowsza wersja i edycja</Link></p>}
    {history.data.length > 20 && <Link href={`${base}/${exerciseId}?before=${rows[19].version}`}>Starsze wersje</Link>}
  </section></main>;
}
