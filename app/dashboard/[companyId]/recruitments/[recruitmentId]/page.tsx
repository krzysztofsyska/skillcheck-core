import Link from "next/link";
import { notFound } from "next/navigation";
import { companyAccess } from "../../../../../lib/company-access";
export default async function Recruitment({params}: {params:Promise<{companyId:string;recruitmentId:string}>}) {
  const {companyId,recruitmentId}=await params;
  const {client}=await companyAccess(companyId);
  const {data:recruitment,error}=await client.from('recruitments').select('*').eq('company_id',companyId).eq('id',recruitmentId).maybeSingle();
  if(error) throw new Error('Nie udało się wczytać rekrutacji.');
  if(!recruitment) notFound();
  const {data:applications,error:applicationError}=await client.from('applications').select('id,candidate_id').eq('company_id',companyId).eq('recruitment_id',recruitmentId);
  if(applicationError) throw new Error('Nie udało się wczytać zgłoszeń.');
  const candidates = applications.length ? await client.from('candidates').select('id,first_name,last_name').eq('company_id',companyId).in('id',applications.map(a=>a.candidate_id)) : {data:[],error:null};
  if(candidates.error) throw new Error('Nie udało się wczytać kandydatów.');
  return <main className="workspace"><section><Link href={`/dashboard/${companyId}`}>← Panel firmy</Link><h1>{recruitment.name}</h1><Link href={`/dashboard/${companyId}/positions/${recruitment.position_id}`}>Profil stanowiska</Link><h2>Kandydaci w rekrutacji</h2>
    {candidates.data.length ? <ul>{candidates.data.map(c=><li key={c.id}><Link href={`/dashboard/${companyId}/candidates/${c.id}`}>{c.first_name} {c.last_name}</Link> · <Link href={`/dashboard/${companyId}/recruitments/${recruitmentId}/applications/${applications.find(a=>a.candidate_id===c.id)!.id}/screening`}>Przygotowanie preselekcji</Link></li>)}</ul> : <p>Brak przypisanych kandydatów.</p>}
    <Link href={`/dashboard/${companyId}/candidates`}>Otwórz bazę kandydatów i przypisz osobę do rekrutacji</Link>
  </section></main>;
}
