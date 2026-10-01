import Link from "next/link";
import { companyAccess } from "../../../lib/company-access";
import { ProfileForm, RecruitmentForm } from "./forms";
const labels:Record<string,string>={draft:"Szkic",active:"Aktywne",archived:"Archiwum",open:"Otwarta",paused:"Wstrzymana",closed:"Zamknięta"};
export default async function CompanyDashboard({params}:{params:Promise<{companyId:string}>}) {
  const {companyId}=await params;
  const {client,company,canEdit}=await companyAccess(companyId);
  const [positions,recruitments,candidates,profile]=await Promise.all([
    client.from("positions").select("*").eq("company_id",companyId).order("created_at",{ascending:false}).limit(50),
    client.from("recruitments").select("*").eq("company_id",companyId).order("created_at",{ascending:false}).limit(50),
    client.from("candidates").select("id",{count:"exact",head:true}).eq("company_id",companyId),
    client.from("company_profiles").select("*").eq("company_id",companyId).maybeSingle(),
  ]);
  if(positions.error||recruitments.error||candidates.error||profile.error) throw new Error("Nie udało się wczytać panelu.");
  return <main className="workspace"><section><nav><Link href="/dashboard">← Twoje firmy</Link></nav><p className="eyebrow">PANEL FIRMY</p><h1>{company.name}</h1>
    {!canEdit && <p className="notice">Masz dostęp tylko do odczytu.</p>}
    <p className="lead"><Link href={`/dashboard/${companyId}/candidates`}>Kandydaci w bazie firmy: {candidates.count ?? 0}</Link></p>
    <div className="actions">{canEdit && <Link className="button" href={`/dashboard/${companyId}/positions/new`}>Kogo potrzebujesz? Utwórz stanowisko</Link>}</div>
    <h2>Stanowiska</h2><p>Ostatnie 50 stanowisk.</p>
    {positions.data.length ? <ul className="companies">{positions.data.map(p=><li key={p.id}><Link href={`/dashboard/${companyId}/positions/${p.id}`}>{p.title}</Link><span className="badge">{labels[p.status]}</span></li>)}</ul> : <p>Nie masz jeszcze stanowisk. Zacznij od określenia, kogo potrzebujesz.</p>}
    <h2>Rekrutacje</h2><p>Ostatnie 50 rekrutacji.</p>
    {recruitments.data.length ? <ul className="companies">{recruitments.data.map(r=><li key={r.id}><Link href={`/dashboard/${companyId}/recruitments/${r.id}`}>{r.name}</Link><span className="badge">{labels[r.status]}</span><p>{positions.data.find(p=>p.id===r.position_id)?.title ?? "Stanowisko"}</p></li>)}</ul> : <p>Brak rekrutacji. Utwórz profil stanowiska, aby rozpocząć.</p>}
    {canEdit && positions.data.some(p=>p.status!=="archived") && <details><summary>Nowa rekrutacja</summary><RecruitmentForm companyId={companyId} positions={positions.data.filter(p=>p.status!=="archived")}/></details>}
    <h2>Profil firmy</h2>
    {canEdit ? <ProfileForm companyId={companyId} profile={profile.data}/> : <><p>{profile.data?.industry}</p><p>{profile.data?.description || "Profil nie został jeszcze uzupełniony."}</p><p>{profile.data?.work_environment}</p></>}
  </section></main>;
}
