import Link from 'next/link';
import {notFound} from 'next/navigation';
import {companyAccess} from '../../../../lib/company-access';
import {erasureStatusLabel,parseStatus,uuid,lifecycleFailure} from '../../../../lib/erasure-lifecycle';
import {blockerLabel} from '../../../../lib/erasure-preview';
import {CancelErasureForm} from './forms';
export default async function ErasureRequestsPage({params,searchParams}:{params:Promise<{companyId:string}>;searchParams:Promise<{before?:string;id?:string}>}){
 const {companyId}=await params;const {client,company,user}=await companyAccess(companyId);if(company.owner_id!==user.id)notFound();
 const cursor=await searchParams;let before:string|undefined,id:string|undefined;
 if(cursor.before||cursor.id){try{id=uuid(cursor.id);if(!cursor.before||!Number.isFinite(Date.parse(cursor.before)))throw Error();before=cursor.before}catch{notFound()}}
 const result=await client.rpc('list_candidate_erasure_requests',{target_company:companyId,before_created_at:before,before_id:id,page_size:25});
 let rows:ReturnType<typeof parseStatus>[]=[],error=result.error?lifecycleFailure(result.error.code):'';
 if(!error){try{if(!Array.isArray(result.data))throw Error();rows=result.data.map(parseStatus)}catch{error='Nie udało się odczytać statusów. Odśwież stronę.'}}
 const last=rows.at(-1);
 return <main className="workspace"><section><Link href={`/dashboard/${companyId}/candidates`}>← Kandydaci</Link><h1>Żądania usunięcia danych</h1><p>Zatwierdzone żądanie wstrzymuje zmiany danych. Stan danych aktywnych i kopii zapasowych jest raportowany oddzielnie.</p><Link href={`/dashboard/${companyId}/retention`}>Odśwież / pierwsza strona</Link>{error?<p role="alert">{error}</p>:<>{rows.length===0&&<p>Brak żądań na tej stronie.</p>}{rows.map(request=><article key={`${request.request_id}:${request.generation}`}><h2>{erasureStatusLabel(request)}</h2><p>Identyfikator żądania: {request.request_id}</p><p>Zakres: {request.scope_kind==='candidate_record'?'pojedynczy rekord':'potwierdzone rekordy osoby'}. Liczba rekordów: {request.candidate_count}.</p><p>Utworzono: {request.created_at}{request.cancelled_at?`. Anulowano: ${request.cancelled_at}`:''}.</p>{request.status!=='cancelled'&&<ul>{request.blockers.map((b,i)=><li key={i}>{blockerLabel(b)}</li>)}</ul>}{request.local_purged&&<p>Dane aktywne usunięto z lokalnej bazy. Ten stan nie potwierdza usunięcia kopii zapasowych ani danych u dostawców zewnętrznych.</p>}<CancelErasureForm companyId={companyId} request={request}/></article>)}{rows.length===25&&last&&<Link href={`?before=${encodeURIComponent(last.created_at)}&id=${last.request_id}`}>Następna strona →</Link>}</>}</section></main>;
}
