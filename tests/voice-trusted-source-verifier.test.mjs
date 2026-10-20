import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Client} from "pg";
import {parse} from "pg-connection-string";
import {setupRankingDatabase,users} from "./helpers/screening-ranking-fixture.mjs";
import {behaviorGuideDefinitions} from "../lib/behavior-guide.ts";
import {getTrustedVoiceTemplate,trustedVoiceTemplateDigest} from "../lib/voice/template-registry.ts";
import {canonicalVoiceSourceSnapshot} from "../lib/voice/plan-persistence-contract.ts";
import {
  reconstructTrustedVoiceSource,verifyStoredVoicePlan,TrustedSourceError,
} from "../lib/voice/trusted-source-verifier.ts";

const url=process.env.SCREENING_TEST_DATABASE_URL;
const dbName="sc012b_source_"+process.pid;
test("SC-012-B reconstructs source from live trusted DB and rejects stale or altered plans",async t=>{
 assert.ok(url,"PostgreSQL 16 is required");
 const config=db=>({...parse(url),database:db});
 const admin=new Client(config("postgres"));await admin.connect();
 await admin.query("drop database if exists "+dbName);
 await admin.query("create database "+dbName);await admin.end();
 const db=new Client(config(dbName));await db.connect();db.exec=s=>db.query(s);
 t.after(async()=>{
  await db.end().catch(()=>{});
  const c=new Client(config("postgres"));await c.connect();
  await c.query("select pg_terminate_backend(pid) from pg_stat_activity where datname=$1",[dbName]);
  await c.query("drop database if exists "+dbName);await c.end();
 });
 const h=await setupRankingDatabase(db);
 await db.exec(await readFile(new URL("../db/prototypes/sc012b-plan-schema.sql",import.meta.url),"utf8"));
 await db.exec(await readFile(new URL("../db/isolated/sc012b-template-catalog.sql",import.meta.url),"utf8"));
 await db.query("insert into private.voice_plan_template_catalog(version,manifest_digest,active) values($1,$2,true)",
   ["skillcheck-voice-plan-v1",trustedVoiceTemplateDigest("skillcheck-voice-plan-v1")]);
 const seed=await h.seed(users.owner,randomUUID(),5);
 await h.asUser(users.owner);
 const behaviors=behaviorGuideDefinitions.map((b,i)=>b.label+": "+(i<4?"Wysoki":"Standardowy"));
 await db.query("update public.positions set required_behaviors=$1 where id=$2",
   [behaviors,seed.position.id]);
 const f=await h.completedApplication(seed,
   ["insufficient_data","meets","below","meets","above"]);
 await h.asUser(users.owner);
 const shortlist=await h.add(f);
 await h.asAdmin();
 const setActor=async actor=>db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor||""]);
 const selector={
  companyId:f.companyId,applicationId:f.application.id,analysisId:f.analysis_id,
  reviewId:f.reviewId,shortlistEntryId:shortlist,
 };
 await setActor(users.owner);
 const expected=await reconstructTrustedVoiceSource(db,selector);
 assert.equal(expected.templateVersion,"skillcheck-voice-plan-v1");
 assert.equal(expected.recordingAllowed,false);
 assert.equal(expected.noticeRequired,true);
 assert.ok(expected.questions.length>=4&&expected.questions.length<=6);
 assert.equal(expected.questions.filter(q=>q.kind==="common").length,4);
 assert.ok(expected.questions.filter(q=>q.kind==="common").every(q=>q.maxSeconds===60));
 assert.ok(expected.questions.filter(q=>q.kind==="clarification").every(q=>q.maxSeconds===45));
 assert.equal(expected.sourceBinding.analysisId,f.analysis_id);
 assert.ok(expected.questions.every(q=>!q.text.includes("PRIVATE")));
 const sourceSnapshot=canonicalVoiceSourceSnapshot(
   expected.sourceBinding,expected.planSourceFingerprint);
 const wrongHash=value=>value==="f".repeat(64)?"0".repeat(64):"f".repeat(64);
 const insertPlan=async (snapshot,envelopeHash=expected.planContractHash,sourceHash=expected.sourceHash)=>{
  const row=await db.query([
   "insert into public.voice_plan_versions",
   "(company_id,recruitment_id,application_id,position_id,analysis_id,screening_review_id,",
   "shortlist_entry_id,plan_version,source_hash,envelope_hash,source_snapshot,plan_envelope,",
   "template_version,created_by,retention_policy_version,retention_deadline)",
   "values($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10::jsonb,$11::jsonb,",
   "'skillcheck-voice-plan-v1',$12,'synthetic-v1','2030-01-01') returning id"
  ].join(" "),[f.companyId,f.recruitment.id,f.application.id,f.position.id,
   f.analysis_id,f.reviewId,shortlist,sourceHash,envelopeHash,
   JSON.stringify(snapshot),JSON.stringify(expected),users.owner]);
  return row.rows[0].id;
 };
 const replacePlan=async()=>{
  await db.query("alter table public.voice_plan_versions disable trigger voice_plan_versions_immutable");
  await db.query("delete from public.voice_plan_versions where company_id=$1 and application_id=$2",
    [f.companyId,f.application.id]);
  await db.query("alter table public.voice_plan_versions enable trigger voice_plan_versions_immutable");
 };
 await t.test("empty or overbroad source snapshot cannot verify",async()=>{
  const empty=await insertPlan({});
  await assert.rejects(verifyStoredVoicePlan(db,empty),
    e=>e instanceof TrustedSourceError&&e.code==="STALE");
  await replacePlan();
  const leaked=await insertPlan({...sourceSnapshot,cvText:"PRIVATE original CV"});
  await assert.rejects(verifyStoredVoicePlan(db,leaked),
    e=>e instanceof TrustedSourceError&&e.code==="STALE");
  await replacePlan();
  const wrongEnvelope=await insertPlan(sourceSnapshot,wrongHash(expected.planContractHash));
  await assert.rejects(verifyStoredVoicePlan(db,wrongEnvelope),
    e=>e instanceof TrustedSourceError&&e.code==="STALE");
  await replacePlan();
  const wrongSource=await insertPlan(sourceSnapshot,expected.planContractHash,wrongHash(expected.sourceHash));
  await assert.rejects(verifyStoredVoicePlan(db,wrongSource),
    e=>e instanceof TrustedSourceError&&e.code==="STALE");
  await replacePlan();
 });
 const plan=await insertPlan(sourceSnapshot);
 await t.test("canonical saved envelope verifies with unchanged source",async()=>{
  const result=await verifyStoredVoicePlan(db,plan);
  assert.deepEqual(result.questions,expected.questions);
 });
 await t.test("immutable DB template catalog prevents silent template replacement",async()=>{
  await assert.rejects(db.query(
    "update private.voice_plan_template_catalog set manifest_digest=$1 where version=$2",
    ["f".repeat(64),"skillcheck-voice-plan-v1"]),e=>e.code==="42501");
  await assert.rejects(db.query(
    "delete from private.voice_plan_template_catalog where version=$1",
    ["skillcheck-voice-plan-v1"]),e=>e.code==="42501");
 });
 await t.test("cross-tenant user cannot reconstruct approved source",async()=>{
  await setActor(users.otherOwner);
  await assert.rejects(reconstructTrustedVoiceSource(db,selector),
    e=>e instanceof TrustedSourceError&&e.code==="FORBIDDEN");
  await setActor(users.owner);
 });
 await t.test("recruiter membership is required and revocation is fail-closed",async()=>{
  await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter')",
    [f.companyId,users.recruiter]);
  await setActor(users.recruiter);
  assert.equal((await reconstructTrustedVoiceSource(db,selector)).sourceHash,expected.sourceHash);
  await setActor(users.owner);
  await db.query("delete from public.company_members where company_id=$1 and user_id=$2",
    [f.companyId,users.recruiter]);
  await setActor(users.recruiter);
  await assert.rejects(reconstructTrustedVoiceSource(db,selector),
    e=>e instanceof TrustedSourceError&&e.code==="FORBIDDEN");
  await setActor(users.owner);
 });
 await t.test("tampered saved source hash cannot grant authority",async()=>{
  await assert.rejects(verifyStoredVoicePlan(db,randomUUID()),
    e=>e instanceof TrustedSourceError&&e.code==="STALE");
  // Even a forged browser-supplied snapshot is not an input to the verifier.
  const fake={...selector,reviewId:randomUUID()};
  await assert.rejects(reconstructTrustedVoiceSource(db,fake),
    e=>e instanceof TrustedSourceError&&e.code==="STALE");
 });
 await t.test("obsolete ranking policy invalidates an otherwise active shortlist",async()=>{
  await db.query(`insert into private.screening_ranking_policies
    (version,min_coverage,below_points,meets_points,above_points,min_target_size,max_target_size,default_target_size)
    values ('screening-ranking-v2',0.60,0,60,100,5,10,10)`);
  const original=(await db.query(`select pg_get_functiondef(p.oid) as definition from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='get_recruitment_shortlist'`)).rows[0].definition;
  assert.match(original,/screening-ranking-v1/);
  await db.query(original.replaceAll("screening-ranking-v1","screening-ranking-v2"));
  await assert.rejects(reconstructTrustedVoiceSource(db,selector),
    e=>e instanceof TrustedSourceError&&e.code==="STALE");
  await assert.rejects(verifyStoredVoicePlan(db,plan),
    e=>e instanceof TrustedSourceError&&e.code==="STALE");
  await db.query(original);
  assert.equal((await reconstructTrustedVoiceSource(db,selector)).sourceHash,expected.sourceHash);
 });
 await t.test("row lock contention returns a domain conflict",async()=>{
  const other=new Client(config(dbName));
  await other.connect();
  try{
   await other.query("begin");
   await other.query("select id from public.companies where id=$1 for update",[f.companyId]);
   await assert.rejects(reconstructTrustedVoiceSource(db,selector),
     e=>e instanceof TrustedSourceError&&e.code==="CONFLICT");
  }finally{
   await other.query("rollback");
   await other.end();
  }
  assert.equal((await reconstructTrustedVoiceSource(db,selector)).sourceHash,expected.sourceHash);
 });
 await t.test("SC-006 reanalysis advisory lock serializes both trusted-source preflights",async()=>{
  const writer=new Client(config(dbName));
  await writer.connect();
  try{
   await writer.query("begin");
   await writer.query("select pg_advisory_xact_lock(hashtextextended($1,0))",
     ["screening:"+selector.applicationId]);
   // The verifier must never bypass an in-flight SC-006 source change.
   // PostgreSQL lock_timeout maps to a domain conflict, not an internal error.
   await db.query("set lock_timeout='250ms'");
   for(const preflight of [
     ()=>reconstructTrustedVoiceSource(db,selector),
     ()=>verifyStoredVoicePlan(db,plan),
   ]) await assert.rejects(preflight(),
     e=>e instanceof TrustedSourceError&&e.code==="CONFLICT");
  }finally{
   await db.query("set lock_timeout='0'").catch(()=>{});
   await writer.query("rollback").catch(()=>{});
   await writer.end();
  }
  // Once the writer commits/rolls back, no stale lock state is carried over.
  assert.equal((await reconstructTrustedVoiceSource(db,selector)).sourceHash,expected.sourceHash);
  assert.equal((await verifyStoredVoicePlan(db,plan)).sourceHash,expected.sourceHash);
 });
 await t.test("position revision invalidates the saved plan",async()=>{
  await db.query("update public.positions set title='New analyst role' where id=$1",[f.position.id]);
  await assert.rejects(verifyStoredVoicePlan(db,plan),
    e=>e instanceof TrustedSourceError&&e.code==="STALE");
 });
});

test("SC-012-B SQLSTATE conflicts are mapped after transaction rollback",async()=>{
 // Isolated fake PG client: these concurrency errors must never leak raw
 // database-driver errors to either trusted-source preflight.
 const companyId=randomUUID(),applicationId=randomUUID(),planId=randomUUID();
 const selector={companyId,applicationId,analysisId:randomUUID(),
   reviewId:randomUUID(),shortlistEntryId:randomUUID()};
 for(const code of ["55P03","40P01","40001"]){
  for(const operation of ["reconstruct","verify"]){
   const calls=[];
   const mock={
    async query(sql){
     calls.push(sql);
     if(sql==="begin"||sql==="rollback")return {rows:[]};
     if(sql.includes("from public.voice_plan_versions where id=$1")&&
        !sql.includes("for share nowait"))
       return {rows:[{company_id:companyId,application_id:applicationId}]};
     if(sql.includes("pg_advisory_xact_lock"))
       throw Object.assign(new Error("synthetic driver detail, must not leak"),{code});
     throw Error("unexpected query in synthetic conflict test: "+sql);
    },
   };
   const run=operation==="reconstruct"
    ? reconstructTrustedVoiceSource(mock,selector)
    : verifyStoredVoicePlan(mock,planId);
   await assert.rejects(run,e=>
    e instanceof TrustedSourceError &&
    e.code==="CONFLICT" &&
    e.message==="VOICE_TRUSTED_SOURCE_CONFLICT");
   assert.equal(calls[0],"begin");
   assert.equal(calls.at(-1),"rollback");
   assert.ok(!calls.includes("commit"),"failed source preflight must not commit");
  }
 }
});

test("SC-012-B template registry only permits explicitly versioned, pinned templates",()=>{
 const template=getTrustedVoiceTemplate("skillcheck-voice-plan-v1");
 assert.equal(template.recordingAllowed,false);
 assert.equal(template.questionRules.commonCount,4);
 assert.equal(template.questionRules.commonMaxSeconds,60);
 assert.equal(template.questionRules.clarificationMaxSeconds,45);
 assert.equal(template.questionRules.maxClarificationCount,2);
 assert.equal(template.behaviorLevelRank.Wysoki,3);
 assert.deepEqual(template.clarificationFollowUpByReason,{
   contradiction:0,missing_evidence:1,scope_unverified:1,
 });
 assert.match(trustedVoiceTemplateDigest("skillcheck-voice-plan-v1"),/^[a-f0-9]{64}$/);
 assert.throws(()=>getTrustedVoiceTemplate("skillcheck-voice-plan-v2"),/VOICE_TEMPLATE_UNSUPPORTED/);
 assert.ok(Object.isFrozen(template));
});
