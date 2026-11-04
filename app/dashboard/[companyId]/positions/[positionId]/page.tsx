import Link from "next/link";
import { notFound } from "next/navigation";
import { companyAccess } from "../../../../../lib/company-access";
import { PositionForm } from "../../forms";
import { RequirementMarks } from "./requirement-marks";
import { loadRequirementFlags } from "../../../../../lib/candidate-report";
import { positionRequirements, resolveRequirementMarks, type RequirementMark } from "../../../../../lib/requirement-flags";
export default async function PositionPage({params,searchParams}:{params:Promise<{companyId:string;positionId:string}>;searchParams:Promise<{saved?:string}>}) {
  const {companyId,positionId}=await params;
  const {client,company,canEdit}=await companyAccess(companyId);
  const {data:position,error}=await client.from("positions").select("*").eq("company_id",companyId).eq("id",positionId).maybeSingle();
  if(error) throw new Error("Nie udało się wczytać stanowiska.");
  if(!position) notFound();
  const requirements=positionRequirements(position);
  const marks=Object.fromEntries(resolveRequirementMarks(requirements,await loadRequirementFlags(client,companyId,position.id))) as Record<string,RequirementMark>;
  const {saved}=await searchParams;
  return <main className="workspace"><section><Link href={`/dashboard/${companyId}`}>← {company.name}</Link><p className="eyebrow">PROFIL STANOWISKA</p><h1>{position.title}</h1>
    {saved==="1"&&<p role="status" className="notice">Profil stanowiska został zapisany.</p>}
    {canEdit ? <PositionForm companyId={companyId} position={position}/> : <><p>{position.description}</p>{[["Zadania",position.tasks],["KPI",position.kpis],["Kompetencje",position.required_competencies],["Zachowania",position.required_behaviors]].map(([title,items])=><div key={title as string}><h2>{title}</h2><ul>{(items as string[]).map((s,i)=><li key={i}>{s}</li>)}</ul></div>)}<p>Samodzielność: {position.autonomy_level}/5</p></>}
    <RequirementMarks companyId={companyId} positionId={position.id} requirements={requirements} marks={marks} canEdit={canEdit}/>
  </section></main>;
}
