import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Client} from "pg";
import {parse} from "pg-connection-string";
import {setupRankingDatabase,users} from "./helpers/screening-ranking-fixture.mjs";
import {behaviorGuideDefinitions} from "../lib/behavior-guide.ts";
import {trustedVoiceTemplateDigest} from "../lib/voice/template-registry.ts";
import {reconstructTrustedVoiceSource,verifyStoredVoicePlanWithinTransaction} from "../lib/voice/trusted-source-verifier.ts";
import {atomicReviewVoicePlan,atomicReleaseVoicePlan} from "../lib/voice/atomic-plan-operations.ts";

const url=process.env.SCREENING_TEST_DATABASE_URL;
const dbName="sc012b_atomic_"+process.pid;
test("SC-012-B verified source and immutable review/release are atomic in one PG session",async t=>{
 assert.ok(url,"requires isolated PostgreSQL 16");
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
 for(const path of [
   "../db/prototypes/sc012b-plan-schema.sql",
   "../db/isolated/sc012b-template-catalog.sql",
   "../db/isolated/sc012b-review-rpc.sql",
   "../db/isolated/sc012b-release-rpc.sql",
 ]) await db.exec(await readFile(new URL(path,import.meta.url),"utf8"));
 await db.query(
  "insert into private.voice_plan_template_catalog(version,manifest_digest,active) values($1,$2,true)",
  ["skillcheck-voice-plan-v1",trustedVoiceTemplateDigest("skillcheck-voice-plan-v1")]);
 const seed=await h.seed(users.owner,randomUUID(),5);
 await h.asUser(users.owner);
 await db.query("update public.positions set required_behaviors=$1 where id=$2",
   [behaviorGuideDefinitions.map((x,i)=>x.label+": "+(i<4?"Wysoki":"Standardowy")),seed.position.id]);
 const f=await h.completedApplication(seed,["insufficient_data","meets","below","meets","above"]);
 await h.asUser(users.owner);
 const shortlist=await h.add(f);
 await h.asAdmin();
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[users.owner]);
 const selector={companyId:f.companyId,applicationId:f.application.id,
   analysisId:f.analysis_id,reviewId:f.reviewId,shortlistEntryId:shortlist};
 const canonical=await reconstructTrustedVoiceSource(db,selector);
 const plan=(await db.query([
  "insert into public.voice_plan_versions",
  "(company_id,recruitment_id,application_id,position_id,analysis_id,screening_review_id,",
  "shortlist_entry_id,plan_version,source_hash,envelope_hash,source_snapshot,plan_envelope,",
  "template_version,created_by,retention_policy_version,retention_deadline)",
  "values($1,$2,$3,$4,$5,$6,$7,1,$8,$9,'{}'::jsonb,$10::jsonb,",
  "'skillcheck-voice-plan-v1',$11,'synthetic-v1','2030-01-01') returning id"
 ].join(" "),[f.companyId,f.recruitment.id,f.application.id,f.position.id,
  f.analysis_id,f.reviewId,shortlist,canonical.sourceHash,canonical.planContractHash,
  JSON.stringify(canonical),users.owner])).rows[0].id;
 const reviewArgs={planId:plan,sourceHash:canonical.sourceHash,
   expectedReviewVersion:0,decision:"approved",reason:null,requestKey:randomUUID()};
 const review=await atomicReviewVoicePlan(db,reviewArgs);
 assert.match(review,/^[a-f0-9-]{36}$/);
 assert.equal(await atomicReviewVoicePlan(db,reviewArgs),review);
 const releaseArgs={planId:plan,sourceHash:canonical.sourceHash,approvedReviewId:review,
   expectedPointerVersion:null,expectedReleaseId:null,requestKey:randomUUID()};
 const release=await atomicReleaseVoicePlan(db,releaseArgs);
 assert.equal(await atomicReleaseVoicePlan(db,releaseArgs),release);
 const current=(await db.query(
  "select release_entry_id,pointer_version from private.voice_plan_current_releases where application_id=$1",
  [f.application.id])).rows[0];
 assert.equal(current.release_entry_id,release);
 assert.equal(Number(current.pointer_version),1);
 await t.test("source and screening advisory locks remain held through a trusted transaction",async()=>{
  const rival=new Client(config(dbName));await rival.connect();
  try{
    await db.query("begin");
    const verified=await verifyStoredVoicePlanWithinTransaction(db,plan);
    assert.equal(verified.sourceHash,canonical.sourceHash);
    await rival.query("begin");
    const lock=(await rival.query(
      "select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired",
      ["screening:"+f.application.id])).rows[0];
    assert.equal(lock.acquired,false,"SC-006 screening writer cannot pass while verified source is locked");
    await rival.query("savepoint position_lock");
    await assert.rejects(rival.query(
      "select id from public.positions where id=$1 for update nowait",[f.position.id]),
      e=>e.code==="55P03");
    await rival.query("rollback to savepoint position_lock");
    await assert.rejects(rival.query(
      "select owner_id from public.companies where id=$1 for update nowait",[f.companyId]),
      e=>e.code==="55P03");
    await rival.query("rollback");
    await db.query("rollback");
  }finally{
    await db.query("rollback").catch(()=>{});
    await rival.query("rollback").catch(()=>{});
    await rival.end();
  }
 });
 await t.test("mismatched caller source is rejected before any immutable review write",async()=>{
  const before=(await db.query(
   "select count(*)::int as n from private.voice_plan_review_entries where plan_id=$1",[plan])).rows[0].n;
  await assert.rejects(atomicReviewVoicePlan(db,{...reviewArgs,sourceHash:"f".repeat(64),requestKey:randomUUID()}),
   e=>e.code==="PT409");
  const after=(await db.query(
   "select count(*)::int as n from private.voice_plan_review_entries where plan_id=$1",[plan])).rows[0].n;
  assert.equal(after,before);
 });
 await t.test("concurrent position update yields PT409 and no partial history",async()=>{
  const rival=new Client(config(dbName));await rival.connect();
  try{
    await rival.query("begin");
    await rival.query("select id from public.positions where id=$1 for update",[f.position.id]);
    const before=(await db.query(
      "select count(*)::int as n from private.voice_plan_review_entries where plan_id=$1",
      [plan])).rows[0].n;
    await assert.rejects(atomicReviewVoicePlan(db,{
      ...reviewArgs,requestKey:randomUUID(),
    }),e=>e.code==="PT409");
    const after=(await db.query(
      "select count(*)::int as n from private.voice_plan_review_entries where plan_id=$1",
      [plan])).rows[0].n;
    assert.equal(after,before);
  }finally{
    await rival.query("rollback").catch(()=>{});
    await rival.end();
  }
 });
 await t.test("screening reanalysis advisory lock contention is a stable PT409",async()=>{
  const rival=new Client(config(dbName));await rival.connect();
  try{
    await rival.query("begin");
    await rival.query("select pg_advisory_xact_lock(hashtextextended($1,0))",
      ["screening:"+f.application.id]);
    await db.query("set lock_timeout='250ms'");
    await assert.rejects(atomicReviewVoicePlan(db,{
      ...reviewArgs,requestKey:randomUUID(),
    }),e=>e.code==="PT409");
  }finally{
    await db.query("set lock_timeout='0'").catch(()=>{});
    await rival.query("rollback").catch(()=>{});
    await rival.end();
  }
 });
 await t.test("source mutation invalidates both RPCs without side effects",async()=>{
  await db.query("update public.positions set title='Modified role' where id=$1",[f.position.id]);
  await assert.rejects(atomicReviewVoicePlan(db,{...reviewArgs,requestKey:randomUUID()}),
    e=>/VOICE_TRUSTED_SOURCE_STALE/.test(e.message));
  await assert.rejects(atomicReleaseVoicePlan(db,{...releaseArgs,requestKey:randomUUID()}),
    e=>/VOICE_TRUSTED_SOURCE_STALE/.test(e.message));
  const n=(await db.query("select count(*)::int as n from private.voice_plan_release_entries where plan_id=$1",[plan])).rows[0].n;
  assert.equal(n,1);
 });
 await t.test("matching release request can be recovered after source revision",async()=>{
  assert.equal(await atomicReleaseVoicePlan(db,releaseArgs),release);
  await assert.rejects(atomicReleaseVoicePlan(db,{
    ...releaseArgs,requestKey:randomUUID(),
  }),e=>/VOICE_TRUSTED_SOURCE_STALE/.test(e.message));
 });
 await t.test("committed release replay survives a newer plan superseding it",async()=>{
  const successor=(await db.query([
    "insert into public.voice_plan_versions",
    "(company_id,recruitment_id,application_id,position_id,analysis_id,screening_review_id,",
    "shortlist_entry_id,plan_version,source_hash,envelope_hash,source_snapshot,plan_envelope,",
    "template_version,created_by,retention_policy_version,retention_deadline,",
    "supersedes_plan_id,corrects_review_id)",
    "select company_id,recruitment_id,application_id,position_id,analysis_id,screening_review_id,",
    "shortlist_entry_id,2,$1,envelope_hash,source_snapshot,plan_envelope,",
    "template_version,created_by,retention_policy_version,retention_deadline,$2,$3",
    "from public.voice_plan_versions where id=$2 returning id",
  ].join(" "),["c".repeat(64),plan,review])).rows[0].id;
  assert.match(successor,/^[a-f0-9-]{36}$/);
  assert.equal(await atomicReviewVoicePlan(db,reviewArgs),review);
  assert.equal(await atomicReleaseVoicePlan(db,releaseArgs),release);
  const directReview=await db.query(
    "select private.sc012b_review_plan($1,$2,$3,$4,$5,$6) as id",
    [plan,0,canonical.sourceHash,"approved",null,reviewArgs.requestKey]);
  assert.equal(directReview.rows[0].id,review);
  await assert.rejects(atomicReviewVoicePlan(db,{
    ...reviewArgs,decision:"requires_changes",reason:"Inna decyzja",
  }),e=>e.code==="PT409"&&e.message==="VOICE_PLAN_REQUEST_CONFLICT");
  await assert.rejects(atomicReleaseVoicePlan(db,{
    ...releaseArgs,requestKey:randomUUID(),
  }),e=>/VOICE_TRUSTED_SOURCE_STALE/.test(e.message));
 });
 await t.test("unauthorized actor cannot replay an approved operation",async()=>{
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[users.otherOwner]);
  await assert.rejects(atomicReleaseVoicePlan(db,releaseArgs),
    e=>e.code==="42501" && e.message==="VOICE_PLAN_FORBIDDEN");
  await assert.rejects(atomicReviewVoicePlan(db,reviewArgs),
    e=>e.code==="42501" && e.message==="VOICE_PLAN_FORBIDDEN");
 });
});
