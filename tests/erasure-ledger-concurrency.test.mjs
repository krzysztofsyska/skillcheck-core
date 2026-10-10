import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,randomBytes,generateKeyPairSync} from 'node:crypto';
import {Client} from 'pg';
import {parse} from 'pg-connection-string';
import {PostgresErasureLedger,digest,verifyReplayCoverage} from '../tools/erasure/ledger.mjs';
const url=process.env.SCREENING_TEST_DATABASE_URL;
const synthetic=()=>({contract:'sc010-r3-v1',company_id:randomUUID(),request_id:randomUUID(),generation:1,candidate_ids:[randomUUID()],scope_kind:'candidate_record',resolution_revision:0,authorized_at:'2026-01-01T00:00:00Z',policy:{revision:1,rules:['candidate','assessment','screening','communication','audit','external','backup','exports'].map(data_class=>({data_class,trigger_event:'record_created',duration_days:90,hold_review_days:30}))},authorization:{kind:'owner',actor_id:randomUUID()},manifest_hash:'a'.repeat(64),schema_signature:'b'.repeat(64),external_resources:[],phase:'authorized',sequence:1,previous_phase:null,previous_event_hash:null,retention_until:'2027-01-01T00:00:00Z'});
const event=e=>{const envelopeText=JSON.stringify(e);return {eventId:randomUUID(),envelopeText,envelopeHash:digest(envelopeText)};};
test('SC010 R3 real PostgreSQL independent ledger linearizability',async t=>{
 assert.ok(url,'SCREENING_TEST_DATABASE_URL required; no simulated concurrency');
 const database=`erasure_ledger_${process.pid}`,config=name=>({...parse(url),database:name});
 const admin=new Client(config('postgres'));await admin.connect();await admin.query(`create database ${database}`);await admin.end();
 const connect=async()=>{const c=new Client(config(database));await c.connect();await c.query("set statement_timeout='10s'");return c;};
 t.after(async()=>{const c=new Client(config('postgres'));await c.connect();await c.query(`drop database ${database} with (force)`);await c.end();});
 const setup=await connect();await setup.query(await readFile(new URL('../tools/erasure/ledger.sql',import.meta.url),'utf8'));
 const ledgerId=randomUUID(),key=randomBytes(32),{privateKey,publicKey}=generateKeyPairSync('ed25519');await setup.query('insert into erasure_ledger.head(singleton,ledger_id) values(true,$1)',[ledgerId]);await setup.end();
 const ledger=new PostgresErasureLedger({connect,ledgerId,encryptionKeyId:'v1',encryptionKey:key,signingKeyId:'v1',signingKey:privateKey,verificationKeys:{v1:publicKey}});
 await t.test('same event retried concurrently has exactly one durable sequence',async()=>{
  const e=event(synthetic());const [a,b]=await Promise.all([ledger.append(e),ledger.append(e)]);assert.deepEqual(a,b);assert.equal(a.ledger_sequence,1);
 });
 await t.test('cancel and erasing competing for same previous phase have exactly one winner',async()=>{
  const e=synthetic(),a=await ledger.append(event(e)),base={...e,sequence:2,previous_phase:'authorized',previous_event_hash:a.event_hash};
  const outcomes=await Promise.allSettled([ledger.append(event({...base,phase:'cancelled'})),ledger.append(event({...base,phase:'erasing'}))]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.match(outcomes.find(x=>x.status==='rejected').reason.message,/compare-and-append conflict/);
  const winner=outcomes.find(x=>x.status==='fulfilled').value;assert.equal(winner.request_sequence,2);
  await assert.rejects(ledger.append(event({...base,phase:winner.phase==='erasing'?'cancelled':'erasing'})),/compare-and-append conflict/);
 });
 await t.test('independent requests serialize into a contiguous signed global watermark',async()=>{
  const out=await Promise.all(Array.from({length:5},()=>ledger.append(event(synthetic()))));assert.equal(new Set(out.map(r=>r.ledger_sequence)).size,5);
  const db=await connect(),records=(await db.query('select receipt,encrypted_envelope from erasure_ledger.events order by sequence')).rows;await db.end();
  const challenge=randomUUID(),checkpoint=await ledger.checkpoint(challenge);assert.equal(checkpoint.sequence,8);
  assert.equal(verifyReplayCoverage({records,checkpoint,challenge,ledgerId,minimumWatermark:{ledger_id:ledgerId,sequence:checkpoint.sequence,event_hash:checkpoint.head_hash},verificationKeys:{v1:publicKey},encryptionKeys:{v1:key}}).length,8);
 });
});
