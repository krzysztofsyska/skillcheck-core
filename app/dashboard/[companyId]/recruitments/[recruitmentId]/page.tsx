import Link from "next/link";
import { notFound } from "next/navigation";
import { companyAccess } from "../../../../../lib/company-access";
import { StageForm, StageControls } from "./assessment-forms";
import { PreselectionGroups, type GroupRow } from "./bulk/groups";
export default async function Recruitment({params}: {params:Promise<{companyId:string;recruitmentId:string}>}) {
  const {companyId,recruitmentId}=await params;
  const {client,canEdit}=await companyAccess(companyId);
  const {data:recruitment,error}=await client.from('recruitments').select('*').eq('company_id',companyId).eq('id',recruitmentId).maybeSingle();
  if(error) throw new Error('Nie udało się wczytać rekrutacji.');
  if(!recruitment) notFound();
  const {data:applications,error:applicationError}=await client.from('applications').select('id,candidate_id').eq('company_id',companyId).eq('recruitment_id',recruitmentId);
  if(applicationError) throw new Error('Nie udało się wczytać zgłoszeń.');
  const candidates = applications.length ? await client.from('candidates').select('id,first_name,last_name').eq('company_id',companyId).in('id',applications.map(a=>a.candidate_id)) : {data:[],error:null};
  if(candidates.error) throw new Error('Nie udało się wczytać kandydatów.');
  const stages = await client.from('assessment_stages').select('*').eq('company_id',companyId).eq('recruitment_id',recruitmentId).order('sequence');
  if(stages.error) throw new Error('Nie udało się wczytać etapów.');
  const groups = await client.rpc('get_preselection_groups',{target_recruitment:recruitmentId});
  const groupRows = (groups.error ? [] : groups.data ?? []) as GroupRow[];
  return <main className="workspace"><section><Link href={`/dashboard/${companyId}`}>← Panel firmy</Link><h1>{recruitment.name}</h1><p><Link href={`/dashboard/${companyId}/positions/${recruitment.position_id}`}>Profil stanowiska</Link> · <Link href={`/dashboard/${companyId}/recruitments/${recruitmentId}/interview-guide`}>Przewodnik rozmowy</Link></p><p><Link href={`/dashboard/${companyId}/recruitments/${recruitmentId}/exercises`}>Zadania kompetencyjne i Assessment Center</Link></p><p>{canEdit && <Link href={`/dashboard/${companyId}/recruitments/${recruitmentId}/bulk`}><strong>Wgraj wiele CV</strong></Link>}{canEdit ? ' — ' : ''}<Link href={`/dashboard/${companyId}/recruitments/${recruitmentId}/bulk`}>paczki CV i postęp przetwarzania</Link></p>
    <h2 id="preselekcja">Wyniki preselekcji (grupy)</h2>
    <PreselectionGroups companyId={companyId} recruitmentId={recruitmentId} rows={groupRows} canEdit={canEdit}/>
    <h2 id="candidates">Kandydaci w rekrutacji</h2>
    {candidates.data.length ? <ul>{candidates.data.map(c=><li key={c.id}><Link href={`/dashboard/${companyId}/candidates/${c.id}`}>{c.first_name} {c.last_name}</Link> · <Link href={`/dashboard/${companyId}/recruitments/${recruitmentId}/applications/${applications.find(a=>a.candidate_id===c.id)!.id}/screening`}>Preselekcja AI</Link> · <Link href={`/dashboard/${companyId}/recruitments/${recruitmentId}/applications/${applications.find(a=>a.candidate_id===c.id)!.id}/interview`}>Pytania na rozmowę</Link> · <Link href={`/dashboard/${companyId}/recruitments/${recruitmentId}/applications/${applications.find(a=>a.candidate_id===c.id)!.id}/assessments`}>Etapy oceny</Link></li>)}</ul> : <p>Brak przypisanych kandydatów.</p>}
    <p><Link href={`/dashboard/${companyId}/recruitments/${recruitmentId}/report`}>Raport preselekcji i eksport</Link></p>
    <Link href={`/dashboard/${companyId}/candidates`}>Otwórz bazę kandydatów i przypisz osobę do rekrutacji</Link>
    <h2>Plan etapów oceny</h2>
    <p>Nazwanie etapu „AI” lub „voicebot” nie uruchamia integracji. Opisz, co rekruter ma sprawdzić i jakie dowody zebrać.</p>
    {!stages.data.length && <p>Brak zdefiniowanych etapów.</p>}
    <ul>{stages.data.map((stage,index)=><li key={stage.id}><strong>{stage.sequence}. {stage.name}</strong>{stage.description && <p className="cv-text">{stage.description}</p>}{canEdit && <StageControls companyId={companyId} recruitmentId={recruitmentId} stageId={stage.id} name={stage.name} first={index === 0} last={index === stages.data.length - 1}/>}</li>)}</ul>
    {canEdit && <details><summary>Dodaj etap oceny</summary><StageForm companyId={companyId} recruitmentId={recruitmentId} nextSequence={(stages.data.at(-1)?.sequence ?? 0)+1}/></details>}
  </section></main>;
}
