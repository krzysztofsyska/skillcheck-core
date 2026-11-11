import Link from 'next/link';
import {notFound} from 'next/navigation';
import {loadBehaviorContext,type BehaviorRoute} from '../../../../../../../../lib/behavior-context';
import {behaviorSchemaMissing} from '../../../../../../../../lib/behavior-assessment';
import {exerciseUuid} from '../../../../../../../../lib/exercise-context';
import {staffWorkSample} from '../../../../../../../../lib/competency-staff-response';
import {competencyReport,parseCompetencyAccess,competencyStates} from '../../../../../../../../lib/competency-staff';
import type {ExerciseDefinition} from '../../../../../../../../lib/exercise-definition';
import {CompetencyGrantForm,CompetencyReviewForm} from '../../../competency-forms';
export default async function ExerciseChoices({params,searchParams}:{params:Promise<BehaviorRoute>;searchParams:Promise<{after?:string; attempt?:string}>}){
  const route=await params,{after,attempt}=await searchParams;
  const {client,candidate,canEdit}=await loadBehaviorContext(route);
  const staffPreview = canEdit && process.env.COMPETENCY_CANDIDATE_PREVIEW === 'true' &&
    (process.env.VERCEL_ENV === 'preview' || process.env.NODE_ENV === 'development');
  if (attempt && (!staffPreview || !exerciseUuid.test(attempt))) notFound();
  // Both RPCs lock the same application. Keep separate requests sequential.
  const attempts=staffPreview?await client.rpc('list_competency_test_attempts',{target:route.applicationId}):null;
  const accessResult=staffPreview?await client.rpc('list_competency_test_access',{target:route.applicationId}):null;
  const access=accessResult&&!accessResult.error?parseCompetencyAccess(accessResult.data):null;
  const submitted = Array.isArray(attempts?.data) ? attempts.data.flatMap(row =>
    row && typeof row === 'object' && !Array.isArray(row) && row.state === 'submitted' &&
    typeof row.id === 'string' && exerciseUuid.test(row.id) && typeof row.version === 'number'
      ? [{id:row.id,version:row.version}] : []) : [];
  let answer = null;
  let report:ReturnType<typeof competencyReport>|null=null;
  let reportDefinition:ExerciseDefinition|null=null;
  let reportVersion:number|null=null;
  if (attempt) {
    if (!submitted.some(row => row.id === attempt)) notFound();
    const response = await client.rpc('read_competency_test_response',{target:attempt});
    if (response.error) notFound();
    answer = staffWorkSample(response.data,route,attempt);
    if(!response.data||typeof response.data!=='object'||Array.isArray(response.data)||typeof response.data.definitionId!=='string')notFound();
    const exact=await client.from('exercise_definition_entries').select('id,version,definition').eq('company_id',route.companyId)
      .eq('recruitment_id',route.recruitmentId).eq('id',response.data.definitionId).maybeSingle();
    if(exact.error||!exact.data)notFound();
    report=competencyReport(response.data,route,attempt,exact.data.id,exact.data.definition);reportDefinition=exact.data.definition;reportVersion=exact.data.version;
  }
  if(after&&!exerciseUuid.test(after))notFound();
  let query=client.from('exercise_definition_entries').select('*').eq('company_id',route.companyId).eq('recruitment_id',route.recruitmentId).order('id').limit(26);
  if(after)query=query.gt('id',after);
  const result=await query;
  if(result.error&&!behaviorSchemaMissing(result.error.code))throw new Error('Nie udało się wczytać zadań.');
  const base=`/dashboard/${route.companyId}/recruitments/${route.recruitmentId}/applications/${route.applicationId}`;
  const rows=result.data?.slice(0,25)??[];
  return <main className="workspace"><section><Link href={`${base}/assessments`}>← Etapy oceny</Link>
    <h1>Wykonanie zadań — {candidate.first_name} {candidate.last_name}</h1>
    {staffPreview && <section><h2>Oddane testy kompetencji</h2>
      {attempts?.error ? <p>Odczyt prób jest niedostępny.</p> : submitted.length === 0 ?
        <p>Brak oddanych testów.</p> : <ol>{submitted.map(row=><li key={row.id}>
          <Link href={base+'/exercises?attempt='+row.id}>Odpowiedź kandydata · wersja zadania {row.version}</Link>
        </li>)}</ol>}
      {answer !== null && report && reportDefinition && attempt && <>
        <h3>Raport z testu kompetencji</h3>
        <p>{reportDefinition.title} · wersja zadania {reportVersion}</p>
        <p>Ocena dotyczy tej wersji zadania i oddanej próbki pracy. Nie stanowi decyzji o zatrudnieniu.</p>
        <h4>Potwierdzone w próbce pracy</h4>
        {report.confirmed.length===0?<p>Brak ocenionych dowodów.</p>:report.confirmed.map(item=><article key={item.criterionIndex}>
          <strong>{item.competency}</strong><p>{item.rating==='above'?'Powyżej wymagań':item.rating==='meets'?'Zgodnie z wymaganiami':'Poniżej wymagań'}</p>
          <p>Uzasadnienie według rubryki: {item.rationale}</p>
          <blockquote>{item.evidence}</blockquote></article>)}
        <h4>Deklaracje kandydata — treść oddanej odpowiedzi</h4><p className="cv-text">{answer}</p>
        <h4>Braki danych</h4>{report.missing.length?<ul>{report.missing.map((name,i)=><li key={i}>{name}</li>)}</ul>:<p>Każde kryterium ma oceniony cytat.</p>}
        {report.review?<p>Wersja oceny: {report.review.version}. Pokrycie dowodami: {Math.round(report.review.coverage*100)}%.
          {report.review.score===null?' Za mało dowodów do wyniku zbiorczego.':` Wynik rubryki: ${report.review.score}/100; wymaga interpretacji człowieka.`}</p>:<p>Odpowiedź oczekuje na ocenę rekrutera.</p>}
        <CompetencyReviewForm key={attempt+':'+(report.review?.version??0)} route={route} attemptId={attempt} version={report.review?.version??0} definition={reportDefinition}/>
      </>}
    </section>}
    <p>Wybierz dokładną wersję zadania, które wykonano. Nowsza wersja kryteriów nie zmieni dawnych ocen. Brak danych nie oznacza niskiej oceny.</p>
    {staffPreview&&accessResult?.error&&<p role="status">Zarządzanie dostępem jest niedostępne w tym środowisku.</p>}
    {staffPreview&&access?.cancelled&&<p role="status">Dostęp do testów został wycofany. Odpowiedzi i działania są niedostępne.</p>}
    {staffPreview&&access&&!access.cancelled&&!access.shortlisted&&<p>Wydanie i rotacja linku wymagają aktywnej shortlisty. Możesz odwołać wcześniej wydany dostęp.</p>}
    {result.error?<p>Definicje zadań nie są jeszcze dostępne w tym środowisku.</p>:rows.length===0?<p>Brak wersji zadań na tej stronie.</p>:rows.map(row=><article key={row.id}>
      <h2>{row.definition.title} — wersja {row.version}</h2><p>{row.definition.kind==='competency_test'?'Test kompetencji':'Assessment Center'}</p>
      {staffPreview&&access&&row.definition.kind==='competency_test'&&<>
       {access.access.filter(g=>g.definitionId===row.id).map(g=><p key={g.grantId}>{competencyStates[g.state]} · rewizja dostępu {g.revision}
        {g.deadlineAt&&` · termin odpowiedzi ${g.deadlineAt}`}</p>)}
       {!access.cancelled&&<CompetencyGrantForm route={route} definitionId={row.id} grant={access.access.find(g=>g.definitionId===row.id)} canIssue={access.shortlisted}/>}
      </>}
      <Link href={`${base}/exercises/${row.id}`}>Obserwacje i historia dla tej wersji</Link>
    </article>)}
    {(result.data?.length??0)>25&&<Link href={`${base}/exercises?after=${rows[24].id}`}>Następna strona</Link>}
  </section></main>;
}
