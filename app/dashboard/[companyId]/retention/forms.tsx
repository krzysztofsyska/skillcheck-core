'use client';
import {useActionState,useEffect,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {authorizeErasure,cancelErasure,issueErasureTicket} from './actions';
import {stableRequestKey,blockerLabel,previewCountLabels} from '../../../../lib/erasure-preview';
import {canAuthorizeTicket,type LifecycleState,type ErasureStatus} from '../../../../lib/erasure-lifecycle';
export function useLifecycleAction(action:(state:LifecycleState,form:FormData)=>Promise<LifecycleState>){
 const previous=useRef<{payload:string;key:string}|null>(null);
 return useActionState(async(state:LifecycleState,form:FormData)=>{
  previous.current=stableRequestKey(form,previous.current,()=>crypto.randomUUID());form.set('request_key',previous.current.key);
  try{return await action(state,form)}catch{return {error:'Nie otrzymano potwierdzenia. Sprawdź status lub ponów bez zmiany formularza.'}}
 },{} as LifecycleState);
}
function Feedback({state}:{state:LifecycleState}){return <>{state.error&&<p role="alert">{state.error}</p>}{state.saved&&<p role="status">{state.saved}</p>}</>}
export function ErasureAuthorization({companyId,candidateId}:{companyId:string;candidateId:string}){
 const [preview,prepare,preparing]=useLifecycleAction(issueErasureTicket.bind(null,companyId,candidateId));
 const [state,authorize,pending]=useLifecycleAction(authorizeErasure.bind(null,companyId));
 const router=useRouter();
 useEffect(()=>{if(state.saved&&state.requestId){router.replace(`/dashboard/${companyId}/retention`);router.refresh()}},[state.saved,state.requestId,companyId,router]);
 const [now,setNow]=useState(0);
 useEffect(()=>{setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return ()=>clearInterval(timer)},[]);
 const ticket=preview.ticket;const expired=!!ticket&&now>=Date.parse(ticket.expires_at);const blocked=!!ticket&&!canAuthorizeTicket(ticket);
 return <section><h2>Zatwierdzenie żądania usunięcia</h2><p>Zatwierdzenie wstrzyma zmiany i ukryje objęte żądaniem rekordy w zwykłych widokach. Postęp wykonania jest widoczny na liście żądań. Anulowanie jest możliwe tylko przed rozpoczęciem nieodwracalnego usuwania i może wymagać potwierdzenia.</p>
 <p><a href={`/dashboard/${companyId}/retention`}>Status i anulowanie żądań</a></p>
 {!state.saved&&<form action={prepare} onReset={e=>e.preventDefault()}><Feedback state={preview}/><label>Zakres żądania<select name="scope_kind" defaultValue="candidate_record"><option value="candidate_record">Tylko bieżący rekord</option><option value="confirmed_subject">Wszystkie potwierdzone rekordy osoby</option></select></label><button disabled={preparing||pending}>Przygotuj podgląd do zatwierdzenia</button></form>}
 <Feedback state={state}/>{ticket&&!state.saved&&<div><h3>Zakres do potwierdzenia</h3><p>{ticket.scope_kind==='candidate_record'?'Tylko bieżący rekord':'Wszystkie potwierdzone rekordy osoby'}. Liczba rekordów kandydatów: {ticket.candidate_count}. Wersja zasad: {ticket.policy_revision}.</p><p>Ważny do: {ticket.expires_at}.</p><table><thead><tr><th>Kategoria danych</th><th>Liczba</th></tr></thead><tbody>{Object.entries(ticket.counts).map(([key,count])=><tr key={key}><td>{previewCountLabels[key]??'Dodatkowe dane wymagające sprawdzenia'}</td><td>{count}</td></tr>)}</tbody></table><h3>Ograniczenia wykonania usunięcia</h3><ul>{ticket.blockers.map((b,i)=><li key={i}>{blockerLabel(b)}</li>)}</ul>{expired&&<p role="alert">Podgląd wygasł. Przygotuj nowy.</p>}
 {blocked&&<p role="alert">Podgląd zawiera przeszkody uniemożliwiające zatwierdzenie. Usuń je i przygotuj nowy podgląd.</p>}<form action={authorize} onReset={e=>e.preventDefault()} key={ticket.preview_ticket_id}><input type="hidden" name="preview_ticket_id" value={ticket.preview_ticket_id}/><label><input type="checkbox" name="confirmed" required disabled={pending||expired||preparing||blocked}/>Potwierdzam wskazany zakres i chcę wstrzymać zmiany tych danych.</label><button disabled={pending||expired||preparing||blocked}>{pending?'Zatwierdzanie…':'Zatwierdź żądanie i wstrzymaj zmiany'}</button></form></div>}
 </section>;
}
export function CancelErasureForm({companyId,request}:{companyId:string;request:ErasureStatus}){
 const [state,action,pending]=useLifecycleAction(cancelErasure.bind(null,companyId));
 const router=useRouter();
 useEffect(()=>{if(state.saved)router.refresh()},[state.saved,router]);
 return <><Feedback state={state}/>{request.can_cancel&&!state.saved&&<form action={action} onReset={e=>e.preventDefault()}><input type="hidden" name="request_id" value={request.request_id}/><input type="hidden" name="generation" value={request.generation}/><label><input type="checkbox" name="confirmed" required disabled={pending}/>Wnoszę o anulowanie żądania. Dostęp wróci dopiero po potwierdzeniu anulowania.</label><button disabled={pending}>{pending?'Anulowanie…':'Anuluj żądanie'}</button></form>}</>;
}
