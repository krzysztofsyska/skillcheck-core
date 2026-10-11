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
/** This is an isolated integration contract, NOT an exposed application API. */
export async function atomicReviewVoicePlan(db:SqlClient,input:ReviewInput):Promise<string>{
  return atomic(db,async()=>{
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
