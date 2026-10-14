import Link from "next/link";
import { notFound } from "next/navigation";
import { companyAccess } from "../../../../../lib/company-access";
import { AssignmentForm } from "../forms";
export default async function Candidate({params}: {params:Promise<{companyId:string;candidateId:string}>}) {
  const {companyId,candidateId}=await params;
  const {client,canEdit,company,user}=await companyAccess(companyId);
  const {data:candidate,error}=await client.from('candidates').select('*').eq('company_id',companyId).eq('id',candidateId).maybeSingle();
  if(error) throw new Error('Nie udało się wczytać kandydata.');
  if(!candidate) notFound();
  const [applications,recruitments]=await Promise.all([
    client.from('applications').select('*').eq('company_id',companyId).eq('candidate_id',candidateId),
    client.from('recruitments').select('id,name').eq('company_id',companyId).order('created_at',{ascending:false}),
  ]);
  if(applications.error||recruitments.error) throw new Error('Nie udało się wczytać rekrutacji.');
  const statuses:Record<string,string>={new:'Nowy',in_progress:'W trakcie',rejected:'Odrzucony',withdrawn:'Wycofany',hired:'Zatrudniony'};
  return <main className="workspace"><section><Link href={`/dashboard/${companyId}/candidates`}>← Kandydaci</Link><h1>{candidate.first_name} {candidate.last_name}</h1><p>{candidate.email || 'Brak adresu e-mail'}</p><p>{candidate.phone || 'Brak telefonu'}</p>
    <p><Link href={`/dashboard/${companyId}/candidates/${candidateId}/cv`}>CV i anonimizacja tekstu</Link></p>{company.owner_id===user.id && <p><Link href={`/dashboard/${companyId}/candidates/${candidateId}/retention`}>Retencja i podgląd usunięcia</Link></p>}<h2>Rekrutacje kandydata</h2>{applications.data.length ? <ul>{applications.data.map(a=><li key={a.id}><Link href={`/dashboard/${companyId}/recruitments/${a.recruitment_id}`}>{recruitments.data.find(r=>r.id===a.recruitment_id)?.name ?? 'Rekrutacja'}</Link> — {statuses[a.status]}</li>)}</ul> : <p>Kandydat nie jest jeszcze przypisany do rekrutacji.</p>}
    {canEdit && recruitments.data.length>0 && <AssignmentForm companyId={companyId} candidateId={candidateId} recruitments={recruitments.data}/>}
  </section></main>;
}
