import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Client} from "pg";
import {parse} from "pg-connection-string";
import {setupRankingDatabase,users} from "./helpers/screening-ranking-fixture.mjs";

const url=process.env.SCREENING_TEST_DATABASE_URL;
const dbName="sc012b_review_"+process.pid;
test("SC-012-B isolated review RPC enforces human review CAS, request replay and denied writes",async t=>{
 assert.ok(url,"Real PostgreSQL 16 is required");
 const config=db=>({...parse(url),database:db});
 const m=new Client(config("postgres"));await m.connect();
 await m.query("drop database if exists "+dbName);
 await m.query("create database "+dbName);await m.end();
 const db=new Client(config(dbName));await db.connect();db.exec=s=>db.query(s);
 t.after(async()=>{
   await db.end().catch(()=>{});
   const c=new Client(config("postgres"));await c.connect();
   await c.query("select pg_terminate_backend(pid) from pg_stat_activity where datname=$1",[dbName]);
   await c.query("drop database if exists "+dbName);await c.end();
 });
 const h=await setupRankingDatabase(db);
 const schema=await readFile(new URL("../db/prototypes/sc012b-plan-schema.sql",import.meta.url),"utf8");
 const rpc=await readFile(new URL("../db/isolated/sc012b-review-rpc.sql",import.meta.url),"utf8");
 await db.exec(schema);await db.exec(rpc);
 const f=await h.completedApplication(await h.seed(users.owner,randomUUID(),5),Array(5).fill("meets"));
 await h.asUser(users.owner);
 const shortlist=await h.add(f);
 await h.asAdmin();
 const source="a".repeat(64);
 const envelope={schemaVersion:1,language:"pl-PL",recordingAllowed:false,
   noticeRequired:true,targetSeconds:420,maximumSeconds:600,questions:[{},{},{},{}]};
 const plan=(await db.query([
  "insert into public.voice_plan_versions",
  "(company_id,recruitment_id,application_id,position_id,analysis_id,screening_review_id,",
  "shortlist_entry_id,plan_version,source_hash,envelope_hash,source_snapshot,plan_envelope,",
  "template_version,created_by,retention_policy_version,retention_deadline)",
  "values($1,$2,$3,$4,$5,$6,$7,1,$8,$9,'{}'::jsonb,$10::jsonb,",
  "'skillcheck-voice-plan-v1',$11,'synthetic-v1','2030-01-01') returning id"
 ].join(" "),[f.companyId,f.recruitment.id,f.application.id,f.position.id,
  f.analysis_id,f.reviewId,shortlist,source,"b".repeat(64),JSON.stringify(envelope),users.owner])).rows[0].id;
 const call="select private.sc012b_review_plan($1,$2,$3,$4,$5,$6) as id";
 const args=(version,decision,reason,key)=>[plan,version,source,decision,reason,key];
 const setActor=async actor=>db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor||""]);
 await t.test("anonymous or cross-tenant actor denied",async()=>{
  await setActor("");
  await assert.rejects(db.query(call,args(0,"approved",null,randomUUID())),e=>e.code==="22023");
  await setActor(users.otherOwner);
  await assert.rejects(db.query(call,args(0,"approved",null,randomUUID())),e=>e.code==="42501");
 });
 await setActor(users.owner);
 const key=randomUUID();
 const first=(await db.query(call,args(0,"approved",null,key))).rows[0].id;
 assert.match(first,/^[0-9a-f-]{36}$/);
 await t.test("same idempotency key returns original result even after version increments",async()=>{
  const replay=(await db.query(call,args(0,"approved",null,key))).rows[0].id;
  assert.equal(replay,first);
  await assert.rejects(db.query(call,args(0,"requires_changes","Changed",key)),e=>e.code==="PT409");
  const count=(await db.query("select count(*)::int as n from private.voice_plan_review_entries where plan_id=$1",[plan])).rows[0].n;
  assert.equal(count,1);
 });
 await t.test("stale expected review version fails with no appended review",async()=>{
  await assert.rejects(db.query(call,args(0,"approved",null,randomUUID())),e=>e.code==="PT409");
 });
 await t.test("requires_changes demands a non-empty reason",async()=>{
  await assert.rejects(db.query(call,args(1,"requires_changes","  ",randomUUID())),e=>e.code==="22023");
  const changed=(await db.query(call,args(1,"requires_changes","Doprecyzować pytania",randomUUID()))).rows[0].id;
  assert.notEqual(changed,first);
  const rows=(await db.query("select decision,reason from private.voice_plan_review_entries where plan_id=$1 order by review_version",[plan])).rows;
  assert.deepEqual(rows.map(x=>x.decision),["approved","requires_changes"]);
 });
 await t.test("no client role can directly execute the private RPC",async()=>{
  await db.query("set role authenticated");
  await assert.rejects(db.query(call,args(2,"approved",null,randomUUID())),e=>["42501","3F000"].includes(e.code));
  await db.query("reset role");
 });
});
