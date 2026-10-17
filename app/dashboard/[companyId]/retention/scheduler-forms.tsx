'use client';
import {useActionState,useEffect,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {configureSchedule,revokeSchedule} from './scheduler-actions';
import {stableRequestKey,retentionClasses} from '../../../../lib/erasure-preview';
import {schedulerClasses,type RetentionMode,type RetentionSchedule,type SchedulerActionState} from '../../../../lib/retention-scheduler';
export function useSchedulerAction(action:(state:SchedulerActionState,form:FormData)=>Promise<SchedulerActionState>){
 const previous=useRef<{payload:string;key:string}|null>(null);
 return useActionState(async(state:SchedulerActionState,form:FormData)=>{
  previous.current=stableRequestKey(form,previous.current,()=>crypto.randomUUID());form.set('request_key',previous.current.key);
  try{return await action(state,form)}catch{return {error:'Nie otrzymano potwierdzenia. Sprawdź monitor lub ponów bez zmiany formularza.'}}
 },{} as SchedulerActionState);
}
function Feedback({state}:{state:SchedulerActionState}){return <>{state.error&&<p role="alert">{state.error}</p>}{state.saved&&<p role="status">{state.saved}</p>}</>}
export function ScheduleConfiguration({companyId,schedule,policy}:{companyId:string;schedule:RetentionSchedule;policy:{revision:number;complete:boolean}}){
 const [state,action,pending]=useSchedulerAction(configureSchedule.bind(null,companyId));
 const [mode,setMode]=useState<RetentionMode>(schedule.revision>0?schedule.execution_mode:'suggest_only');
 const router=useRouter();useEffect(()=>{if(state.saved)router.refresh()},[state.saved,router]);
 return <section><h3>Zasady działania harmonogramu</h3><p>Delegacja dotyczy wskazanej wersji polityki i wszystkich jej ośmiu kategorii. Nie zmienia okresów przechowywania. Sam zapis nie potwierdza uruchomienia harmonogramu.</p>
 {!policy.complete&&<p role="alert">Najpierw zatwierdź kompletną politykę dla wszystkich ośmiu kategorii w ustawieniach retencji kandydata.</p>}
 <Feedback state={state}/><form action={action} onReset={e=>e.preventDefault()}><fieldset disabled={pending||!policy.complete}><legend>Polityka w wersji {policy.revision}</legend>
 <input type="hidden" name="policy_revision" value={policy.revision}/><input type="hidden" name="expected_revision" value={schedule.revision}/>
 <label>Sposób obsługi<select name="execution_mode" value={mode} onChange={e=>setMode(e.target.value as RetentionMode)}><option value="suggest_only">Tylko propozycje — każda wymaga mojej zgody</option><option value="automatic">Automatyczne zatwierdzanie w zatwierdzonym zakresie</option></select></label>
 <label>Maksymalna liczba osób na jeden przebieg<input name="max_batch" type="number" min={1} max={100} step={1} defaultValue={schedule.max_batch} required/></label>
 {mode==='automatic'&&<fieldset><legend>Zakres delegacji automatycznej</legend>{schedulerClasses.map(c=><label key={c}><input type="checkbox" name="data_classes" value={c} required/>{retentionClasses[c]}</label>)}<label><input type="checkbox" name="automatic_confirmed" required/>Upoważniam harmonogram do automatycznego zatwierdzania usunięcia wyłącznie w tej wersji polityki, po sprawdzeniu wszystkich procesów, potwierdzonych rekordów i blokad.</label></fieldset>}
 <label><input type="checkbox" name="confirmed" required/>Potwierdzam wybrany tryb, wersję polityki i limit przebiegu.</label>
 <button>{pending?'Zapisywanie…':'Zapisz delegację'}</button></fieldset></form></section>;
}
export function ScheduleRevocation({companyId,schedule}:{companyId:string;schedule:RetentionSchedule}){
 const [state,action,pending]=useSchedulerAction(revokeSchedule.bind(null,companyId));const router=useRouter();useEffect(()=>{if(state.saved)router.refresh()},[state.saved,router]);
 return <section><Feedback state={state}/>{schedule.revision>0&&!schedule.revoked&&<form action={action} onReset={e=>e.preventDefault()}><input type="hidden" name="expected_revision" value={schedule.revision}/><label><input type="checkbox" name="confirmed" required disabled={pending}/>Wycofuję delegację dla kolejnych działań harmonogramu. Nie cofa to rozpoczętego ani już nieodwracalnie zatwierdzonego usuwania, również oczekującego na potwierdzenie rejestru.</label><button disabled={pending}>{pending?'Wycofywanie…':'Wycofaj delegację'}</button></form>}</section>;
}
