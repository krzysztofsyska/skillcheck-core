import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { setupRankingDatabase, users } from "./helpers/screening-ranking-fixture.mjs";

const schemaPath=new URL("../db/prototypes/sc012b-plan-schema.sql",import.meta.url);
const allTables=[
 ["public","voice_plan_versions"],
 ["private","voice_plan_review_entries"],
 ["private","voice_plan_release_entries"],
 ["private","voice_plan_current_releases"],
 ["private","voice_plan_request_keys"],
];
test("SC-012-B prototype creates default-deny tenant-linked immutable plan schema",async t=>{
 const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
 const h=await setupRankingDatabase(db);
 const sql=await readFile(schemaPath,"utf8");
 await db.exec(sql);
 await h.asAdmin();
 const rows=(await db.query(`
   select n.nspname as schema,c.relname as name,c.relrowsecurity as rls,
     c.relforcerowsecurity as force_rls
   from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where c.relkind='r' and c.relname like 'voice_plan_%'
   order by n.nspname,c.relname`)).rows;
 assert.equal(rows.length,5);
 for(const row of rows) { assert.equal(row.rls,true,row.name);assert.equal(row.force_rls,true,row.name); }
 for(const [ns,name] of allTables){
   const grants=(await db.query(`
     select has_table_privilege('anon',$1,'SELECT') as anon_read,
       has_table_privilege('authenticated',$1,'SELECT') as client_read,
       has_table_privilege('authenticated',$1,'INSERT') as client_write,
       has_table_privilege('authenticated',$1,'UPDATE') as client_update,
       has_table_privilege('authenticated',$1,'DELETE') as client_delete`,
       [ns+"."+name])).rows[0];
   assert.deepEqual(grants,{anon_read:false,client_read:false,client_write:false,
     client_update:false,client_delete:false},name);
 }
 const pointers=(await db.query(`
   select a.attname as column from pg_attribute a
    where a.attrelid='private.voice_plan_current_releases'::regclass
     and a.attnum>0 and not a.attisdropped
 `)).rows.map(r=>r.column);
 assert.ok(pointers.includes("pointer_version"));
 assert.ok(pointers.includes("application_id"));
 const fk=(await db.query(`
  select count(*)::int as count from pg_constraint
   where contype='f' and conrelid='public.voice_plan_versions'::regclass
 `)).rows[0].count;
 assert.ok(fk>=6,"plan must be linked to verified parent records");
 await h.asUser(users.owner);
 await assert.rejects(db.query("select * from public.voice_plan_versions"),e=>e.code==="42501");
 await assert.rejects(db.query("insert into public.voice_plan_versions default values"),e=>e.code==="42501");
 await h.asAdmin();
 const exposed=(await db.query(`
  select count(*)::int as count from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in
   ('create_voice_plan','review_voice_plan','release_voice_plan')`)).rows[0].count;
 assert.equal(exposed,0,"prototype must not expose unfinished mutation RPC");
});
