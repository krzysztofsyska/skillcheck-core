import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {boot, initializeVoicePreparationFixture} from './voice-preparation-fixture.mjs';
import {retentionHarness} from './retention-scheduler-fixture.mjs';
import {setupExecutionLedger} from './erasure-execution-fixture.mjs';
import {lifecycleRules} from './erasure-lifecycle-fixture.mjs';
import {syntheticRetellProof} from './voice-preparation-provider-fixture.mjs';
import {prepareOfflineVoiceDraft} from '../../lib/voice/offline-preparation.ts';

export const voiceTables=Object.freeze([
 'public.voice_plan_versions','private.voice_plan_review_entries','private.voice_plan_release_entries',
 'private.voice_plan_current_releases','private.voice_plan_request_keys','private.voice_interview_permission_receipts',
 'private.voice_interview_permission_revocations','private.sc010c_voice_preparations','private.sc010c_voice_preparation_requests',
]);
export const sharedTables=Object.freeze(['private.voice_plan_template_catalog',
 'private.voice_interview_permission_policies','private.voice_interview_permission_issuers','private.sc19_voice_entitlements']);
export async function bootRetention(t,{embedded=false,beforeIsolated,beforeRetention,afterRetention}={}) {
 let env;
 if(embedded){
  const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
  const setServerActor=async(client,actor)=>{await client.exec('reset role');await client.query("select set_config('request.jwt.claim.sub',$1,false)",[actor??'']);};
  env=await initializeVoicePreparationFixture({db,setServerActor,beforeIsolated});
 }else env=await boot(t,{beforeIsolated});
 const {db,h}=env;
 if(beforeRetention)await beforeRetention(db);
 await db.exec(await readFile(new URL('../../db/isolated/sc010-r4-voice-retention.sql',import.meta.url),'utf8'));
 const baseline=(await db.query(`select schema_signature expected,private.erasure_schema_signature() actual
  from private.erasure_inventory_baseline_r4_voice where singleton`)).rows[0];
 assert.equal(baseline.actual,baseline.expected,'Literal reviewed baseline must match the clean installed chain');
 // Forward migrations must see the canonical product schema before independent
 // ledger test adapters add their own fixture objects. Historical callers retain
 // the same verified R4-VOICE boundary when this explicit hook is absent.
 if(afterRetention)await afterRetention(db);
 let ledgerDb;
 if(embedded){ledgerDb=new PGlite();t.after(()=>ledgerDb.close());}
 else {
  // Separate synthetic ledger schema, on an independent connection. A product
  // ROLLBACK cannot roll back acknowledged ledger events.
  ledgerDb=await env.connect(null);
 }
 const x=await setupExecutionLedger(retentionHarness(h),ledgerDb);await x.configure();
 const authorize=async(subject,ids=[subject.f.candidate.id])=>{
  const f=subject.f;await h.asUser(f.owner);
  const policy=await x.getPolicy(f);if(!policy.configured)await x.policy(f,0,lifecycleRules);
  f.resolutionId=await x.resolve(f,ids);return x.freeze(f);
 };
 const prepare=async(subject,client=db,change={})=>{
  await env.actor(client,subject.f.owner);const proof=await syntheticRetellProof();
  return prepareOfflineVoiceDraft(client,subject.context,{...subject.request,...change},subject.deps(proof.retell,proof.verifiedAgent));
 };
 const erasing=async subject=>{
  const state=await authorize(subject);await x.transition(state.request_id,0,'authorized');
  await x.transition(state.request_id,1,'erasing');return state;
 };
 const count=async(table,company)=>{assert.ok([...voiceTables,...sharedTables,'public.candidates'].includes(table));await h.asAdmin();return (await db.query(`select count(*)::int n from ${table} where company_id=$1`,[company])).rows[0].n;};
 const quota=async subject=>{await h.asAdmin();return (await db.query('select * from private.sc19_voice_entitlements where company_id=$1 and id=$2',[subject.f.companyId,subject.request.entitlementId])).rows[0];};
 return {...env,x,authorize,prepare,erasing,count,quota};
}
