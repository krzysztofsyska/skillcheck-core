import Link from 'next/link';
import {notFound} from 'next/navigation';
import {loadBehaviorContext,type BehaviorRoute} from '../../../../../../../../../lib/behavior-context';
import {behaviorEditingOpen,behaviorSchemaMissing,behaviorRatings,parseHistoryBefore} from '../../../../../../../../../lib/behavior-assessment';
import {exerciseUuid} from '../../../../../../../../../lib/exercise-context';
import {ExerciseObservationForm} from '../../../../exercise-observation-form';
export default async function Observations({params,searchParams}:{params:Promise<BehaviorRoute&{definitionId:string}>;searchParams:Promise<{before?:string}>}){
  const route=await params;const {before}=await searchParams;
  const {client,canEdit,user,application,recruitment,position,candidate}=await loadBehaviorContext(route);
  if(!exerciseUuid.test(route.definitionId))notFound();
  let cursor:number|null;try{cursor=parseHistoryBefore(before);}catch{notFound();}
  const rubric=await client.from('exercise_definition_entries').select('*').eq('company_id',route.companyId).eq('recruitment_id',route.recruitmentId).eq('id',route.definitionId).maybeSingle();
  if(rubric.error)throw new Error('Nie udało się wczytać wersji zadania.');if(!rubric.data)notFound();
  const definition=rubric.data;
  let query=client.from('exercise_observation_entries').select('*').eq('company_id',route.companyId).eq('recruitment_id',route.recruitmentId)
    .eq('application_id',route.applicationId).eq('definition_entry_id',route.definitionId).order('version',{ascending:false}).limit(21);
  if(cursor)query=query.lt('version',cursor);
  const history=await query;
  if(history.error&&!behaviorSchemaMissing(history.error.code))throw new Error('Nie udało się wczytać obserwacji.');
  const base=`/dashboard/${route.companyId}/recruitments/${route.recruitmentId}/applications/${route.applicationId}/exercises`;
  const rows=history.data?.slice(0,20)??[];
  const changed=rubric.data.position_id!==position.id||rubric.data.position_updated_at!==position.updated_at;
  return <main className="workspace"><section><Link href={base}>← Wersje zadań</Link>
    <h1>{rubric.data.definition.title} — wersja zadania {rubric.data.version}</h1><p>{candidate.first_name} {candidate.last_name}</p>
    <p className="cv-text">{rubric.data.definition.instructions}</p><p>Oczekiwany rezultat: {rubric.data.definition.expectedOutput}</p>
    <p>Oceny zapisuje człowiek względem tej wersji zadania. Zapis nie podejmuje decyzji o zatrudnieniu.</p>
    {changed&&<p className="notice">Profil stanowiska zmienił się. Ta ocena nadal dotyczy kryteriów wybranej wersji zadania.</p>}
    {history.error?<p role="status">Zapis i historia obserwacji nie są jeszcze dostępne w tym środowisku.</p>:<>
      {!cursor&&canEdit&&behaviorEditingOpen(application.status,recruitment.status,position.status)&&<ExerciseObservationForm key={rubric.data.id} route={route} rubric={rubric.data} entry={rows[0]}/>}
            {(!canEdit||!behaviorEditingOpen(application.status,recruitment.status,position.status))&&<p>Dostęp tylko do odczytu: Twoja rola lub status procesu nie pozwala na zapis.</p>}
      <details><summary>Kryteria i profil zapisane z tą wersją zadania</summary>
        {definition.definition.criteria.map((criterion,index)=><div key={index}><h3>{criterion.competency}</h3><p>Poniżej: {criterion.below}</p><p>Zgodnie: {criterion.meets}</p><p>Powyżej: {criterion.above}</p></div>)}
        <pre className="cv-text">{JSON.stringify(definition.position_snapshot,null,2)}</pre>
      </details>
      <h2>Historia obserwacji</h2>
      {rows.length===0&&<p>Brak zapisanych obserwacji na tej stronie.</p>}
      {rows.map(entry=><article key={entry.id}><h3>Wersja oceny {entry.version}</h3><p>{entry.created_at} · Autor: {entry.author_id===user.id?'Ty':entry.author_id}</p>
        <p className="cv-text">{entry.work_sample||'Nie dołączono tekstu pracy.'}</p>
        {entry.observations.map(item=><div key={item.criterionIndex}><h4>{definition.definition.criteria[item.criterionIndex].competency}</h4>
          <p>{behaviorRatings.find(([key])=>key===item.rating)?.[1]}</p><p className="cv-text">{item.evidence||'Brak dodatkowej notatki.'}</p></div>)}
      </article>)}
      {(history.data?.length??0)>20&&<Link href={`${base}/${route.definitionId}?before=${rows[19].version}`}>Starsze obserwacje</Link>}
      {cursor&&<p><Link href={`${base}/${route.definitionId}`}>Najnowsze obserwacje</Link></p>}
    </>}
  </section></main>;
}
