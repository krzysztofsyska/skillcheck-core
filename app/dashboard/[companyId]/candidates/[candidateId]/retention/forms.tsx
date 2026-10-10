'use client';
import {useActionState,useState,useEffect} from 'react';
import {saveRetentionPolicy,confirmSubject,previewErasure} from './actions';
import {retentionClasses,retentionTriggers,blockerLabel,previewCountLabels,type RetentionRule,type RetentionState} from '../../../../../../lib/erasure-preview';
function Status({state}:{state:RetentionState}){return <>{state.error&&<p role="alert">{state.error}</p>}{state.saved&&<p role="status">{state.saved}</p>}</>}
export function PolicyForm({companyId,candidateId,revision,rules,onSaved}:{companyId:string;candidateId:string;revision:number;rules:RetentionRule[];onSaved?:()=>void}){
 const [state,action,pending]=useActionState(saveRetentionPolicy.bind(null,companyId,candidateId),{} as RetentionState);
 useEffect(()=>{if(state.saved)onSaved?.()},[state,onSaved]);
 return <form action={action} onReset={event=>event.preventDefault()}><h2>Zasady przechowywania</h2><p>Właściciel określa okresy dla swojej firmy. System nie proponuje domyślnych okresów prawnych. Niepełne zasady zostaną wskazane w podglądzie.</p><Status state={state}/><input type="hidden" name="revision" value={state.revision??revision}/>
 {Object.entries(retentionClasses).map(([key,label])=>{const rule=rules.find(r=>r.data_class===key);return <fieldset key={key}><legend>{label}</legend><label><input type="checkbox" name={`enabled_${key}`} defaultChecked={!!rule}/>Uwzględnij kategorię</label><label>Początek okresu<select name={`trigger_${key}`} defaultValue={rule?.trigger_event??''}><option value="">Wybierz zdarzenie</option>{Object.entries(retentionTriggers).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label><label>Okres przechowywania (dni)<input type="number" name={`duration_${key}`} min="1" max="999999" defaultValue={rule?.duration_days}/></label><label>Przegląd wstrzymania usunięcia co (dni)<input type="number" name={`hold_${key}`} min="1" max="999999" defaultValue={rule?.hold_review_days}/></label></fieldset>})}<button disabled={pending}>{pending?'Zapisywanie…':'Zapisz zasady'}</button></form>
}
export function SubjectForm({companyId,candidateId,revision,candidates,selectedIds=[],onSaved}:{companyId:string;candidateId:string;revision:number;candidates:{id:string;first_name:string;last_name:string}[];selectedIds?:string[];onSaved?:()=>void}){
 const [filter,setFilter]=useState('');
 const [state,action,pending]=useActionState(confirmSubject.bind(null,companyId,candidateId),{} as RetentionState);
 useEffect(()=>{if(state.saved)onSaved?.()},[state,onSaved]);
 return <form action={action} onReset={event=>event.preventDefault()}><h2>Zakres jednej osoby</h2><p>Bieżący rekord jest zawsze uwzględniony. Wybierz dodatkowe rekordy tylko po samodzielnym sprawdzeniu tożsamości. Zgodność nazwiska nie stanowi potwierdzenia.</p><Status state={state}/><input type="hidden" name="revision" value={state.revision??revision}/><label>Filtruj listę po imieniu lub nazwisku<input type="search" value={filter} onChange={e=>setFilter(e.target.value)} maxLength={100}/></label>{candidates.filter(c=>c.id!==candidateId).map(c=><label key={c.id} hidden={!`${c.first_name} ${c.last_name}`.toLocaleLowerCase('pl').includes(filter.toLocaleLowerCase('pl'))}><input type="checkbox" name="candidate_ids" value={c.id} defaultChecked={selectedIds.includes(c.id)}/>{c.first_name} {c.last_name}</label>)}<label><input type="checkbox" name="confirmed" required/>Potwierdzam, że wszystkie wybrane rekordy dotyczą tej samej osoby.</label><button disabled={pending}>{pending?'Zapisywanie…':'Potwierdź zakres osoby'}</button></form>
}
export function PreviewForm({companyId,candidateId}:{companyId:string;candidateId:string}){
 const [state,action,pending]=useActionState(previewErasure.bind(null,companyId,candidateId),{} as RetentionState);
 const p=state.preview;
 const [now,setNow]=useState(0);
 useEffect(()=>{setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return ()=>clearInterval(timer)},[]);
 return <section><h2>Podgląd zakresu danych</h2><p><strong>Podgląd nie usuwa danych i nie wstrzymuje kontaktu.</strong></p><form action={action} onReset={event=>event.preventDefault()}><Status state={state}/><label>Zakres<select name="scope_kind" defaultValue="candidate_record"><option value="candidate_record">Tylko bieżący rekord</option><option value="confirmed_subject">Wszystkie potwierdzone rekordy osoby</option></select></label><button disabled={pending}>{pending?'Sprawdzanie…':'Przygotuj podgląd'}</button></form>{p&&<div role="status"><h3>Wynik podglądu</h3>{now>=Date.parse(p.expires_at)&&<p role="alert">Podgląd wygasł. Przygotuj nowy podgląd.</p>}<p>Rekordy kandydatów: {p.candidate_count}. Wersja zasad: {p.policy_revision}.</p><p>Ważny do: {p.expires_at}. Po zmianie danych przygotuj nowy podgląd.</p><table><thead><tr><th>Kategoria</th><th>Liczba rekordów</th></tr></thead><tbody>{Object.entries(p.counts).map(([key,count])=><tr key={key}><td>{previewCountLabels[key]??retentionClasses[key as keyof typeof retentionClasses]??'Dodatkowe dane wymagające sprawdzenia'}</td><td>{count}</td></tr>)}</tbody></table><h3>Ograniczenia</h3><ul>{p.blockers.map((b,i)=><li key={i}>{blockerLabel(b)}</li>)}</ul></div>}</section>
}

export function RetentionWorkspace(props:{companyId:string;candidateId:string;policyRevision:number;rules:RetentionRule[];resolutionRevision:number;selectedIds:string[];candidates:{id:string;first_name:string;last_name:string}[]}){
 const [version,setVersion]=useState(0);
 // Stable callback keeps successful saves from repeatedly invalidating a preview.
 const [invalidate]=useState(()=>()=>setVersion(v=>v+1));
 return <><PolicyForm {...props} revision={props.policyRevision} onSaved={invalidate}/><SubjectForm {...props} revision={props.resolutionRevision} onSaved={invalidate}/><PreviewForm key={version} companyId={props.companyId} candidateId={props.candidateId}/></>;
}
