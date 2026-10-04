"use client";
import { useActionState, useRef, useState } from "react";
import { SubmitButton } from "../../../../../components/submit-button";
import { addCv, editCv, reviewCv } from "./actions";
import type { CandidateDocument } from "../../../../../../lib/supabase/database.types";
import type { EditorState } from "../../../../../../lib/position-fields";

function Feedback({state}:{state:EditorState}) {
  return <>{state.error && <p role="alert" className="notice">{state.error}</p>}{state.saved && <p role="status" className="notice">Zapisano.</p>}</>;
}
export function IntakeForm({companyId,candidateId}:{companyId:string;candidateId:string}) {
  const [text,setText] = useState('');
  const file = useRef<File|null>(null);
  const [filename,setFilename] = useState('');
  const [state,action] = useActionState(async (previous:EditorState,form:FormData) => {
    form.set('cv_file',file.current ?? '');
    const result = await addCv(companyId,candidateId,previous,form);
    if(result.saved) { setText(''); file.current=null; setFilename(''); }
    return result;
  },{});
  return <form action={action}><Feedback state={state}/>
    <label>Wklej tekst CV<textarea name="source_text" value={text} onChange={e=>setText(e.target.value)} rows={10} maxLength={100000}/></label>
    <label>Lub dodaj TXT (do 200 KB) albo PDF/DOCX (do 750 KB, PDF do 20 stron)<input type="file" name="cv_file" accept=".txt,text/plain,.pdf,application/pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={e=>{file.current=e.target.files?.[0]??null;setFilename(file.current?.name??'');}}/></label>
    {filename && <p>Wybrany plik: {filename} <button type="button" onClick={()=>{file.current=null;setFilename('');}}>Usuń wybór pliku</button></p>}
    <p>Obsługujemy tekst, TXT, tekstowy PDF i DOCX. Obrazów i skanów nie odczytujemy. DOCX z nagłówkami, stopkami lub przypisami wymaga wklejenia pełnego tekstu albo zapisania jako tekstowy PDF. Sprawdź kompletność odczytanego tekstu, zwłaszcza kolumn i tabel. W bazie firmy zapisujemy tekst, bez oryginalnego pliku.</p>
    <SubmitButton>Zapisz CV i przygotuj propozycję anonimizacji</SubmitButton>
  </form>;
}
export function RedactionForm({document}:{document:CandidateDocument}) {
  const [text,setText]=useState(document.redacted_text);
  const [state,action]=useActionState(editCv.bind(null,document.company_id,document.candidate_id,document.id,document.version),{});
  const [review,approve]=useActionState(reviewCv.bind(null,document.company_id,document.candidate_id,document.id,document.version),{});
  const dirty=text!==document.redacted_text;
  return <><form action={action}><Feedback state={state}/><label>Tekst do sprawdzenia<textarea name="redacted_text" value={text} onChange={e=>setText(e.target.value)} rows={14} maxLength={100000} required/></label><SubmitButton>Zapisz poprawki</SubmitButton></form>
    {document.status==='draft' && (dirty ? <p>Przed zatwierdzeniem zapisz poprawki.</p> : <form action={approve}><Feedback state={review}/><label><input type="checkbox" name="confirmed" required/>Sprawdziłem tekst i usunąłem dane pozwalające rozpoznać osobę, w tym adresy, datę urodzenia i identyfikatory.</label><SubmitButton>Zatwierdź sprawdzony tekst</SubmitButton></form>)}
  </>;
}
