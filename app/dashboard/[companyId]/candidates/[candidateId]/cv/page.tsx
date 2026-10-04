import Link from "next/link";
import { notFound } from "next/navigation";
import { companyAccess } from "../../../../../../lib/company-access";
import { IntakeForm, RedactionForm } from "./forms";
export default async function CandidateCV({params}:{params:Promise<{companyId:string;candidateId:string}>}) {
  const {companyId,candidateId}=await params;
  const {client,canEdit}=await companyAccess(companyId);
  const candidate=await client.from('candidates').select('id').eq('company_id',companyId).eq('id',candidateId).maybeSingle();
  if(candidate.error) throw new Error('Nie udało się wczytać kandydata.');
  if(!candidate.data) notFound();
  const documents=await client.from('candidate_documents').select('*').eq('company_id',companyId).eq('candidate_id',candidateId).order('created_at',{ascending:false}).limit(10);
  const unavailable=documents.error && ['42P01','PGRST205'].includes(documents.error.code);
  if(documents.error && !unavailable) throw new Error('Nie udało się wczytać CV.');
  return <main className="workspace"><section><Link href={`/dashboard/${companyId}/candidates/${candidateId}`}>← Karta kandydata</Link><h1>CV i anonimizacja tekstu</h1>
    {unavailable ? <p className="notice">Moduł CV oczekuje na uruchomienie. Wróć do karty kandydata; pozostałe funkcje są dostępne.</p> : <>
      <p className="notice">Automatyczne podpowiedzi mogą pominąć dane identyfikujące. Przed zatwierdzeniem przeczytaj cały tekst. Zatwierdzenie dotyczy anonimizacji, nie oceny kandydata.</p>
      {canEdit && <details><summary>Dodaj tekst CV</summary><IntakeForm companyId={companyId} candidateId={candidateId}/></details>}
      <h2>Dokumenty — ostatnie 10</h2>{!documents.data?.length && <p>Brak CV. Dodaj tekst, aby przygotować wersję do sprawdzenia.</p>}
      {documents.data?.map((d,i)=><article key={d.id}><h3>CV {i+1} — {d.status==='reviewed'?'Sprawdzone przez rekrutera':'Wymaga sprawdzenia'}</h3><p>Dodano: {new Date(d.created_at).toLocaleString('pl-PL',{timeZone:'Europe/Warsaw'})}. Wersja {d.version}.</p>
        <details><summary>Oryginalny tekst (dane osobowe)</summary><pre className="cv-text">{d.source_text}</pre></details>
        {canEdit ? <RedactionForm key={`${d.id}:${d.version}`} document={d}/> : <pre className="cv-text">{d.redacted_text}</pre>}
      </article>)}
    </>}
  </section></main>;
}
