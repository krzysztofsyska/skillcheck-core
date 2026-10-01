import Link from "next/link";
import { companyAccess } from "../../../../lib/company-access";
import { CandidateForm } from "./forms";
export default async function Candidates({params,searchParams}: {params:Promise<{companyId:string}>;searchParams:Promise<{page?:string}>}) {
  const {companyId} = await params;
  const {client,canEdit} = await companyAccess(companyId);
  const requested = Number((await searchParams).page ?? 1);
  const page = Number.isSafeInteger(requested) && requested > 0 && requested <= 100000 ? requested : 1;
  const {data,error,count} = await client.from('candidates').select('*',{count:'exact'}).eq('company_id',companyId).order('created_at',{ascending:false}).order('id').range((page-1)*25,page*25-1);
  if(error) throw new Error('Nie udało się wczytać kandydatów.');
  return <main className="workspace"><section><Link href={`/dashboard/${companyId}`}>← Panel firmy</Link><h1>Kandydaci</h1>
    {canEdit && <details><summary>Dodaj kandydata</summary><CandidateForm companyId={companyId}/></details>}
    <p>Liczba kandydatów: {count ?? 0}</p>
    {data.length ? <ul className="companies">{data.map(c=><li key={c.id}><Link href={`/dashboard/${companyId}/candidates/${c.id}`}>{c.first_name} {c.last_name}</Link><p>{c.email}</p></li>)}</ul> : <p>Brak kandydatów na tej stronie.</p>}
    <nav aria-label="Strony kandydatów">{page>1 && <Link href={`?page=${page-1}`}>← Poprzednia </Link>}{page*25<(count??0) && <Link href={`?page=${page+1}`}>Następna →</Link>}</nav>
  </section></main>;
}
