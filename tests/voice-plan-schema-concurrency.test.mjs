import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { parse } from "pg-connection-string";
import { setupRankingDatabase, users } from "./helpers/screening-ranking-fixture.mjs";

const url=process.env.SCREENING_TEST_DATABASE_URL;
const databaseName="sc012b_prototype_"+process.pid;
const hash=x=>x.repeat(64);

test("SC-012-B prototype enforces immutable rows and one CAS pointer across real PostgreSQL sessions",async t=>{
 assert.ok(url,"SCREENING_TEST_DATABASE_URL is required");
 const config=db=>({...parse(url),database:db});
 const maint=new Client(config("postgres"));await maint.connect();
 await maint.query("drop database if exists "+databaseName);
 await maint.query("create database "+databaseName);await maint.end();
 const clients=[];
 const connect=async()=>{
  const client=new Client(config(databaseName));await client.connect();
  client.exec=sql=>client.query(sql);clients.push(client);
  await client.query("set statement_timeout='12s'; set lock_timeout='2s'");
  return client;
 };
 t.after(async()=>{
  await Promise.all(clients.map(x=>x.end().catch(()=>{})));
  const cleanup=new Client(config("postgres"));await cleanup.connect();
  await cleanup.query("select pg_terminate_backend(pid) from pg_stat_activity where datname=$1",[databaseName]);
  await cleanup.query("drop database if exists "+databaseName);await cleanup.end();
 });
 const db=await connect(),h=await setupRankingDatabase(db);
 await db.exec(await readFile(new URL("../db/prototypes/sc012b-plan-schema.sql",import.meta.url),"utf8"));
 const f=await h.completedApplication(await h.seed(users.owner,randomUUID(),5),Array(5).fill("meets"));
 await h.asUser(users.owner);
 const shortlistId=await h.add(f);
 await h.asAdmin();
 const envelope={schemaVersion:1,language:"pl-PL",recordingAllowed:false,
  noticeRequired:true,targetSeconds:420,maximumSeconds:600,questions:[{},{},{},{}]};
 const insertPlan=[
  "insert into public.voice_plan_versions",
  "(company_id,recruitment_id,application_id,position_id,analysis_id,",
  "screening_review_id,shortlist_entry_id,plan_version,source_hash,envelope_hash,",
  "source_snapshot,plan_envelope,template_version,created_by,retention_policy_version,retention_deadline)",
  "values($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10::jsonb,$11::jsonb,",
  "'skillcheck-voice-plan-v1',$12,'synthetic-v1','2030-01-01') returning id"
 ].join(" ");
 const pid=(await db.query(insertPlan,[f.companyId,f.recruitment.id,f.application.id,
  f.position.id,f.analysis_id,f.reviewId,shortlistId,hash("a"),hash("b"),
  JSON.stringify({analysisId:f.analysis_id}),JSON.stringify(envelope),users.owner])).rows[0].id;
 const reviewId=(await db.query([
  "insert into private.voice_plan_review_entries",
  "(company_id,application_id,plan_id,review_version,reviewer_id,decision,source_hash,",
  "retention_policy_version,retention_deadline)",
  "values($1,$2,$3,1,$4,'approved',$5,'synthetic-v1','2030-01-01') returning id"
 ].join(" "),[f.companyId,f.application.id,pid,users.owner,hash("a")])).rows[0].id;
 const releaseId=(await db.query([
  "insert into private.voice_plan_release_entries",
  "(company_id,application_id,plan_id,approved_review_id,release_version,source_hash,",
  "released_by,retention_policy_version,retention_deadline)",
  "values($1,$2,$3,$4,1,$5,$6,'synthetic-v1','2030-01-01') returning id"
 ].join(" "),[f.companyId,f.application.id,pid,reviewId,hash("a"),users.owner])).rows[0].id;
 await t.test("append-only plan/review/release stay immutable even for database admin",async()=>{
  for(const [table,id] of [
   ["public.voice_plan_versions",pid],
   ["private.voice_plan_review_entries",reviewId],
   ["private.voice_plan_release_entries",releaseId]
  ]){
   await assert.rejects(db.query("delete from "+table+" where id=$1",[id]),e=>e.code==="42501");
   await assert.rejects(db.query("update "+table+" set retention_deadline='2040-01-01' where id=$1",[id]),e=>e.code==="42501");
  }
 });
 await db.query([
  "insert into private.voice_plan_current_releases",
  "(company_id,application_id,plan_id,release_entry_id,pointer_version)",
  "values($1,$2,$3,$4,1)"
 ].join(" "),[f.companyId,f.application.id,pid,releaseId]);
 await t.test("uncommitted pointer lock blocks another issuer and stale version never wins",async()=>{
  const a=await connect(),b=await connect();
  await a.query("begin");
  const changed=(await a.query([
   "update private.voice_plan_current_releases set pointer_version=2",
   "where company_id=$1 and application_id=$2 and pointer_version=1 returning pointer_version"
  ].join(" "),[f.companyId,f.application.id])).rows;
  assert.equal(changed.length,1);
  await b.query("begin");
  await assert.rejects(b.query([
   "select pointer_version from private.voice_plan_current_releases",
   "where company_id=$1 and application_id=$2 for update nowait"
  ].join(" "),[f.companyId,f.application.id]),e=>e.code==="55P03");
  await b.query("rollback");await a.query("commit");
  const stale=(await b.query([
   "update private.voice_plan_current_releases set pointer_version=3",
   "where company_id=$1 and application_id=$2 and pointer_version=1 returning pointer_version"
  ].join(" "),[f.companyId,f.application.id])).rows;
  assert.equal(stale.length,0,"future RPC must map zero-row CAS to a conflict");
  const current=(await db.query("select pointer_version from private.voice_plan_current_releases where application_id=$1",
   [f.application.id])).rows[0];
  assert.equal(Number(current.pointer_version),2);
 });
 await t.test("cross-tenant FK rejects a forged plan parent binding",async()=>{
  const other=await h.completedApplication(await h.seed(users.otherOwner,randomUUID(),5),Array(5).fill("meets"));
  await h.asAdmin();
  const args=[other.companyId,f.recruitment.id,f.application.id,f.position.id,
   f.analysis_id,f.reviewId,shortlistId,hash("a"),hash("b"),
   JSON.stringify({}),JSON.stringify(envelope),users.owner];
  await assert.rejects(db.query(insertPlan,args),e=>e.code==="23503");
 });

 await t.test("same tenant but another application analysis cannot be attached to a voice plan",async()=>{
  const other=await h.completedApplication(await h.candidate(f),Array(5).fill("meets"));
  await h.asAdmin();
  const sql=[
   "insert into public.voice_plan_versions",
   "(company_id,recruitment_id,application_id,position_id,analysis_id,",
   "screening_review_id,shortlist_entry_id,plan_version,source_hash,envelope_hash,",
   "source_snapshot,plan_envelope,template_version,created_by,retention_policy_version,retention_deadline)",
   "select company_id,recruitment_id,application_id,position_id,$1,",
   "screening_review_id,shortlist_entry_id,77,source_hash,envelope_hash,",
   "source_snapshot,plan_envelope,template_version,created_by,",
   "retention_policy_version,retention_deadline from public.voice_plan_versions where id=$2"
  ].join(" ");
  await assert.rejects(db.query(sql,[other.analysis_id,pid]),error=>error.code==="23503");
 });


 await t.test("same-company wrong-application release cannot become current",async()=>{
  const other=await h.completedApplication(await h.candidate(f),Array(5).fill("meets"));
  await h.asAdmin();
  await assert.rejects(db.query(
    "insert into private.voice_plan_current_releases(company_id,application_id,plan_id,release_entry_id,pointer_version) values($1,$2,$3,$4,1)",
    [f.companyId,other.application.id,pid,releaseId]),e=>e.code==="23503");
 });
 await t.test("correction lineage cannot cite an unrelated review or plan",async()=>{
  const other=await h.completedApplication(await h.candidate(f),Array(5).fill("meets"));
  await h.asAdmin();
  const sql=[
    "insert into public.voice_plan_versions",
    "(company_id,recruitment_id,application_id,position_id,analysis_id,",
    "screening_review_id,shortlist_entry_id,plan_version,source_hash,envelope_hash,",
    "source_snapshot,plan_envelope,template_version,created_by,",
    "retention_policy_version,retention_deadline,supersedes_plan_id,corrects_review_id)",
    "select company_id,recruitment_id,application_id,position_id,analysis_id,",
    "screening_review_id,shortlist_entry_id,78,source_hash,envelope_hash,",
    "source_snapshot,plan_envelope,template_version,created_by,",
    "retention_policy_version,retention_deadline,$1,$2",
    "from public.voice_plan_versions where id=$3"
  ].join(" ");
  await assert.rejects(db.query(sql,[other.analysis_id,reviewId,pid]),e=>e.code==="23503");
 });

});
