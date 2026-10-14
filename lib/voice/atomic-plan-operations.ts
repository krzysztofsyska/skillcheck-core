/**
 * SC-012-B: isolated, trusted-server-only orchestration.
 * IMPORTANT: use a dedicated PostgreSQL connection with an authenticated
 * server-side session. NEVER call from a browser or expose credentials.
 * SQL candidates are ungranted private RPCs in a disposable test database.
 */
import {verifyStoredVoicePlanWithinTransaction,type SqlClient} from "./trusted-source-verifier.ts";

type ReviewInput=Readonly<{
  planId:string;sourceHash:string;expectedReviewVersion:number;
  decision:"approved"|"requires_changes";reason:string|null;requestKey:string;
}>;
type ReleaseInput=Readonly<{
  planId:string;sourceHash:string;approvedReviewId:string;
  expectedPointerVersion:number|null;expectedReleaseId:string|null;requestKey:string;
}>;
async function atomic<T>(db:SqlClient,run:()=>Promise<T>):Promise<T>{
  await db.query("begin");
  try{
    // All source locks acquired by the verifier remain held through the RPC.
    // No external network calls or side effects occur inside this transaction.
    const result=await run();
    await db.query("commit");
    return result;
  }catch(e){
    await db.query("rollback");
    // Expected source staleness and PostgreSQL concurrency races are conflicts,
    // never raw internal errors. Roll back before exposing the stable contract.
    if(e && typeof e==="object" && "code" in e && String(e.code)==="STALE"){
      throw Object.assign(new Error("VOICE_PLAN_SOURCE_STALE"),{code:"PT409"});
    }
    if(e && typeof e==="object" && "code" in e &&
       ["55P03","40P01","40001"].includes(String(e.code))){
      const conflict=Object.assign(new Error("VOICE_PLAN_CONFLICT"),{code:"PT409"});
      throw conflict;
    }
    throw e;
  }
}
function sameHash(actual:string,expected:string){
  if(actual!==expected){
    const e=new Error("VOICE_PLAN_SOURCE_CONFLICT");
    Object.assign(e,{code:"PT409"});
    throw e;
  }
}
/** SC-010 freeze check. Call only after actor revalidation and only when a
 * committed replay is about to return an id. The miss path must not take the
 * candidate lock before the verifier locks the position. */
async function assertCandidateNotFrozen(db:SqlClient,company:string,application:string){
  const rows=(await db.query(
    "select candidate_id from public.applications where company_id=$1 and id=$2",
    [company,application])).rows;
  if(rows.length!==1)
    throw Object.assign(new Error("VOICE_PLAN_FORBIDDEN"),{code:"42501"});
  await db.query("select private.erasure_lock_candidate($1)",[rows[0].candidate_id]);
}
/** Resolve a committed release replay under application, actor and key locks. */
async function authorizedReleaseReplay(db:SqlClient,input:ReleaseInput):Promise<string|null>{
  const plans=(await db.query(
    "select company_id,application_id from public.voice_plan_versions where id=$1",
    [input.planId])).rows;
  const deny=()=>{throw Object.assign(new Error("VOICE_PLAN_FORBIDDEN"),{code:"42501"});};
  if(plans.length!==1)deny();
  const company=plans[0].company_id,application=plans[0].application_id;
  await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))",
    ["screening:"+application]);
  await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))",
    [company+":"+application]);
  const auth=(await db.query(
    "select c.owner_id,auth.uid() as actor from public.companies c where c.id=$1 for share nowait",
    [company])).rows;
  if(auth.length!==1||!auth[0].actor)deny();
  const actor=auth[0].actor;
  if(actor!==auth[0].owner_id){
    const members=(await db.query(
      "select role from public.company_members where company_id=$1 and user_id=$2 for share nowait",
      [company,actor])).rows;
    if(members.length!==1||members[0].role!=="recruiter")deny();
  }
  await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))",
    [company+":"+actor+":release:"+input.requestKey]);
  const replay=(await db.query([
    "select k.payload_hash,k.result_id,",
    "encode(sha256(convert_to(jsonb_build_object(",
    "'plan',$1::uuid,'review',$2::uuid,'source',$3::text,",
    "'expectedPointer',$4::bigint,'expectedRelease',$5::uuid",
    ")::text,'UTF8')),'hex') as expected_hash",
    "from private.voice_plan_request_keys k",
    "where k.company_id=$6 and k.actor_id=$7 and k.operation='release'",
    "and k.request_key=$8::uuid for update nowait",
  ].join(" "),[
    input.planId,input.approvedReviewId,input.sourceHash,
    input.expectedPointerVersion,input.expectedReleaseId,company,actor,input.requestKey,
  ])).rows;
  if(replay.length===0)return null;
  if(replay.length!==1||replay[0].payload_hash!==replay[0].expected_hash||
     !replay[0].result_id)
    throw Object.assign(new Error("VOICE_PLAN_REQUEST_CONFLICT"),{code:"PT409"});
  const linked=(await db.query([
    "select 1 from private.voice_plan_release_entries",
    "where company_id=$1 and application_id=$2 and id=$3",
    "and plan_id=$4 and approved_review_id=$5 for share nowait",
  ].join(" "),[
    company,application,replay[0].result_id,input.planId,input.approvedReviewId,
  ])).rows;
  if(linked.length!==1)
    throw Object.assign(new Error("VOICE_PLAN_REQUEST_CONFLICT"),{code:"PT409"});
  await assertCandidateNotFrozen(db,company,application);
  return replay[0].result_id as string;
}

/** Resolve a committed review replay under application, actor and key locks. */
async function authorizedReviewReplay(db:SqlClient,input:ReviewInput):Promise<string|null>{
  const plans=(await db.query(
    "select company_id,application_id from public.voice_plan_versions where id=$1",
    [input.planId])).rows;
  const deny=()=>{throw Object.assign(new Error("VOICE_PLAN_FORBIDDEN"),{code:"42501"});};
  if(plans.length!==1)deny();
  const company=plans[0].company_id,application=plans[0].application_id;
  await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))",
    ["screening:"+application]);
  await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))",
    [company+":"+application]);
  const auth=(await db.query(
    "select c.owner_id,auth.uid() as actor from public.companies c where c.id=$1 for share nowait",
    [company])).rows;
  if(auth.length!==1||!auth[0].actor)deny();
  const actor=auth[0].actor;
  if(actor!==auth[0].owner_id){
    const members=(await db.query(
      "select role from public.company_members where company_id=$1 and user_id=$2 for share nowait",
      [company,actor])).rows;
    if(members.length!==1||members[0].role!=="recruiter")deny();
  }
  await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))",
    [company+":"+actor+":review:"+input.requestKey]);
  const replay=(await db.query([
    "select k.payload_hash,k.result_id,",
    "encode(sha256(convert_to(jsonb_build_object(",
    "'plan',$1::uuid,'expectedVersion',$2::bigint,'source',$3::text,'decision',$4::text,",
    "'reason',nullif(btrim($5::text, E' \\t\\n\\r\\f\\v'),''))::text,'UTF8')),'hex') as expected_hash",
    "from private.voice_plan_request_keys k",
    "where k.company_id=$6 and k.actor_id=$7 and k.operation='review'",
    "and k.request_key=$8::uuid for update nowait",
  ].join(" "),[
    input.planId,input.expectedReviewVersion,input.sourceHash,input.decision,input.reason,
    company,actor,input.requestKey,
  ])).rows;
  if(replay.length===0)return null;
  if(replay.length!==1||replay[0].payload_hash!==replay[0].expected_hash||
     !replay[0].result_id)
    throw Object.assign(new Error("VOICE_PLAN_REQUEST_CONFLICT"),{code:"PT409"});
  const linked=(await db.query([
    "select 1 from private.voice_plan_review_entries",
    "where company_id=$1 and application_id=$2 and id=$3 and plan_id=$4",
    "and source_hash=$5 and decision=$6",
    "and reason is not distinct from nullif(btrim($7::text, E' \\t\\n\\r\\f\\v'),'')",
    "for share nowait",
  ].join(" "),[
    company,application,replay[0].result_id,input.planId,input.sourceHash,
    input.decision,input.reason,
  ])).rows;
  if(linked.length!==1)
    throw Object.assign(new Error("VOICE_PLAN_REQUEST_CONFLICT"),{code:"PT409"});
  await assertCandidateNotFrozen(db,company,application);
  return replay[0].result_id as string;
}

/** This is an isolated integration contract, NOT an exposed application API. */
export async function atomicReviewVoicePlan(db:SqlClient,input:ReviewInput):Promise<string>{
  return atomic(db,async()=>{
    const prior=await authorizedReviewReplay(db,input);
    if(prior!==null)return prior;
    const source=await verifyStoredVoicePlanWithinTransaction(db,input.planId);
    sameHash(source.sourceHash,input.sourceHash);
    const result=await db.query([
      "select private.sc012b_review_plan($1,$2,$3,$4,$5,$6) as id",
    ].join(" "),[input.planId,input.expectedReviewVersion,source.sourceHash,
      input.decision,input.reason,input.requestKey]);
    if(result.rows.length!==1||typeof result.rows[0].id!=="string")
      throw Error("VOICE_PLAN_REVIEW_RESULT_INVALID");
    return result.rows[0].id;
  });
}
export async function atomicReleaseVoicePlan(db:SqlClient,input:ReleaseInput):Promise<string>{
  return atomic(db,async()=>{
    const prior=await authorizedReleaseReplay(db,input);
    if(prior!==null)return prior;
    const source=await verifyStoredVoicePlanWithinTransaction(db,input.planId);
    sameHash(source.sourceHash,input.sourceHash);
    const result=await db.query(
      "select private.sc012b_release_plan($1,$2,$3,$4,$5,$6) as id",
      [input.planId,input.approvedReviewId,source.sourceHash,
       input.expectedPointerVersion,input.expectedReleaseId,input.requestKey]);
    if(result.rows.length!==1||typeof result.rows[0].id!=="string")
      throw Error("VOICE_PLAN_RELEASE_RESULT_INVALID");
    return result.rows[0].id;
  });
}
