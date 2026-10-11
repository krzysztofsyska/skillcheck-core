import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Client} from "pg";
import {parse} from "pg-connection-string";
import {setupRankingDatabase,users} from "./helpers/screening-ranking-fixture.mjs";
import {behaviorGuideDefinitions} from "../lib/behavior-guide.ts";
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
 assert.equal(expected.sourceBinding.analysisId,f.analysis_id);
 assert.ok(expected.questions.every(q=>!q.text.includes("PRIVATE")));
 const plan=(await db.query([
  "insert into public.voice_plan_versions",
  "(company_id,recruitment_id,application_id,position_id,analysis_id,screening_review_id,",
  "shortlist_entry_id,plan_version,source_hash,envelope_hash,source_snapshot,plan_envelope,",
  "template_version,created_by,retention_policy_version,retention_deadline)",
  "values($1,$2,$3,$4,$5,$6,$7,1,$8,$9,'{}'::jsonb,$10::jsonb,",
  "'skillcheck-voice-plan-v1',$11,'synthetic-v1','2030-01-01') returning id"
 ].join(" "),[f.companyId,f.recruitment.id,f.application.id,f.position.id,
  f.analysis_id,f.reviewId,shortlist,expected.sourceHash,expected.planContractHash,
  JSON.stringify(expected),users.owner])).rows[0].id;
 await t.test("canonical saved envelope verifies with unchanged source",async()=>{
  const result=await verifyStoredVoicePlan(db,plan);
  assert.deepEqual(result.questions,expected.questions);
 });
 await t.test("cross-tenant user cannot reconstruct approved source",async()=>{
  await setActor(users.otherOwner);
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
 await t.test("position revision invalidates the saved plan",async()=>{
  await db.query("update public.positions set title='New analyst role' where id=$1",[f.position.id]);
  await assert.rejects(verifyStoredVoicePlan(db,plan),
    e=>e instanceof TrustedSourceError&&e.code==="STALE");
 });
});
