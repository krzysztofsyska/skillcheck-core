"use client";
import { useActionState, useState } from "react";
import { addCandidate, assignCandidate } from "./actions";
import { SubmitButton } from "../../../components/submit-button";

export function CandidateForm({companyId}: {companyId: string}) {
  const [state, action] = useActionState(addCandidate.bind(null, companyId), {});
  const [values, setValues] = useState<Record<string,string>>({});
  return <form action={action}>{state.error && <p role="alert">{state.error}</p>}
    {([['first_name','Imię',100,'text'],['last_name','Nazwisko',100,'text'],['email','E-mail (opcjonalnie)',254,'email'],['phone','Telefon (opcjonalnie)',40,'tel']] as const).map(([name,label,maxLength,type]) => <label key={name}>{label}<input name={name} type={type} maxLength={maxLength} required={name==='first_name'||name==='last_name'} value={values[name] ?? ''} onChange={e=>setValues({...values,[name]:e.target.value})}/></label>)}
    <SubmitButton>Zapisz kandydata</SubmitButton>
  </form>;
}
export function AssignmentForm({companyId,candidateId,recruitments}: {companyId:string;candidateId:string;recruitments:{id:string;name:string}[]}) {
  const [state, action] = useActionState(assignCandidate.bind(null,companyId,candidateId),{});
  const [selected,setSelected] = useState('');
  return <form action={action}>{state.error && <p role="alert">{state.error}</p>}{state.saved && <p role="status">Przypisano do rekrutacji.</p>}
    <label>Rekrutacja<select name="recruitment_id" required value={selected} onChange={e=>setSelected(e.target.value)}><option value="" disabled>Wybierz rekrutację</option>{recruitments.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
    <SubmitButton>Przypisz do rekrutacji</SubmitButton>
  </form>;
}
