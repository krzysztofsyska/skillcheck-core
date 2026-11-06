import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { bootMigrationDatabase, seedSyntheticPolicy } from './sc19-migration-fixture.mjs';
import { setupRankingDatabase, users } from './screening-ranking-fixture.mjs';
import { definition, hash, observations, b2Tables } from './competency-attempt-fixture.mjs';
import { retentionHarness } from './retention-scheduler-fixture.mjs';
import { setupExecutionLedger } from './erasure-execution-fixture.mjs';
export { users, definition, hash, observations, b2Tables };
export const c1Migration = '20261106063720_sc_wer_c1_inventory_r12.sql';
export const c1Sql = () => readFile(new URL(`../../supabase/migrations/${c1Migration}`, import.meta.url),'utf8');

// Native PG16/17 is mandatory in CI. An explicit local PGlite 17 path is only
// a fast development runner; it never substitutes the native concurrency gate.
export async function activeBoot(t, { install = true,fullChain=false } = {}) {
 let env;
 if (process.env.SC_WER_PGLITE_PATH) {
  const root = pathToFileURL(process.env.SC_WER_PGLITE_PATH + '/');
  const { PGlite } = await import(new URL('dist/index.js',root));
  const { pgcrypto } = await import(new URL('dist/contrib/pgcrypto.js',root));
  const db = new PGlite({ extensions: { pgcrypto } });t.after(()=>db.close());
  const ledgerDb = new PGlite();t.after(()=>ledgerDb.close());
  env = {db,ledgerDb,embedded:true};
 } else {
  env = await bootMigrationDatabase(t);
  env.ledgerDb = await env.connect(await env.createDatabase());
 }
 const { db } = env;
 for (const method of ['query','exec']) {
  const original=db[method].bind(db);
  db[method]=async(...args)=>{try{return await original(...args);}catch(error){delete error.query;delete error.params;throw error;}};
 }
 const h = await setupRankingDatabase(db,{throughMigration:install?(fullChain?null:c1Migration):'20261104120000_position_requirement_flags.sql'});
 env.h = h;
 const call = async (name,args=[],client=db) => {
  assert.match(name,/^(public|private)\.[a-z_]+$/);
  return (await client.query(`select ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args)).rows[0].result;
 };
 const asGateway = async (client=db) => {await client.exec('reset role;set role competency_test_gateway');await client.query("select set_config('request.jwt.claim.sub','',false)");};
 const tenants=new Map();let policySeeded=false;
 const seed = async ({tenant,owner=tenant?.owner??users.owner,shortlist=true}={}) => {
  tenant??=tenants.get(owner);
  const f = tenant?await h.candidate(tenant):await h.seed(owner);tenants.set(owner,f);
  await h.asAdmin();if(!policySeeded){await seedSyntheticPolicy(db);policySeeded=true;}
  await db.query('select private.sc19_grant_paid($1,$2)',[f.companyId,`synthetic-c1-${randomUUID()}`]);
  await h.asUser(owner);
  if (shortlist) {
   await h.completedApplication(f,['meets','meets','meets','meets','meets']);
   f.shortlistId = await h.add(f);
  }
  f.position.updated_at=(await db.query('select updated_at::text value from public.positions where id=$1',[f.position.id])).rows[0].value;
  f.definition=definition();
  f.definitionId=await call('public.save_exercise_definition',[f.recruitment.id,randomUUID(),JSON.stringify(f.definition),0,f.position.id,f.position.updated_at]);
  return f;
 };
 const issue = async (f,{key=randomUUID(),startBy=new Date(Date.now()+3600000).toISOString()}={}) => {
  await h.asUser(f.owner);return {...await call('public.create_competency_test_grant',[f.application.id,f.definitionId,startBy,key]),key,startBy};
 };
 const exchange=async g=>{await asGateway();return call('private.exchange_candidate_competency_test_session',[g.token]);};
 const started=async options=>{const f=await seed(options),g=await issue(f),s=await exchange(g);const a=await call('private.start_candidate_competency_test',[hash(s.session),randomUUID()]);return {f,g,s,a};};
 const submitted=async options=>{const r=await started(options);const receipt=await call('private.submit_candidate_competency_test',[hash(r.s.session),JSON.stringify({workSample:'Plan wdrożenia obejmuje terminy i komunikację.'}),randomUUID()]);return {...r,receipt};};
 const x=await setupExecutionLedger(retentionHarness(h),env.ledgerDb);
 return {...env,h,x,call,asGateway,seed,issue,exchange,started,submitted};
}
