import Link from 'next/link';
import {uuid} from '../../../../lib/erasure-lifecycle';
import {notFound} from 'next/navigation';
import {companyAccess} from '../../../../lib/company-access';
import {parseSchedule,parseSuggestions,currentPolicy,schedulerBlocker,schedulerFailure} from '../../../../lib/retention-scheduler';
import {ScheduleConfiguration,ScheduleRevocation} from './scheduler-forms';
export default async function RetentionSchedulerPanel({companyId,suggestionCursor={}}:{companyId:string;suggestionCursor?:{before?:string;id?:string}}){
 const {client,company,user}=await companyAccess(companyId);if(company.owner_id!==user.id)notFound();
 let before:string|undefined,id:string|undefined;if(suggestionCursor.before||suggestionCursor.id){try{id=uuid(suggestionCursor.id);if(!suggestionCursor.before||!Number.isFinite(Date.parse(suggestionCursor.before)))throw Error();before=suggestionCursor.before}catch{notFound()}}
 const [result,policyResult,suggestionResult]=await Promise.all([client.rpc('get_retention_schedule',{target_company:companyId}),client.rpc('get_candidate_retention_policy',{target_company:companyId}),client.rpc('get_retention_suggestions',{target_company:companyId,before_created_at:before,before_id:id,page_size:25})]);
 if(result.error)return <section aria-labelledby="retention-monitor"><h2 id="retention-monitor">Harmonogram retencji</h2><p role="alert">{schedulerFailure(result.error.code)}</p></section>;
 let schedule;try{schedule=parseSchedule(result.data)}catch{return <section><h2>Harmonogram retencji</h2><p role="alert">Nie udało się odczytać monitora. Odśwież stronę.</p></section>}
 let suggestions:ReturnType<typeof parseSuggestions>=[],suggestionError=suggestionResult.error?'Nie udało się pobrać propozycji. Odśwież stronę.':'';if(!suggestionError){try{suggestions=parseSuggestions(suggestionResult.data)}catch{suggestionError='Nie udało się odczytać propozycji. Odśwież stronę.'}}
 const lastSuggestion=suggestions.at(-1);
 const policy=currentPolicy(policyResult.error?null:policyResult.data);
 const status=schedule.revision===0?'Brak delegacji':schedule.revoked?'Delegacja wycofana':!schedule.owner_current?'Wymagane zatwierdzenie przez obecnego właściciela':schedule.execution_mode==='suggest_only'?'Zapisano tryb propozycji':'Zapisano delegację automatyczną';
 const metrics=[['Propozycje',schedule.suggestions],['Zatwierdzone zakresy',schedule.authorized],['Blokady wykonania',schedule.blocked],['Wstrzymania wymagające przeglądu',schedule.holds],['Wygasłe dzierżawy wykonania',schedule.expired_leases]] as const;
 return <section aria-labelledby="retention-monitor"><h2 id="retention-monitor">Harmonogram retencji</h2><p><strong>{status}</strong>. Wersja delegacji: {schedule.revision}. Wersja powiązanej polityki: {schedule.policy_revision??'brak'}.</p>
 <p>{schedule.execution_enabled?'Monitor potwierdza dostępność wykonania w tym środowisku. Każdy zakres nadal podlega sprawdzeniu.':'Monitor nie potwierdza uruchomionego wykonania w tym środowisku. Zapisana delegacja nie oznacza wdrożenia produkcyjnego.'}</p>
 {schedule.blockers.length>0&&<><h3>Warunki wymagające sprawdzenia</h3><ul>{schedule.blockers.map((b,i)=><li key={`${b}:${i}`}>{schedulerBlocker(b)}</li>)}</ul></>}
 <dl>{metrics.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value??'Brak danych'}</dd></div>)}<div><dt>Najstarsze oczekujące wykonanie</dt><dd>{schedule.oldest_pending_at?<time dateTime={schedule.oldest_pending_at}>{schedule.oldest_pending_at}</time>:'Brak oczekującego wykonania'}</dd></div><div><dt>Ostatni przebieg</dt><dd>{schedule.last_tick_at?<time dateTime={schedule.last_tick_at}>{schedule.last_tick_at}</time>:'Brak zarejestrowanego przebiegu'}</dd></div><div><dt>Opóźnienie harmonogramu</dt><dd>{schedule.lag_seconds===null?'Brak danych':`${schedule.lag_seconds} s`}</dd></div></dl>
 <p>Liczby propozycji i zatwierdzeń nie są potwierdzeniem usunięcia danych ani wygaśnięcia kopii. Szczegóły wykonania znajdziesz na liście żądań poniżej.</p>
 {policyResult.error&&<p role="alert">Nie udało się pobrać polityki. Zapis delegacji jest niedostępny; wycofanie istniejącej delegacji pozostaje dostępne.</p>}
 <h3>Propozycje do sprawdzenia</h3><p>Przejdź do aktualnego podglądu przed zatwierdzeniem. Propozycja nie zastępuje ponownego sprawdzenia polityki, zakresu i blokad.</p><Link href={`/dashboard/${companyId}/retention`}>Pierwsza strona propozycji</Link>
 {suggestionError?<p role="alert">{suggestionError}</p>:<>{suggestions.length===0&&<p>Brak propozycji na tej stronie.</p>}{suggestions.map(s=><article key={s.id}><h4>Propozycja {s.id}</h4><p>Stan: {s.status==='suggested'?'do sprawdzenia':s.status==='blocked'?'wstrzymana':'zatwierdzona'}. Termin retencji: {s.due_at??'nieustalony'}.</p>{s.blockers.length>0&&<ul>{s.blockers.map((b,i)=><li key={`${b}:${i}`}>{schedulerBlocker(b)}</li>)}</ul>}{s.status!=='authorized'&&<Link href={`/dashboard/${companyId}/candidates/${s.anchor_candidate_id}/retention`}>Otwórz aktualny podgląd i sprawdź zakres</Link>}{s.status==='authorized'&&<p>Sprawdź stan wykonania na liście żądań poniżej.</p>}</article>)}{suggestions.length===25&&lastSuggestion&&<Link href={`?suggestion_before=${encodeURIComponent(lastSuggestion.created_at)}&suggestion_id=${lastSuggestion.id}`}>Następna strona propozycji →</Link>}</>}
 <ScheduleConfiguration key={`configure:${schedule.revision}:${policy.revision}`} companyId={companyId} schedule={schedule} policy={policy}/><ScheduleRevocation key={`revoke:${schedule.revision}`} companyId={companyId} schedule={schedule}/>
 </section>;
}
