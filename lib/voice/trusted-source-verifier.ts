/**
 * SC-012-B: read-only trusted source reconstruction, isolated backend.
 * NOT a public API, write authorization, or production release gate.
 */
import { isDeepStrictEqual } from "node:util";
import { createVoicePlanWriteSnapshot, type VoicePlanWriteSnapshot } from "./plan-persistence-contract.ts";
import { selectReviewedScreeningGaps } from "./screening-gap-selection.ts";
import type { InterviewSource } from "./interview-plan.ts";
import {getTrustedVoiceTemplate,trustedVoiceTemplateDigest} from "./template-registry.ts";

type Row=Record<string,any>;
export type SqlClient={query(sql:string,params?:readonly unknown[]):Promise<{rows:Row[]}>};
export type SourceSelector=Readonly<{
  companyId:string;applicationId:string;analysisId:string;reviewId:string;shortlistEntryId:string;
}>;
export class TrustedSourceError extends Error {
  readonly code:"FORBIDDEN"|"STALE"|"TEMPLATE_CHANGED"|"INVALID";
  constructor(code:"FORBIDDEN"|"STALE"|"TEMPLATE_CHANGED"|"INVALID"){
    super("VOICE_TRUSTED_SOURCE_"+code);
    this.code=code;
  }
}
const fail=(c:TrustedSourceError["code"]):never=>{throw new TrustedSourceError(c);};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex=/^[0-9a-f]{64}$/;
export const ACTIVE_VOICE_TEMPLATE_VERSION="skillcheck-voice-plan-v1" as const;
export const ACTIVE_VOICE_TEMPLATE_DIGEST=trustedVoiceTemplateDigest(ACTIVE_VOICE_TEMPLATE_VERSION);
const id=(x:unknown)=>typeof x==="string"&&uuid.test(x)?x:fail("INVALID");
const only=(x:Row[])=>x.length===1?x[0]:fail("STALE");
const iso=(x:unknown)=>x instanceof Date?x.toISOString():
  typeof x==="string"&&!Number.isNaN(Date.parse(x))?new Date(x).toISOString():fail("INVALID");

/** The caller must own a dedicated PG connection. All locks and checks are
 * inside one transaction; no input flag is trusted as an approval. */
async function reconstructLocked(
  db:SqlClient,s:SourceSelector,
):Promise<VoicePlanWriteSnapshot>{
  Object.values(s).forEach(id);
    // Lock the application namespace before reading mutable source rows.
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))",
      [s.companyId+":"+s.applicationId]);
    const auth=only((await db.query([
      "select c.owner_id,auth.uid() as actor",
      "from public.companies c where c.id=$1 for share nowait",
    ].join(" "),[s.companyId])).rows);
    if(!auth.actor)fail("FORBIDDEN");
    if(auth.actor!==auth.owner_id){
      const members=(await db.query([
        "select m.role from public.company_members m",
        "where m.company_id=$1 and m.user_id=$2 for share nowait",
      ].join(" "),[s.companyId,auth.actor])).rows;
      if(members.length!==1||members[0].role!=="recruiter")fail("FORBIDDEN");
    }
    const h=only((await db.query([
      "select ap.company_id,ap.id as application_id,ap.updated_at as application_updated_at,",
      "ap.status as application_status,rec.id as recruitment_id,",
      "rec.updated_at as recruitment_updated_at,rec.status as recruitment_status,",
      "pos.id as position_id,pos.updated_at as position_updated_at,pos.status as position_status,",
      "pos.title,pos.tasks,pos.kpis,pos.required_behaviors,pos.required_competencies,",
      "a.id as analysis_id,a.input_fingerprint,a.analysis_contract_hash,",
      "a.criteria_snapshot,a.latest_review_version,a.execution_status,a.stale_at,",
      "r.id as review_id,r.review_version,r.disposition,",
      "s.id as shortlist_entry_id,s.removed_at",
      "from public.applications ap",
      "join public.recruitments rec on rec.company_id=ap.company_id and rec.id=ap.recruitment_id",
      "join public.positions pos on pos.company_id=rec.company_id and pos.id=rec.position_id",
      "join public.screening_analysis_versions a on a.company_id=ap.company_id",
      "and a.application_id=ap.id and a.recruitment_id=rec.id and a.position_id=pos.id",
      "join public.screening_result_reviews r on r.company_id=a.company_id and r.analysis_id=a.id",
      "join public.recruitment_shortlist_entries s on s.company_id=a.company_id",
      "and s.application_id=ap.id and s.recruitment_id=rec.id and s.analysis_id=a.id",
      "and s.review_id=r.id",
      "where ap.company_id=$1 and ap.id=$2 and a.id=$3 and r.id=$4 and s.id=$5",
      "for share of ap,rec,pos,a,r,s nowait",
    ].join(" "),[s.companyId,s.applicationId,s.analysisId,s.reviewId,s.shortlistEntryId])).rows);
    if(h.application_status==="withdrawn"||h.application_status==="rejected"||
       h.recruitment_status!=="open"||h.position_status!=="active"||
       h.execution_status!=="completed"||h.stale_at!==null||h.removed_at!==null||
       !["approved","approved_with_changes"].includes(h.disposition)||
       h.latest_review_version!==h.review_version||
       !hex.test(h.input_fingerprint)||!hex.test(h.analysis_contract_hash))fail("STALE");
    const newest=only((await db.query([
      "select id from public.screening_analysis_versions",
      "where company_id=$1 and application_id=$2",
      "order by analysis_version desc limit 1",
    ].join(" "),[s.companyId,s.applicationId])).rows);
    if(newest.id!==s.analysisId)fail("STALE");
    const criteria=h.criteria_snapshot;
    if(!Array.isArray(criteria)||criteria.length<2||criteria.length>90)fail("INVALID");
    const approvedCriteria=criteria.map((c:Row)=>({id:c?.id,kind:c?.kind}));
    const results=(await db.query([
      "select criterion_id,rating from public.screening_criterion_results",
      "where company_id=$1 and analysis_id=$2",
      "order by criterion_order for share nowait",
    ].join(" "),[s.companyId,s.analysisId])).rows.map(r=>({criterionId:r.criterion_id,rating:r.rating}));
    const overrides=(await db.query([
      "select cr.criterion_id,o.rating_override",
      "from public.screening_criterion_review_overrides o",
      "join public.screening_criterion_results cr on cr.company_id=o.company_id",
      "and cr.id=o.criterion_result_id and cr.analysis_id=$3",
      "where o.company_id=$1 and o.review_id=$2",
      "order by cr.criterion_order for share of o,cr nowait",
    ].join(" "),[s.companyId,s.reviewId,s.analysisId])).rows.map(r=>({
      criterionId:r.criterion_id,rating:r.rating_override,
    }));
    const gaps=selectReviewedScreeningGaps({
      latestHumanDecision:h.disposition,analysisCompleted:true,
      analysisCurrent:true,shortlistCurrent:true,criteria:approvedCriteria,
      results,overrides,
    },approvedCriteria);
    const source:InterviewSource={
      companyId:s.companyId,applicationId:s.applicationId,
      positionRevision:iso(h.position_updated_at),
      analysisRevision:s.analysisId,reviewRevision:s.reviewId+":"+h.review_version,
      screeningReviewed:true,screeningCurrent:true,
      position:{title:h.title,tasks:h.tasks,kpis:h.kpis,
        requiredBehaviors:h.required_behaviors,requiredCompetencies:h.required_competencies},
      gaps,
    };
    const binding={
      companyId:s.companyId,recruitmentId:h.recruitment_id,
      applicationId:s.applicationId,positionId:h.position_id,
      analysisId:s.analysisId,reviewId:s.reviewId,shortlistEntryId:s.shortlistEntryId,
      applicationUpdatedAt:iso(h.application_updated_at),
      recruitmentUpdatedAt:iso(h.recruitment_updated_at),
      positionUpdatedAt:iso(h.position_updated_at),
      analysisFingerprint:h.input_fingerprint,screeningContractHash:h.analysis_contract_hash,
    };
    const template=getTrustedVoiceTemplate(ACTIVE_VOICE_TEMPLATE_VERSION);
    const result=createVoicePlanWriteSnapshot(source,binding);
    if(result.templateVersion!==template.version||result.language!==template.language||
       result.targetSeconds!==template.targetSeconds||
       result.maximumSeconds!==template.maximumSeconds||
       result.recordingAllowed!==template.recordingAllowed||
       result.noticeRequired!==template.noticeRequired)fail("TEMPLATE_CHANGED");
    return result;
}
async function withReadTransaction<T>(db:SqlClient,work:()=>Promise<T>):Promise<T>{
  await db.query("begin");
  try{
    const result=await work();
    await db.query("commit");
    return result;
  }catch(e){await db.query("rollback");throw e;}
}
export async function reconstructTrustedVoiceSource(
  db:SqlClient,s:SourceSelector,
):Promise<VoicePlanWriteSnapshot>{
  return withReadTransaction(db,()=>reconstructLocked(db,s));
}
/** Does not authorize review or release: only a source integrity preflight.
 * The mutating RPC must repeat the checks under its own transaction locks. */
export async function verifyStoredVoicePlan(db:SqlClient,planId:string){
  id(planId);
  return withReadTransaction(db,async()=>{
    const p=only((await db.query([
      "select company_id,application_id,analysis_id,screening_review_id,",
      "shortlist_entry_id,source_hash,template_version,plan_envelope",
      "from public.voice_plan_versions where id=$1",
    ].join(" "),[planId])).rows);
    // Acquire application advisory lock before any plan row lock; the
    // subsequent locked re-read rejects changes between the two reads.
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))",
      [p.company_id+":"+p.application_id]);
    const locked=only((await db.query([
      "select company_id,application_id,analysis_id,screening_review_id,",
      "shortlist_entry_id,source_hash,template_version,plan_envelope",
      "from public.voice_plan_versions where id=$1 for share nowait",
    ].join(" "),[planId])).rows);
    if(!isDeepStrictEqual(locked,p))fail("STALE");
    if(p.template_version!==ACTIVE_VOICE_TEMPLATE_VERSION)fail("TEMPLATE_CHANGED");
    const rebuilt=await reconstructLocked(db,{
      companyId:p.company_id,applicationId:p.application_id,
      analysisId:p.analysis_id,reviewId:p.screening_review_id,
      shortlistEntryId:p.shortlist_entry_id,
    });
    if(p.source_hash!==rebuilt.sourceHash||!isDeepStrictEqual(p.plan_envelope,rebuilt))
      fail("STALE");
    return rebuilt;
  });
}
