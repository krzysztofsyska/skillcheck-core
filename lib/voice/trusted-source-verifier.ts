/**
 * SC-012-B: read-only trusted source reconstruction, isolated backend.
 * NOT a public API, write authorization, or production release gate.
 */
import { isDeepStrictEqual } from "node:util";
import { canonicalVoiceSourceSnapshot, createVoicePlanWriteSnapshot, type VoicePlanWriteSnapshot } from "./plan-persistence-contract.ts";
import { selectReviewedScreeningGaps } from "./screening-gap-selection.ts";
import {
  buildInterviewPlan, reviewInterviewPlan, releaseInterviewPlan,
  type InterviewSource, type InterviewPlan,
} from "./interview-plan.ts";
import {getTrustedVoiceTemplate,trustedVoiceTemplateDigest,assertPinnedVoiceQuestions,pinnedClarificationGaps} from "./template-registry.ts";

type Row=Record<string,any>;
export type SqlClient={query(sql:string,params?:readonly unknown[]):Promise<{rows:Row[]}>};
export type SourceSelector=Readonly<{
  companyId:string;applicationId:string;analysisId:string;reviewId:string;shortlistEntryId:string;
}>;
export class TrustedSourceError extends Error {
  readonly code:"FORBIDDEN"|"STALE"|"TEMPLATE_CHANGED"|"INVALID"|"CONFLICT";
  constructor(code:"FORBIDDEN"|"STALE"|"TEMPLATE_CHANGED"|"INVALID"|"CONFLICT"){
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

function normalizedError(error:unknown):unknown {
  if(error instanceof TrustedSourceError)return error;
  if(error&&typeof error==="object"&&"code" in error){
    const code=String(error.code);
    if(["55P03","40001","40P01"].includes(code))return new TrustedSourceError("CONFLICT");
    if(["25P01","22023"].includes(code))return new TrustedSourceError("INVALID");
    if(["42501","PT401"].includes(code))return new TrustedSourceError("FORBIDDEN");
    if(["55000","PT404"].includes(code))return new TrustedSourceError("STALE");
  }
  return error;
}
/** A savepoint fails outside an explicit transaction. Releasing it retains all
 * locks until the caller's COMMIT; a failed check cannot leave a usable proof. */
async function withinTransaction<T>(db:SqlClient,work:()=>Promise<T>):Promise<T>{
  try{await db.query("savepoint sc012b_trusted_source");}
  catch(error){throw normalizedError(error);}
  try{
    const result=await work();
    await db.query("release savepoint sc012b_trusted_source");
    return result;
  }catch(error){
    try{
      await db.query("rollback to savepoint sc012b_trusted_source");
      await db.query("release savepoint sc012b_trusted_source");
    }catch{/* the owning transaction must roll back if its connection failed */}
    throw normalizedError(error);
  }
}

/** Internal backend composition helper. It does not grant review/release or
 * provider authority. Current SC-010/SC-006 take candidate before screening. */
export async function lockVoiceApplicationWithinTransaction(
  db:SqlClient,companyId:string,applicationId:string,
):Promise<Readonly<{candidateId:string;actorId:string}>>{
  id(companyId);id(applicationId);
  return withinTransaction(db,async()=>{
    // Authorize the tenant before touching a candidate lock. The owner/member
    // rows are pinned and revalidated after the candidate + advisory locks.
    const initial=(await db.query([
      "select ap.candidate_id from public.applications ap",
      "join public.candidates c on c.company_id=ap.company_id and c.id=ap.candidate_id",
      "where ap.company_id=$1 and ap.id=$2",
      "and auth.uid() is not null and private.has_company_access($1,true)",
    ].join(" "),[companyId,applicationId])).rows;
    if(initial.length!==1)fail("FORBIDDEN");
    const candidateId=id(initial[0].candidate_id);
    await db.query("select private.erasure_lock_candidate($1)",[candidateId]);
    // Keep the restore decision pinned through the owning COMMIT, including
    // historical replays. The candidate guard's earlier snapshot alone cannot
    // prevent a concurrent restore switch after source validation.
    const restore=(await db.query(
      "select restore_isolated from private.erasure_execution_config where singleton for share nowait",
    )).rows;
    if(restore.length!==1||restore[0].restore_isolated!==false)fail("CONFLICT");
    for(const key of ["screening:"+applicationId,companyId+":"+applicationId]){
      const lock=only((await db.query(
        "select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired",[key])).rows);
      if(lock.acquired!==true)fail("CONFLICT");
    }
    const auth=(await db.query([
      "select c.owner_id,auth.uid() as actor from public.companies c",
      "where c.id=$1 for share nowait",
    ].join(" "),[companyId])).rows;
    if(auth.length!==1||!auth[0].actor)fail("FORBIDDEN");
    const actorId=id(auth[0].actor);
    if(actorId!==auth[0].owner_id){
      const members=(await db.query([
        "select m.role from public.company_members m",
        "where m.company_id=$1 and m.user_id=$2 for share nowait",
      ].join(" "),[companyId,actorId])).rows;
      if(members.length!==1||members[0].role!=="recruiter")fail("FORBIDDEN");
    }
    const application=(await db.query([
      "select candidate_id from public.applications where company_id=$1 and id=$2",
      "for share nowait",
    ].join(" "),[companyId,applicationId])).rows;
    if(application.length!==1||application[0].candidate_id!==candidateId)fail("STALE");
    return Object.freeze({candidateId,actorId});
  });
}

/** The caller must own a dedicated PG connection. All locks and checks are
 * inside one transaction; no input flag is trusted as an approval. */
async function reconstructLocked(
  db:SqlClient,s:SourceSelector,
):Promise<Readonly<{snapshot:VoicePlanWriteSnapshot;source:InterviewSource}>>{
  Object.values(s).forEach(id);
    const locked=await lockVoiceApplicationWithinTransaction(db,s.companyId,s.applicationId);
    const catalog=only((await db.query([
      "select version,manifest_digest from private.voice_plan_template_catalog",
      "where version=$1 and active=true for share nowait",
    ].join(" "),[ACTIVE_VOICE_TEMPLATE_VERSION])).rows);
    if(catalog.manifest_digest!==ACTIVE_VOICE_TEMPLATE_DIGEST)fail("TEMPLATE_CHANGED");
    const h=only((await db.query([
      "select ap.company_id,ap.id as application_id,ap.candidate_id,ap.updated_at as application_updated_at,",
      "ap.status as application_status,rec.id as recruitment_id,",
      "rec.updated_at as recruitment_updated_at,rec.status as recruitment_status,",
      "pos.id as position_id,pos.updated_at as position_updated_at,pos.status as position_status,",
      "pos.title,pos.tasks,pos.kpis,pos.required_behaviors,pos.required_competencies,",
      "a.id as analysis_id,a.input_fingerprint,a.analysis_contract_hash,",
      "a.candidate_document_id,a.candidate_document_version,a.binding_snapshot,",
      "a.criteria_snapshot,a.latest_review_version,a.execution_status,a.stale_at,",
      "r.id as review_id,r.review_version,r.disposition,",
      "s.id as shortlist_entry_id,s.removed_at,s.ranking_policy_version",
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
    if(h.candidate_id!==locked.candidateId)fail("STALE");
    if(!["new","in_progress"].includes(h.application_status)||
       h.recruitment_status!=="open"||h.position_status!=="active"||
       h.execution_status!=="completed"||h.stale_at!==null||h.removed_at!==null||
       !["approved","approved_with_changes"].includes(h.disposition)||
       h.latest_review_version!==h.review_version||
       !hex.test(h.input_fingerprint)||!hex.test(h.analysis_contract_hash))fail("STALE");
    // Recompute SC-006's exact canonical fingerprint from the current
    // reviewed document, criteria and binding. Return only hashes/metadata,
    // never the candidate's redacted or original CV text to this caller.
    const material=only((await db.query([
      "select m->>'input_fingerprint' as fingerprint,",
      "m->>'candidate_document_id' as document_id,",
      "(m->>'candidate_document_version')::integer as document_version,",
      "m->'criteria_snapshot' as criteria, m->'binding_snapshot' as binding",
      "from (select private.screening_material($1,true) as m) source",
    ].join(" "),[s.applicationId])).rows);
    if(material.fingerprint!==h.input_fingerprint||
       material.document_id!==h.candidate_document_id||
       material.document_version!==h.candidate_document_version||
       !isDeepStrictEqual(material.criteria,h.criteria_snapshot)||
       !isDeepStrictEqual(material.binding,h.binding_snapshot))
      fail("STALE");
    const newest=only((await db.query([
      "select id from public.screening_analysis_versions",
      "where company_id=$1 and application_id=$2",
      "order by analysis_version desc limit 1",
    ].join(" "),[s.companyId,s.applicationId])).rows);
    if(newest.id!==s.analysisId)fail("STALE");
    const pinnedPolicy=only((await db.query([
      "select version from private.screening_ranking_policies",
      "where version=$1 for share nowait",
    ].join(" "),[h.ranking_policy_version])).rows);
    if(pinnedPolicy.version!==h.ranking_policy_version)fail("STALE");
    const listed=(await db.query([
      "select ranking_policy_version,policy_current,snapshot_current",
      "from public.get_recruitment_shortlist($1,false) where entry_id=$2",
    ].join(" "),[h.recruitment_id,s.shortlistEntryId])).rows;
    if(listed.length!==1||listed[0].policy_current!==true||listed[0].snapshot_current!==true||
       listed[0].ranking_policy_version!==h.ranking_policy_version)fail("STALE");
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
    const gapInput={
      latestHumanDecision:h.disposition,analysisCompleted:true,
      analysisCurrent:true,shortlistCurrent:true,criteria:approvedCriteria,
      results,overrides,
    };
    const selected=selectReviewedScreeningGaps(gapInput,approvedCriteria);
    const gaps=pinnedClarificationGaps({criteria:approvedCriteria,results,overrides});
    if(!isDeepStrictEqual(selected,gaps))fail("TEMPLATE_CHANGED");
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
    // Reject silent generator drift in order, timing, counts and question IDs.
    try{assertPinnedVoiceQuestions(source,result.questions);}
    catch{fail("TEMPLATE_CHANGED");}
    for(const q of result.questions){
      if(q.kind==="common"){
        const allowed=template.behaviorQuestionTexts.find(x=>x.id===q.criterionId);
        if(!allowed||q.text!==allowed.firstQuestion||
           q.followUps.length!==1||q.followUps[0]!==template.commonFollowUp)
          fail("TEMPLATE_CHANGED");
      }else{
        const allowed=template.clarificationQuestionTexts[
          q.criterionKind as keyof typeof template.clarificationQuestionTexts];
        if(!allowed||q.text!==allowed||q.followUps.length!==1||
           !template.clarificationFollowUps.includes(q.followUps[0] as
             typeof template.clarificationFollowUps[number]))
          fail("TEMPLATE_CHANGED");
      }
    }
    return Object.freeze({snapshot:result,source});
}
async function withReadTransaction<T>(db:SqlClient,work:()=>Promise<T>):Promise<T>{
  // Standalone entry points own only an idle dedicated connection. A SAVEPOINT
  // reliably detects a caller transaction, even before it has allocated an XID.
  // Reject outside our rollback scope and leave failed caller transactions alone.
  let callerTransaction=false;
  try{await db.query("savepoint sc012b_source_idle_probe");callerTransaction=true;}
  catch(error){
    if(!error||typeof error!=="object"||!("code" in error)||error.code!=="25P01")
      throw normalizedError(error);
  }
  if(callerTransaction){
    try{await db.query("release savepoint sc012b_source_idle_probe");}
    catch(error){throw normalizedError(error);}
    fail("INVALID");
  }
  await db.query("begin isolation level read committed");
  try{
    const result=await work();
    await db.query("commit");
    return result;
  }catch(error){
    try{await db.query("rollback");}catch{/* connection already failed */}
    throw normalizedError(error);
  }
}
export async function reconstructTrustedVoiceSource(
  db:SqlClient,s:SourceSelector,
):Promise<VoicePlanWriteSnapshot>{
  return withReadTransaction(db,async()=>(await reconstructLocked(db,s)).snapshot);
}
async function verifyStoredLocked(db:SqlClient,planId:string){
  id(planId);
    const p=only((await db.query([
      "select company_id,application_id,analysis_id,screening_review_id,",
      "shortlist_entry_id,source_hash,envelope_hash,source_snapshot,template_version,plan_envelope,retention_deadline",
      "from public.voice_plan_versions where id=$1",
    ].join(" "),[planId])).rows);
    await lockVoiceApplicationWithinTransaction(db,p.company_id,p.application_id);
    const locked=only((await db.query([
      "select company_id,application_id,analysis_id,screening_review_id,",
      "shortlist_entry_id,source_hash,envelope_hash,source_snapshot,template_version,plan_envelope,retention_deadline",
      "from public.voice_plan_versions where id=$1 and retention_deadline>clock_timestamp() for share nowait",
    ].join(" "),[planId])).rows);
    if(!isDeepStrictEqual(locked,p))fail("STALE");
    if(p.template_version!==ACTIVE_VOICE_TEMPLATE_VERSION)fail("TEMPLATE_CHANGED");
    const rebuilt=await reconstructLocked(db,{
      companyId:p.company_id,applicationId:p.application_id,
      analysisId:p.analysis_id,reviewId:p.screening_review_id,
      shortlistEntryId:p.shortlist_entry_id,
    });
    if(p.source_hash!==rebuilt.snapshot.sourceHash||
       p.envelope_hash!==rebuilt.snapshot.planContractHash||
       !isDeepStrictEqual(p.source_snapshot,canonicalVoiceSourceSnapshot(
         rebuilt.snapshot.sourceBinding,rebuilt.snapshot.planSourceFingerprint))||
       !isDeepStrictEqual(p.plan_envelope,rebuilt.snapshot))
      fail("STALE");
    return rebuilt;
}
/** Source integrity only; no review/release or provider authority is minted.
 * The caller must use the same dedicated transaction for any subsequent write. */
export async function verifyStoredVoicePlanWithinTransaction(db:SqlClient,planId:string){
  return withinTransaction(db,async()=>(await verifyStoredLocked(db,planId)).snapshot);
}
export async function verifyStoredVoicePlan(db:SqlClient,planId:string){
  return withReadTransaction(db,()=>verifyStoredVoicePlanWithinTransaction(db,planId));
}

export type CurrentReleasedVoicePlanSelector=Readonly<{
  companyId:string;applicationId:string;
  expectedPlanId:string;expectedReleaseId:string;expectedPointerVersion:number;
}>;
export type LockedReleasedVoicePlan=Readonly<{
  planId:string;releaseId:string;pointerVersion:number;sourceHash:string;
  snapshot:VoicePlanWriteSnapshot;releasedPlan:InterviewPlan;
}>;

/**
 * OFFLINE reservation composition only, on an already-open dedicated PG
 * transaction. Reads the current pointer, not a historical replay UUID.
 * All source, candidate/freeze, authorization, plan, review and pointer locks
 * remain held through the reservation's COMMIT. No DTO can mint the release
 * brand: only reconstruction from the locked DB source passes the existing
 * build -> review -> release transitions. No live provider authorization.
 */
export async function rehydrateCurrentReleasedVoicePlanWithinTransaction(
  db:SqlClient,input:CurrentReleasedVoicePlanSelector,
):Promise<LockedReleasedVoicePlan>{
  let s:CurrentReleasedVoicePlanSelector;
  try{s=structuredClone(input);}catch{return fail("INVALID");}
  const keys=["companyId","applicationId","expectedPlanId","expectedReleaseId","expectedPointerVersion"];
  if(!s||typeof s!=="object"||Array.isArray(s)||
     Object.getPrototypeOf(s)!==Object.prototype||Reflect.ownKeys(s).length!==keys.length||
     !keys.every(key=>Object.prototype.hasOwnProperty.call(s,key))||
     !Number.isSafeInteger(s.expectedPointerVersion)||s.expectedPointerVersion<1)fail("INVALID");
  id(s.companyId);id(s.applicationId);id(s.expectedPlanId);id(s.expectedReleaseId);
  return withinTransaction(db,async()=>{
    await lockVoiceApplicationWithinTransaction(db,s.companyId,s.applicationId);
    const current=only((await db.query([
      "select c.plan_id,c.release_entry_id,c.pointer_version,p.source_hash,",
      "l.source_hash as release_source_hash,l.released_by,l.released_at,",
      "r.id as approved_review_id,r.source_hash as review_source_hash,r.decision,",
      "r.reviewer_id,r.created_at as reviewed_at",
      "from private.voice_plan_current_releases c",
      "join public.voice_plan_versions p on p.company_id=c.company_id",
      "and p.application_id=c.application_id and p.id=c.plan_id",
      "join private.voice_plan_release_entries l on l.company_id=c.company_id",
      "and l.application_id=c.application_id and l.plan_id=c.plan_id and l.id=c.release_entry_id",
      "join private.voice_plan_review_entries r on r.company_id=l.company_id",
      "and r.application_id=l.application_id and r.plan_id=l.plan_id and r.id=l.approved_review_id",
      "where c.company_id=$1 and c.application_id=$2",
      "and p.retention_deadline>clock_timestamp()",
      "and l.retention_deadline>clock_timestamp()",
      "and r.retention_deadline>clock_timestamp()",
      "and r.created_at<=l.released_at and l.released_at<=clock_timestamp()",
      "for share of c,p,l,r nowait",
    ].join(" "),[s.companyId,s.applicationId])).rows);
    const pointerVersion=Number(current.pointer_version);
    if(!Number.isSafeInteger(pointerVersion)||pointerVersion!==s.expectedPointerVersion||
       current.plan_id!==s.expectedPlanId||current.release_entry_id!==s.expectedReleaseId||
       current.decision!=="approved"||current.source_hash!==current.release_source_hash||
       current.source_hash!==current.review_source_hash)fail("STALE");
    const latestPlan=only((await db.query([
      "select id from public.voice_plan_versions where company_id=$1 and application_id=$2",
      "order by plan_version desc limit 1 for share nowait",
    ].join(" "),[s.companyId,s.applicationId])).rows);
    const latestReview=only((await db.query([
      "select id,decision from private.voice_plan_review_entries",
      "where company_id=$1 and application_id=$2 and plan_id=$3",
      "order by review_version desc limit 1 for share nowait",
    ].join(" "),[s.companyId,s.applicationId,current.plan_id])).rows);
    if(latestPlan.id!==current.plan_id||latestReview.id!==current.approved_review_id||
       latestReview.decision!=="approved")fail("STALE");
    const rebuilt=await verifyStoredLocked(db,current.plan_id);
    if(rebuilt.snapshot.sourceHash!==current.source_hash)fail("STALE");
    const generated=buildInterviewPlan(rebuilt.source);
    if(generated.sourceFingerprint!==rebuilt.snapshot.planSourceFingerprint||
       !isDeepStrictEqual(generated.questions,rebuilt.snapshot.questions))fail("STALE");
    const reviewed=reviewInterviewPlan(generated,{
      expectedRevision:1,expectedSourceFingerprint:generated.sourceFingerprint,
      reviewerId:id(current.reviewer_id),reviewedAt:iso(current.reviewed_at),
    });
    const releasedPlan=releaseInterviewPlan(reviewed,{
      expectedRevision:2,expectedSourceFingerprint:reviewed.sourceFingerprint,
      releasedBy:id(current.released_by),releasedAt:iso(current.released_at),
    });
    return Object.freeze({
      planId:current.plan_id,releaseId:current.release_entry_id,pointerVersion,
      sourceHash:rebuilt.snapshot.sourceHash,snapshot:rebuilt.snapshot,releasedPlan,
    });
  });
}
