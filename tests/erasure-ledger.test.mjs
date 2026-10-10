import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,randomBytes,generateKeyPairSync} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {PostgresErasureLedger,digest,parseEnvelope,decryptEnvelope,verifyReplayCoverage} from '../tools/erasure/ledger.mjs';
import {createLedgerAttestor,commitReservedTransition,replayVerifiedLedger} from '../tools/erasure/runtime.mjs';

const classes=['candidate','assessment','screening','communication','audit','external','backup','exports'];
export function syntheticEnvelope(){return {contract:'sc010-r3-v1',company_id:randomUUID(),request_id:randomUUID(),generation:1,candidate_ids:[randomUUID()],scope_kind:'candidate_record',resolution_revision:0,authorized_at:'2026-01-01T00:00:00Z',policy:{revision:1,rules:classes.map(data_class=>({data_class,trigger_event:'record_created',duration_days:90,hold_review_days:30}))},authorization:{kind:'owner',actor_id:randomUUID()},manifest_hash:'a'.repeat(64),schema_signature:'b'.repeat(64),external_resources:[],phase:'authorized',sequence:1,previous_phase:null,previous_event_hash:null,retention_until:'2027-01-01T00:00:00Z'};}
const reservation=e=>{const envelope_text=JSON.stringify(e);return {reservation_id:randomUUID(),envelope_text,envelope_hash:digest(envelope_text)};};
const next=(e,r,phase)=>({...e,sequence:e.sequence+1,previous_phase:e.phase,previous_event_hash:r.event_hash,phase});
async function harness(){
 const db=new PGlite();await db.exec(await readFile(new URL('../tools/erasure/ledger.sql',import.meta.url),'utf8'));
 const ledgerId=randomUUID(),key=randomBytes(32),{privateKey,publicKey}=generateKeyPairSync('ed25519'),verificationKeys={v1:publicKey},encryptionKeys={v1:key};
 await db.query('insert into erasure_ledger.head(singleton,ledger_id) values(true,$1)',[ledgerId]);
 const ledger=new PostgresErasureLedger({connect:async()=>({query:db.query.bind(db),end:async()=>{}}),ledgerId,encryptionKeyId:'v1',encryptionKey:key,signingKeyId:'v1',signingKey:privateKey,verificationKeys});
 const append=async r=>ledger.append({eventId:r.reservation_id,envelopeText:r.envelope_text,envelopeHash:r.envelope_hash});
 const records=async()=>(await db.query('select receipt,encrypted_envelope from erasure_ledger.events order by sequence')).rows;
 const coverage=async()=>{const challenge=randomUUID(),checkpoint=await ledger.checkpoint(challenge);return {records:await records(),checkpoint,challenge,ledgerId,minimumWatermark:{ledger_id:ledgerId,sequence:checkpoint.sequence,event_hash:checkpoint.head_hash},verificationKeys,encryptionKeys};};
 return {db,ledger,ledgerId,verificationKeys,encryptionKeys,append,records,coverage};
}
test('SC010 R3 independent encrypted ledger and crash-safe signed attestation',async t=>{
 const h=await harness();t.after(()=>h.db.close());
 await t.test('unknown fields, contact payload, missing finite policy and unknown adapters fail closed',()=>{
  for(const e of [{...syntheticEnvelope(),email:'candidate@example.test'},{...syntheticEnvelope(),external_resources:['bucket/cv']},{...syntheticEnvelope(),policy:{revision:1,rules:[]}},{...syntheticEnvelope(),candidate_ids:[]},{...syntheticEnvelope(),retention_until:null}])assert.throws(()=>parseEnvelope(JSON.stringify(e)));
  const e=syntheticEnvelope();e.policy.rules[0].contact='candidate@example.test';assert.throws(()=>parseEnvelope(JSON.stringify(e)));
 });
 await t.test('ambiguous ACK retry reuses exact durable event; forged receipt never reaches DB',async()=>{
  const e=syntheticEnvelope(),r=reservation(e);let calls=0;
  const attest=createLedgerAttestor({ledgerId:h.ledgerId,verificationKeys:h.verificationKeys,connect:async()=>({query:async(_sql,args)=>{calls++;assert.equal(args[2],1);if(calls===1)throw new Error('Lost DB ACK');return {rows:[{result:{phase:'authorized'}}]};},end:async()=>{}})});
  await assert.rejects(commitReservedTransition({reservation:r,ledger:h.ledger,attest}),/Lost DB ACK/);
  assert.deepEqual(await commitReservedTransition({reservation:r,ledger:h.ledger,attest}),{phase:'authorized'});
  const rows=await h.records();assert.equal(rows.length,1);assert.ok(!JSON.stringify(rows).includes(e.candidate_ids[0]));
  await assert.rejects(attest(r,{...rows[0].receipt,phase:'erasing'}),/signature/);assert.equal(calls,2);
  await assert.rejects(h.append({...r,envelope_text:JSON.stringify({...e,generation:2}),envelope_hash:digest(JSON.stringify({...e,generation:2}))}),/Idempotency/);
  assert.equal(decryptEnvelope(rows[0].encrypted_envelope,h.encryptionKeys,r.envelope_hash),r.envelope_text);
  assert.throws(()=>decryptEnvelope(rows[0].encrypted_envelope,{},r.envelope_hash),/key version/);
 });
 await t.test('erasing is authoritative after crash; stale cancel and boundary expansion denied',async()=>{
  const e=syntheticEnvelope(),a=await h.append(reservation(e)),erasing={...next(e,a,'erasing'),manifest_hash:'d'.repeat(64)},b=await h.append(reservation(erasing));
  await assert.rejects(h.append(reservation(next(e,a,'cancelled'))),/compare-and-append/);
  await assert.rejects(h.append(reservation(next(erasing,b,'cancelled'))),/compare-and-append/);
  const refresh={...next(erasing,b,'erasing'),manifest_hash:'c'.repeat(64)};
  await assert.rejects(h.append(reservation({...refresh,candidate_ids:[...e.candidate_ids,randomUUID()].sort()})),/boundary changed/);
  const c=await h.append(reservation(refresh));await h.append(reservation(next(refresh,c,'active_data_erased')));
  assert.equal(verifyReplayCoverage(await h.coverage()).length,5);
 });
 await t.test('cancel winning stream permanently excludes erasing even after lease expiry',async()=>{
  const e=syntheticEnvelope(),a=await h.append(reservation(e)),cancel=next(e,a,'cancelled'),b=await h.append(reservation(cancel));
  await assert.rejects(h.append(reservation(next(e,a,'erasing'))),/compare-and-append/);
  await assert.rejects(h.append(reservation(next(cancel,b,'erasing'))),/compare-and-append/);
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
  let e={...syntheticEnvelope(),authorized_at:'2010-01-01T00:00:00Z',retention_until:'2011-01-01T00:00:00Z'},receipt=await h.append(reservation(e));
  const path=phase==='authorized'?[]:phase==='cancelled'?['cancelled']:phase==='erasing'?['erasing']:['erasing','active_data_erased'];
  for(const step of path){e=next(e,receipt,step);receipt=await h.append(reservation(e));}
  expected.push({request_id:e.request_id,phase});
 }
 const c=await h.coverage(),seen=[];
 const connect=async()=>({query:async(_sql,args)=>{const e=JSON.parse(args[0]);assert.ok(Date.parse(e.retention_until)<Date.now());seen.push({request_id:e.request_id,phase:e.phase});return {rows:[{result:{phase:e.phase,scope_absent:true,expired_noop:true,restore_isolated:true}}]};},end:async()=>{}});
 const result=await replayVerifiedLedger({...c,connect});assert.equal(result.verifiedEvents,8);assert.equal(result.replayed,4);assert.deepEqual(seen,expected);
 let calls=0;const rejected=Object.assign(new Error('Expired recovery scope still present'),{code:'PT409'});
 await assert.rejects(replayVerifiedLedger({...c,connect:async()=>({query:async()=>{calls++;throw rejected;},end:async()=>{}})}),error=>error===rejected);assert.equal(calls,1);
 let opened=0;await assert.rejects(replayVerifiedLedger({...c,records:c.records.slice(1),connect:async()=>{opened++;throw new Error('Must not connect');}}));assert.equal(opened,0);
});
