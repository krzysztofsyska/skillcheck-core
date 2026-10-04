import Link from "next/link";
import { notFound } from "next/navigation";
import { companyAccess } from "../../../../../lib/company-access";
import { PositionForm } from "../../forms";
export default async function NewPosition({params}:{params:Promise<{companyId:string}>}) {
  const {companyId}=await params;
  const {company,canEdit}=await companyAccess(companyId);
  if(!canEdit) notFound();
  return <main className="workspace"><section><Link href={`/dashboard/${companyId}`}>← {company.name}</Link><p className="eyebrow">PROFIL STANOWISKA</p><h1>Kogo potrzebujesz?</h1><p>Opisz pracę i oczekiwane rezultaty. Odpowiedzi stworzą profil, do którego później odniesiesz ocenę kandydatów.</p><PositionForm companyId={companyId}/></section></main>;
}
