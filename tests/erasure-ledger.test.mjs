import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,randomBytes,generateKeyPairSync,sign} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {PostgresErasureLedger,digest,parseEnvelope,decryptEnvelope,signReservationProof,verifyReplayCoverage} from '../tools/erasure/ledger.mjs';
import {createLedgerAttestor,commitReservedTransition,replayVerifiedLedger} from '../tools/erasure/runtime.mjs';

const classes=['candidate','assessment','screening','communication','audit','external','backup','exports'];
export function syntheticEnvelope(){return {contract:'sc010-r3-v1',company_id:randomUUID(),request_id:randomUUID(),generation:1,candidate_ids:[randomUUID()],scope_kind:'candidate_record',resolution_revision:0,authorized_at:'2026-01-01T00:00:00Z',policy:{revision:1,rules:classes.map(data_class=>({data_class,trigger_event:'record_created',duration_days:90,hold_review_days:30}))},authorization:{kind:'owner',actor_id:randomUUID()},manifest_hash:'a'.repeat(64),schema_signature:'b'.repeat(64),external_resources:[],phase:'authorized',sequence:1,previous_phase:null,previous_event_hash:null,retention_until:'2027-01-01T00:00:00Z'};}
const next=(e,r,phase)=>({...e,sequence:e.sequence+1,previous_phase:e.phase,previous_event_hash:r.event_hash,phase});
async function harness(){
 const db=new PGlite();await db.exec(await readFile(new URL('../tools/erasure/ledger.sql',import.meta.url),'utf8'));
 const ledgerId=randomUUID(),key=randomBytes(32),{privateKey,publicKey}=generateKeyPairSync('ed25519'),verificationKeys={v1:publicKey},encryptionKeys={v1:key};
 const reservationKeyId='reservation-v1',{privateKey:reservationPrivateKey,publicKey:reservationPublicKey}=generateKeyPairSync('ed25519'),reservationKeys={[reservationKeyId]:reservationPublicKey};
 await db.query('insert into erasure_ledger.head(singleton,ledger_id) values(true,$1)',[ledgerId]);
 const ledger=new PostgresErasureLedger({connect:async()=>({query:db.query.bind(db),end:async()=>{}}),ledgerId,encryptionKeyId:'v1',encryptionKey:key,signingKeyId:'v1',signingKey:privateKey,verificationKeys,reservationKeys});
 const reservation=e=>{const envelope_text=JSON.stringify(e),envelope_hash=digest(envelope_text);return {reservation_id:randomUUID(),envelope_text,envelope_hash,reservation_key_id:reservationKeyId,reservation_proof:signReservationProof(envelope_hash,reservationPrivateKey)};};
 const append=async r=>ledger.append({eventId:r.reservation_id,envelopeText:r.envelope_text,envelopeHash:r.envelope_hash,reservationKeyId:r.reservation_key_id,reservationProof:r.reservation_proof});
 const prove=async r=>({reservation_key_id:r.reservation_key_id,reservation_proof:r.reservation_proof});
 const records=async()=>(await db.query('select receipt,encrypted_envelope from erasure_ledger.events order by sequence')).rows;
 const coverage=async()=>{const challenge=randomUUID(),checkpoint=await ledger.checkpoint(challenge);return {records:await records(),checkpoint,challenge,ledgerId,minimumWatermark:{ledger_id:ledgerId,sequence:checkpoint.sequence,event_hash:checkpoint.head_hash},verificationKeys,encryptionKeys,reservationKeys};};
 return {db,ledger,ledgerId,verificationKeys,encryptionKeys,reservationKeys,reservationKeyId,reservationPrivateKey,reservation,append,prove,records,coverage};
}
test('SC010 R3 independent encrypted ledger and crash-safe signed attestation',async t=>{
 const h=await harness();t.after(()=>h.db.close());
 await t.test('ledger admission requires the pinned reservation proof',async()=>{
  const e=syntheticEnvelope(),text=JSON.stringify(e),envelopeHash=digest(text),eventId=randomUUID();
  await assert.rejects(h.ledger.append({eventId,envelopeText:text,envelopeHash}),/Reservation proof/);
  const other=generateKeyPairSync('ed25519'),bogus=sign(null,Buffer.from(envelopeHash),other.privateKey).toString('base64');
  await assert.rejects(h.ledger.append({eventId,envelopeText:text,envelopeHash,reservationKeyId:h.reservationKeyId,reservationProof:bogus}),/Reservation proof/);
  await assert.rejects(h.ledger.append({eventId,envelopeText:text,envelopeHash,reservationKeyId:'other-key',reservationProof:signReservationProof(envelopeHash,h.reservationPrivateKey)}),/Reservation proof/);
 });
 await t.test('unknown fields, contact payload, missing finite policy and unknown adapters fail closed',()=>{
  for(const e of [{...syntheticEnvelope(),email:'candidate@example.test'},{...syntheticEnvelope(),external_resources:['bucket/cv']},{...syntheticEnvelope(),policy:{revision:1,rules:[]}},{...syntheticEnvelope(),candidate_ids:[]},{...syntheticEnvelope(),retention_until:null}])assert.throws(()=>parseEnvelope(JSON.stringify(e)));
  const e=syntheticEnvelope();e.policy.rules[0].contact='candidate@example.test';assert.throws(()=>parseEnvelope(JSON.stringify(e)));
 });
 await t.test('ambiguous ACK retry reuses exact durable event; forged receipt never reaches DB',async()=>{
  const e=syntheticEnvelope(),r=h.reservation(e);let calls=0;
  const attest=createLedgerAttestor({ledgerId:h.ledgerId,verificationKeys:h.verificationKeys,connect:async()=>({query:async(_sql,args)=>{calls++;assert.equal(args[2],1);if(calls===1)throw new Error('Lost DB ACK');return {rows:[{result:{phase:'authorized'}}]};},end:async()=>{}})});
  await assert.rejects(commitReservedTransition({reservation:r,ledger:h.ledger,attest,prove:h.prove}),/Lost DB ACK/);
  assert.deepEqual(await commitReservedTransition({reservation:r,ledger:h.ledger,attest,prove:h.prove}),{phase:'authorized'});
  const rows=await h.records();assert.equal(rows.length,1);assert.ok(!JSON.stringify(rows).includes(e.candidate_ids[0]));
  await assert.rejects(attest(r,{...rows[0].receipt,phase:'erasing'}),/signature/);assert.equal(calls,2);
  const changed=JSON.stringify({...e,generation:2}),changedHash=digest(changed);
  await assert.rejects(h.append({...r,envelope_text:changed,envelope_hash:changedHash,reservation_proof:signReservationProof(changedHash,h.reservationPrivateKey)}),/Idempotency/);
  assert.equal(decryptEnvelope(rows[0].encrypted_envelope,h.encryptionKeys,r.envelope_hash),r.envelope_text);
  assert.throws(()=>decryptEnvelope(rows[0].encrypted_envelope,{},r.envelope_hash),/key version/);
 });
 await t.test('erasing is authoritative after crash; stale cancel and boundary expansion denied',async()=>{
  const e=syntheticEnvelope(),a=await h.append(h.reservation(e)),erasing={...next(e,a,'erasing'),manifest_hash:'d'.repeat(64)},b=await h.append(h.reservation(erasing));
  await assert.rejects(h.append(h.reservation(next(e,a,'cancelled'))),/compare-and-append/);
  await assert.rejects(h.append(h.reservation(next(erasing,b,'cancelled'))),/compare-and-append/);
  const refresh={...next(erasing,b,'erasing'),manifest_hash:'c'.repeat(64)};
  await assert.rejects(h.append(h.reservation({...refresh,candidate_ids:[...e.candidate_ids,randomUUID()].sort()})),/boundary changed/);
  const c=await h.append(h.reservation(refresh));await h.append(h.reservation(next(refresh,c,'active_data_erased')));
  assert.equal(verifyReplayCoverage(await h.coverage()).length,5);
 });
 await t.test('cancel winning stream permanently excludes erasing even after lease expiry',async()=>{
  const e=syntheticEnvelope(),a=await h.append(h.reservation(e)),cancel=next(e,a,'cancelled'),b=await h.append(h.reservation(cancel));
  await assert.rejects(h.append(h.reservation(next(e,a,'erasing'))),/compare-and-append/);
  await assert.rejects(h.append(h.reservation(next(cancel,b,'erasing'))),/compare-and-append/);
 });
 await t.test('ledger restored behind independently retained high-water mark cannot sign its way past isolation',async()=>{
  const current=await h.coverage(),old=current.records[0].receipt;
  await h.db.query('update erasure_ledger.head set sequence=1,event_hash=$1',[old.event_hash]);
  try{const challenge=randomUUID(),checkpoint=await h.ledger.checkpoint(challenge);assert.throws(()=>verifyReplayCoverage({...current,challenge,checkpoint,records:current.records.slice(0,1)}),/behind independent watermark/);}
  finally{await h.db.query('update erasure_ledger.head set sequence=$1,event_hash=$2',[current.checkpoint.sequence,current.checkpoint.head_hash]);}
 });
 await t.test('fresh restore challenges preserve the same stable SQL checkpoint on retry',async()=>{
  const initial=await h.coverage();let stored=null,calls=0;
  const connect=async()=>({query:async(_sql,args)=>{calls++;const bound={sequence:args[2],hash:args[3]};if(stored)assert.deepEqual(bound,stored);stored=bound;return {rows:[{result:true}]};},end:async()=>{}});
  const first=await replayVerifiedLedger({...initial,connect});
  const challenge=randomUUID(),checkpoint=await h.ledger.checkpoint(challenge);
  assert.notEqual(checkpoint.event_hash,initial.checkpoint.event_hash);
  const second=await replayVerifiedLedger({...initial,challenge,checkpoint,connect});
  assert.equal(first.checkpoint,second.checkpoint);assert.equal(first.checkpoint,checkpoint.head_hash);
  assert.notEqual(first.checkpointReceipt,second.checkpointReceipt);assert.equal(calls,first.replayed+second.replayed);
 });
 await t.test('fresh external watermark and full continuity verified before ANY restore write',async()=>{
  const c=await h.coverage();let connections=0;
  const connect=async()=>{connections++;return {query:async()=>({rows:[{result:true}]}),end:async()=>{}};};
  const variants=[{...c,minimumWatermark:undefined},{...c,minimumWatermark:{...c.minimumWatermark,sequence:c.minimumWatermark.sequence+1}},{...c,minimumWatermark:{...c.minimumWatermark,event_hash:'f'.repeat(64)}},{...c,records:c.records.slice(0,-1)},{...c,records:[...c.records].reverse()},{...c,challenge:randomUUID()},{...c,checkpoint:{...c.checkpoint,sequence:0}},{...c,records:c.records.map((row,i)=>i===0?{...row,encrypted_envelope:{...row.encrypted_envelope,ciphertext:'AAAA'}}:row)}];
  for(const v of variants)await assert.rejects(replayVerifiedLedger({...v,connect}));assert.equal(connections,0);
  const result=await replayVerifiedLedger({...c,connect});assert.equal(result.verifiedEvents,c.records.length);assert.equal(result.replayed,new Set(c.records.map(r=>r.receipt.request_id)).size);assert.equal(connections,1);
 });
});


test('expired envelopes require the same verified SQL scope proof; runtime never skips aged phases',async t=>{
 const h=await harness();t.after(()=>h.db.close());const expected=[];
 for(const phase of ['authorized','cancelled','erasing','active_data_erased']){
  let e={...syntheticEnvelope(),authorized_at:'2010-01-01T00:00:00Z',retention_until:'2011-01-01T00:00:00Z'},receipt=await h.append(h.reservation(e));
  const path=phase==='authorized'?[]:phase==='cancelled'?['cancelled']:phase==='erasing'?['erasing']:['erasing','active_data_erased'];
  for(const step of path){e=next(e,receipt,step);receipt=await h.append(h.reservation(e));}
  expected.push({request_id:e.request_id,phase});
 }
 const c=await h.coverage(),seen=[];
 const connect=async()=>({query:async(_sql,args)=>{const e=JSON.parse(args[0]);assert.ok(Date.parse(e.retention_until)<Date.now());seen.push({request_id:e.request_id,phase:e.phase});return {rows:[{result:{phase:e.phase,scope_absent:true,expired_noop:true,restore_isolated:true}}]};},end:async()=>{}});
 const result=await replayVerifiedLedger({...c,connect});assert.equal(result.verifiedEvents,8);assert.equal(result.replayed,4);assert.deepEqual(seen,expected);
 let calls=0;const rejected=Object.assign(new Error('Expired recovery scope still present'),{code:'PT409'});
 await assert.rejects(replayVerifiedLedger({...c,connect:async()=>({query:async()=>{calls++;throw rejected;},end:async()=>{}})}),error=>error===rejected);assert.equal(calls,1);
 let opened=0;await assert.rejects(replayVerifiedLedger({...c,records:c.records.slice(1),connect:async()=>{opened++;throw new Error('Must not connect');}}));assert.equal(opened,0);
});

function policyEnvelope(){const e=syntheticEnvelope();return {...e,authorization:{kind:'retention_policy',actor_id:randomUUID(),delegation_id:randomUUID(),activation_revision:1,policy_revision:1,due_generation:2,due_at:'2025-12-31T00:00:00Z',evidence_hash:'e'.repeat(64)}};}
test('R4 retention authorization union is exact and preserves R3 owner compatibility',()=>{
 assert.equal(parseEnvelope(JSON.stringify(syntheticEnvelope())).authorization.kind,'owner');
 assert.equal(parseEnvelope(JSON.stringify(policyEnvelope())).authorization.kind,'retention_policy');
 const variants=[{kind:'operator'},{actor_id:'invalid'},{delegation_id:'invalid'},{activation_revision:0},{policy_revision:2},{due_generation:0},{due_generation:Number.MAX_SAFE_INTEGER+1},{due_at:'invalid'},{due_at:'1'},{due_at:'2025-02-30T00:00:00Z'},{due_at:'2026-01-02T00:00:00Z'},{evidence_hash:'incorrect'},{owner_id:randomUUID()}];
 for(const change of variants){const e=policyEnvelope();e.authorization={...e.authorization,...change};assert.throws(()=>parseEnvelope(JSON.stringify(e)),/authorization/);}
 const owner=syntheticEnvelope();owner.authorization.delegation_id=randomUUID();assert.throws(()=>parseEnvelope(JSON.stringify(owner)),/authorization/);
 for(const key of Object.keys(policyEnvelope().authorization)){const e=policyEnvelope();delete e.authorization[key];assert.throws(()=>parseEnvelope(JSON.stringify(e)),/authorization/);}
});
test('R4 signed delegation boundary survives encryption/replay and cannot mutate across phases',async t=>{
 const h=await harness();t.after(()=>h.db.close());const e=policyEnvelope(),r=h.reservation(e),receipt=await h.append(r);
 const values={actor_id:randomUUID(),delegation_id:randomUUID(),activation_revision:2,policy_revision:2,due_generation:3,due_at:'2025-12-30T00:00:00Z',evidence_hash:'f'.repeat(64)};
 for(const [key,value] of Object.entries(values)){
  const changed=next(e,receipt,'erasing');changed.authorization={...e.authorization,[key]:value};if(key==='policy_revision')changed.policy={...e.policy,revision:2};
  await assert.rejects(h.append(h.reservation(changed)),/boundary changed/);
 }
 const downgraded=next(e,receipt,'erasing');downgraded.authorization={kind:'owner',actor_id:e.authorization.actor_id};await assert.rejects(h.append(h.reservation(downgraded)),/boundary changed/);
 const erasing=next(e,receipt,'erasing'),r2=await h.append(h.reservation(erasing));await h.append(h.reservation(next(erasing,r2,'active_data_erased')));
 const coverage=await h.coverage(),verified=verifyReplayCoverage(coverage);assert.equal(verified.length,3);assert.deepEqual(JSON.parse(verified[2].envelopeText).authorization,e.authorization);
 let replayed;await replayVerifiedLedger({...coverage,connect:async()=>({query:async(_sql,args)=>{replayed=JSON.parse(args[0]);return {rows:[{result:true}]};},end:async()=>{}})});assert.deepEqual(replayed.authorization,e.authorization);
 // A coordinator with no reservation attestor authority cannot create policy consent.
 const raw=JSON.stringify(policyEnvelope());await assert.rejects(h.ledger.append({eventId:randomUUID(),envelopeText:raw,envelopeHash:digest(raw)}),/Reservation proof/);
});
test('R4 health verifies fresh independent checkpoint and watermark without claiming readiness',async t=>{
 const {inspectErasureLedgerHealth}=await import('../tools/erasure/runtime.mjs');const h=await harness();t.after(()=>h.db.close());await h.append(h.reservation(policyEnvelope()));const c=await h.coverage();
 const challenges=[];const input={ledgerId:h.ledgerId,getCheckpoint:async challenge=>{challenges.push(challenge);return h.ledger.checkpoint(challenge)},getRecords:async()=>h.records(),getMinimumWatermark:async()=>c.minimumWatermark,verificationKeys:h.verificationKeys,encryptionKeys:h.encryptionKeys,reservationKeys:h.reservationKeys};
 const result=await inspectErasureLedgerHealth(input);assert.equal(result.ledger_verified,true);assert.equal(result.production_ready,false);assert.equal(result.verified_events,1);assert.deepEqual(result.blockers,['deployment_not_attested','restore_drill_required']);await inspectErasureLedgerHealth(input);assert.notEqual(challenges[0],challenges[1]);
 for(const override of [{getCheckpoint:async()=>c.checkpoint},{getMinimumWatermark:async()=>undefined},{getMinimumWatermark:async()=>({...c.minimumWatermark,sequence:2})},{getRecords:async()=>[]},{encryptionKeys:{}},{getCheckpoint:async()=>{throw Error('postgres://SECRET_CONNECTION')}}]){const bad=await inspectErasureLedgerHealth({...input,...override});assert.equal(bad.ledger_verified,false);assert.equal(bad.production_ready,false);assert.doesNotMatch(JSON.stringify(bad),/SECRET_CONNECTION/);}
 const stale=await inspectErasureLedgerHealth({...input,getMinimumWatermark:async()=>({ledger_id:h.ledgerId,sequence:0,event_hash:null})});assert.equal(stale.ledger_verified,true);assert.ok(stale.blockers.includes('checkpoint_register_behind'));
});
test('R4 scheduler is an explicit bounded tick with a dedicated role and no other mutation',async()=>{
 const {runRetentionScheduleTick}=await import('../tools/erasure/runtime.mjs');let connections=0;const queries=[];let ended=0;
 const connect=async()=>{connections++;return {query:async(sql,args)=>{queries.push([sql,args]);if(sql==='select current_user as role')return {rows:[{role:'erasure_scheduler'}]};return {rows:[{result:{processed:2,suggested:1,authorized:0,blocked:1,results:[{private_data:'NOT_RETURNED'}]}}]};},end:async()=>{ended++}}};
 for(const batchLimit of [0,-1,101,1.5,'25',NaN])await assert.rejects(runRetentionScheduleTick({connect,batchLimit}),/batch limit/);assert.equal(connections,0);
 assert.deepEqual(await runRetentionScheduleTick({connect,batchLimit:25}),{processed:2,suggested:1,authorized:0,blocked:1});assert.equal(ended,1);assert.deepEqual(queries,[['select current_user as role',undefined],['select private.tick_retention_schedule($1::integer) result',[25]]]);
 for(const role of ['postgres','service_role','erasure_worker','authenticated']){let mutations=0;await assert.rejects(runRetentionScheduleTick({connect:async()=>({query:async sql=>{if(sql!=='select current_user as role')mutations++;return {rows:[{role}]};},end:async()=>{}})}),/^Error: RETENTION_SCHEDULE_TICK_FAILED$/);assert.equal(mutations,0);}
 await assert.rejects(runRetentionScheduleTick({connect:async()=>{throw Error('postgres://DO_NOT_LEAK')}}),/^Error: RETENTION_SCHEDULE_TICK_FAILED$/);
});
test('R4 CLI has explicit bounded commands, no default execution, and sanitized failure',async()=>{
 const {runErasureCommand}=await import('../tools/erasure/cli.mjs');let loaded=0,queries=0;
 const loadConfig=async()=>{loaded++;return {schedulerConnect:async()=>({query:async sql=>{queries++;return sql==='select current_user as role'?{rows:[{role:'erasure_scheduler'}]}:{rows:[{result:{processed:0,suggested:0,authorized:0,blocked:0,results:[]}}]};},end:async()=>{}})}};
 for(const args of [[],['tick'],['drill','--config','x'],['tick','--config','x','--limit','101'],['health','--config','x','--limit','25'],['tick','--config','x','--isolated']])await assert.rejects(runErasureCommand(args,{loadConfig}));assert.equal(loaded,0);
 const result=await runErasureCommand(['tick','--config','private-config','--limit','1'],{loadConfig});assert.equal(result.execution_completed,false);assert.equal(queries,2);
 await assert.rejects(runErasureCommand(['tick','--config','private-config'],{loadConfig:async()=>{throw Error('DO_NOT_LEAK_PASSWORD')}}),/^Error: ERASURE_COMMAND_FAILED$/);
});
test('R4 explicit drill verifies independent history before isolated restore writes',async t=>{
 const {runErasureCommand}=await import('../tools/erasure/cli.mjs');const h=await harness();t.after(()=>h.db.close());const envelope=policyEnvelope();await h.append(h.reservation(envelope));const coverage=await h.coverage();let writes=0;
 const config={ledgerHealth:{ledgerId:h.ledgerId,getCheckpoint:challenge=>h.ledger.checkpoint(challenge),getRecords:()=>h.records(),getMinimumWatermark:async()=>coverage.minimumWatermark,verificationKeys:h.verificationKeys,encryptionKeys:h.encryptionKeys,reservationKeys:h.reservationKeys},restoreConnect:async()=>({query:async(sql,args)=>{writes++;assert.match(sql,/private.replay_erasure_envelope/);assert.deepEqual(JSON.parse(args[0]).authorization,envelope.authorization);return {rows:[{result:true}]};},end:async()=>{}})};
 const result=await runErasureCommand(['drill','--config','isolated-config','--isolated'],{loadConfig:async()=>config});assert.equal(writes,1);assert.equal(result.replayed,1);assert.equal(result.production_ready,false);assert.equal(result.isolation_released,false);
 config.ledgerHealth.getMinimumWatermark=async()=>({...coverage.minimumWatermark,sequence:100});await assert.rejects(runErasureCommand(['drill','--config','isolated-config','--isolated'],{loadConfig:async()=>config}),/ERASURE_COMMAND_FAILED/);assert.equal(writes,1);
});
