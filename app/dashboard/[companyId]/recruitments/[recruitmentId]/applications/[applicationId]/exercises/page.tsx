import Link from 'next/link';
import {notFound} from 'next/navigation';
import {loadBehaviorContext,type BehaviorRoute} from '../../../../../../../../lib/behavior-context';
import {behaviorSchemaMissing} from '../../../../../../../../lib/behavior-assessment';
import {exerciseUuid} from '../../../../../../../../lib/exercise-context';
export default async function ExerciseChoices({params,searchParams}:{params:Promise<BehaviorRoute>;searchParams:Promise<{after?:string}>}){
  const route=await params,{after}=await searchParams;
  const {client,candidate}=await loadBehaviorContext(route);
  if(after&&!exerciseUuid.test(after))notFound();
  let query=client.from('exercise_definition_entries').select('*').eq('company_id',route.companyId).eq('recruitment_id',route.recruitmentId).order('id').limit(26);
  if(after)query=query.gt('id',after);
  const result=await query;
  if(result.error&&!behaviorSchemaMissing(result.error.code))throw new Error('Nie udało się wczytać zadań.');
  const base=`/dashboard/${route.companyId}/recruitments/${route.recruitmentId}/applications/${route.applicationId}`;
  const rows=result.data?.slice(0,25)??[];
  return <main className="workspace"><section><Link href={`${base}/assessments`}>← Etapy oceny</Link>
    <h1>Wykonanie zadań — {candidate.first_name} {candidate.last_name}</h1>
    <p>Wybierz dokładną wersję zadania, które wykonano. Nowsza wersja kryteriów nie zmieni dawnych ocen. Brak danych nie oznacza niskiej oceny.</p>
    {result.error?<p>Definicje zadań nie są jeszcze dostępne w tym środowisku.</p>:rows.length===0?<p>Brak wersji zadań na tej stronie.</p>:rows.map(row=><article key={row.id}>
      <h2>{row.definition.title} — wersja {row.version}</h2><p>{row.definition.kind==='competency_test'?'Test kompetencji':'Assessment Center'}</p>
      <Link href={`${base}/exercises/${row.id}`}>Obserwacje i historia dla tej wersji</Link>
    </article>)}
    {(result.data?.length??0)>25&&<Link href={`${base}/exercises?after=${rows[24].id}`}>Następna strona</Link>}
  </section></main>;
}
