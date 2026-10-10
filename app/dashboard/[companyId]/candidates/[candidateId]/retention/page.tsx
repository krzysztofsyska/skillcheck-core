import Link from 'next/link';
import {notFound} from 'next/navigation';
import {companyAccess} from '../../../../../../lib/company-access';
import {safeFailure,type RetentionRule} from '../../../../../../lib/erasure-preview';
import {RetentionWorkspace} from './forms';
export default async function RetentionPage({params}:{params:Promise<{companyId:string;candidateId:string}>}){
 const {companyId,candidateId}=await params;
 const {client,company,user}=await companyAccess(companyId);
 if(company.owner_id!==user.id)notFound();
 const candidate=await client.from('candidates').select('id,first_name,last_name').eq('company_id',companyId).eq('id',candidateId).maybeSingle();
 if(candidate.error||!candidate.data)notFound();
 const loadCandidates=async()=>{
  const rows:{id:string;first_name:string;last_name:string}[]=[];
  for(let start=0;start<10000;start+=100){
   const batch=await client.from('candidates').select('id,first_name,last_name').eq('company_id',companyId).order('id').range(start,start+99);
   if(batch.error)return {data:null,error:batch.error};rows.push(...batch.data);
   if(batch.data.length<100)return {data:rows,error:null};
  }
  return {data:null,error:{code:'TOO_MANY_CANDIDATES'}};
 };
 const [policy,resolution,candidates]=await Promise.all([
  client.rpc('get_candidate_retention_policy',{target_company:companyId}),
  client.rpc('get_erasure_subject_resolution',{target_candidate:candidateId}),
  loadCandidates(),
 ]);
 const error=policy.error??resolution.error??candidates.error;
 const p=policy.data as {revision?:number;rules?:RetentionRule[]}|null;
 const r=resolution.data as {revision?:number;candidate_ids?:string[]}|null;
 return <main className="workspace"><section><Link href={`/dashboard/${companyId}/candidates/${candidateId}`}>← Kandydat</Link><h1>Retencja i podgląd usunięcia</h1><p>{candidate.data.first_name} {candidate.data.last_name}</p><p>Ten etap pozwala ustalić zasady i sprawdzić zakres danych. Wykonanie usunięcia nie jest dostępne.</p>{error?<p role="alert">{safeFailure(error.code)}</p>:<><RetentionWorkspace companyId={companyId} candidateId={candidateId} policyRevision={p?.revision??0} rules={p?.rules??[]} resolutionRevision={r?.revision??0} selectedIds={r?.candidate_ids??[]} candidates={candidates.data??[]}/></>}</section></main>;
}
