import {createHash,createCipheriv,createDecipheriv,randomBytes,sign,verify} from 'node:crypto';

const phases={authorized:['cancelled','erasing'],erasing:['erasing','active_data_erased'],cancelled:[],active_data_erased:[]};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash=/^[0-9a-f]{64}$/;
const fields=['contract','company_id','request_id','generation','candidate_ids','scope_kind','resolution_revision','authorized_at','policy','authorization','manifest_hash','schema_signature','external_resources','phase','sequence','previous_phase','previous_event_hash','retention_until'];
export const digest=text=>createHash('sha256').update(text,'utf8').digest('hex');
const canonical=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0)):v);
const fail=message=>{throw new Error(message);};
const positive=n=>Number.isSafeInteger(n)&&n>0;
export function parseEnvelope(text){
 if(typeof text!=='string'||Buffer.byteLength(text)>1048576)fail('Invalid envelope size');
 const e=JSON.parse(text);
 if(!e||Array.isArray(e)||Object.keys(e).sort().join()!==[...fields].sort().join())fail('Unknown envelope contract');
 if(e.contract!=='sc010-r3-v1'||!uuid.test(e.company_id)||!uuid.test(e.request_id)||!positive(e.generation)||!positive(e.sequence))fail('Invalid envelope identity');
 if(!Array.isArray(e.candidate_ids)||!e.candidate_ids.length||e.candidate_ids.some(x=>!uuid.test(x))||[...new Set(e.candidate_ids)].sort().join()!==e.candidate_ids.join())fail('Invalid candidate boundary');
 if(!['candidate_record','confirmed_subject'].includes(e.scope_kind)||!Object.hasOwn(phases,e.phase)||!(e.previous_phase===null||Object.hasOwn(phases,e.previous_phase)))fail('Invalid envelope phase/scope');
 if(!(e.previous_event_hash===null||hash.test(e.previous_event_hash))||!hash.test(e.manifest_hash)||!hash.test(e.schema_signature))fail('Invalid envelope digest');
 if(!e.authorization||Object.keys(e.authorization).sort().join()!=='actor_id,kind'||e.authorization.kind!=='owner'||!uuid.test(e.authorization.actor_id))fail('Invalid authorization');
 if(!e.policy||Object.keys(e.policy).sort().join()!=='revision,rules'||!positive(e.policy.revision)||!Array.isArray(e.policy.rules)||e.policy.rules.length!==8)fail('Missing policy definition');
 const classes=new Set();for(const r of e.policy.rules){
  if(!r||Object.keys(r).sort().join()!=='data_class,duration_days,hold_review_days,trigger_event'||!['candidate','assessment','screening','communication','audit','external','backup','exports'].includes(r.data_class)||classes.has(r.data_class)||!['record_created','process_closed','consent_revoked'].includes(r.trigger_event)||!positive(r.duration_days)||r.duration_days>999999||!positive(r.hold_review_days)||r.hold_review_days>999999)fail('Invalid policy definition');classes.add(r.data_class);
 }
 if(!(e.scope_kind==='confirmed_subject'?positive(e.resolution_revision):(e.resolution_revision===null||e.resolution_revision===0))||!Number.isFinite(Date.parse(e.authorized_at))||!Number.isFinite(Date.parse(e.retention_until))||Date.parse(e.retention_until)<=Date.parse(e.authorized_at))fail('Invalid retention boundary');
 if(!Array.isArray(e.external_resources)||e.external_resources.length)fail('External resource adapter not installed');
 return e;
}
function encrypt(text,keyId,key,aad){
 if(!Buffer.isBuffer(key)||key.length!==32)fail('AES-256 key required');
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(aad));
 return {key_id:keyId,iv:iv.toString('base64'),ciphertext:Buffer.concat([cipher.update(text,'utf8'),cipher.final()]).toString('base64'),tag:cipher.getAuthTag().toString('base64')};
}
export function decryptEnvelope(encrypted,keyring,envelopeHash){
 const key=keyring[encrypted.key_id];if(!key)fail('Unknown encryption key version');
 const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(encrypted.iv,'base64'));cipher.setAAD(Buffer.from(envelopeHash));cipher.setAuthTag(Buffer.from(encrypted.tag,'base64'));
 const text=Buffer.concat([cipher.update(Buffer.from(encrypted.ciphertext,'base64')),cipher.final()]).toString('utf8');
 if(digest(text)!==envelopeHash)fail('Envelope hash mismatch');parseEnvelope(text);return text;
}
function signed(body,keyId,key){const event_hash=digest(canonical(body));return {...body,event_hash,key_id:keyId,signature:sign(null,Buffer.from(event_hash),key).toString('base64')};}
export function verifyReceipt(receipt,keyring){
 const {event_hash,key_id,signature,...body}=receipt;
 if(!keyring[key_id]||digest(canonical(body))!==event_hash||!verify(null,Buffer.from(event_hash),keyring[key_id],Buffer.from(signature,'base64')))fail('Invalid ledger signature');
 if(body.kind!=='erasure_event'||!positive(body.ledger_sequence)||!positive(body.request_sequence)||!hash.test(body.envelope_hash)||!uuid.test(body.ledger_id)||!uuid.test(body.event_id)||!uuid.test(body.request_id))fail('Invalid receipt');
 return receipt;
}
/** Connection factory must return a dedicated, connected pg-compatible client.
 * Never pass a product DB connection or share this identity with a worker. */
export class PostgresErasureLedger{
 constructor({connect,ledgerId,encryptionKeyId,encryptionKey,signingKeyId,signingKey,verificationKeys}){Object.assign(this,{connect,ledgerId,encryptionKeyId,encryptionKey,signingKeyId,signingKey,verificationKeys});if(!uuid.test(ledgerId))fail('Ledger deployment identity required');}
 async append({eventId,envelopeText,envelopeHash}){
  const e=parseEnvelope(envelopeText);if(!uuid.test(eventId)||digest(envelopeText)!==envelopeHash)fail('Envelope binding mismatch');
  const db=await this.connect();
  try{
   await db.query('begin');
   await db.query("set local synchronous_commit='on'");
   const head=(await db.query('select * from erasure_ledger.head where singleton=true for update')).rows[0];
   if(!head||head.ledger_id!==this.ledgerId)fail('Wrong ledger database');
   const retry=(await db.query('select receipt,envelope_hash from erasure_ledger.events where event_id=$1',[eventId])).rows[0];
   if(retry){if(retry.envelope_hash!==envelopeHash)fail('Idempotency key conflict');verifyReceipt(retry.receipt,this.verificationKeys);if(retry.receipt.ledger_id!==this.ledgerId||retry.receipt.event_id!==eventId||retry.receipt.envelope_hash!==envelopeHash)fail('Wrong ledger retry');await db.query('commit');return retry.receipt;}
   const previous=(await db.query('select receipt from erasure_ledger.events where request_id=$1 order by request_sequence desc limit 1',[e.request_id])).rows[0]?.receipt;
   if(previous){verifyReceipt(previous,this.verificationKeys);if(previous.ledger_id!==this.ledgerId||previous.request_id!==e.request_id)fail('Wrong ledger stream');}
   if(previous?(e.sequence!==previous.request_sequence+1||e.previous_event_hash!==previous.event_hash||e.previous_phase!==previous.phase||e.generation!==previous.generation||e.company_id!==previous.company_id||!phases[previous.phase].includes(e.phase)):(e.sequence!==1||e.previous_phase!==null||e.previous_event_hash!==null||e.phase!=='authorized'))fail('Ledger compare-and-append conflict');
   // Every transition preserves the signed subject/policy boundary, independently
   // of the mutable product database and its local lease expiration.
   const boundary_hash=digest(canonical(Object.fromEntries(Object.entries(e).filter(([k])=>!['phase','sequence','previous_phase','previous_event_hash','manifest_hash'].includes(k)))));
   if(previous&&(previous.boundary_hash!==boundary_hash||(!(['authorized','erasing'].includes(previous.phase)&&e.phase==='erasing')&&previous.manifest_hash!==e.manifest_hash)))fail('Recovery boundary changed');
   const sequence=Number(head.sequence)+1;if(!positive(sequence))fail('Ledger sequence overflow');
   const receipt=signed({kind:'erasure_event',ledger_id:this.ledgerId,ledger_sequence:sequence,previous_ledger_hash:head.event_hash,event_id:eventId,request_id:e.request_id,company_id:e.company_id,generation:e.generation,request_sequence:e.sequence,previous_event_hash:e.previous_event_hash,phase:e.phase,envelope_hash:envelopeHash,boundary_hash,manifest_hash:e.manifest_hash},this.signingKeyId,this.signingKey);
   verifyReceipt(receipt,this.verificationKeys);
   const encrypted=encrypt(envelopeText,this.encryptionKeyId,this.encryptionKey,envelopeHash);
   await db.query('insert into erasure_ledger.events(sequence,event_id,request_id,request_sequence,envelope_hash,encrypted_envelope,receipt) values($1,$2,$3,$4,$5,$6,$7)',[sequence,eventId,e.request_id,e.sequence,envelopeHash,encrypted,receipt]);
   await db.query('update erasure_ledger.head set sequence=$1,event_hash=$2 where singleton=true',[sequence,receipt.event_hash]);
   await db.query('commit');return receipt;
  }catch(error){await db.query('rollback').catch(()=>{});throw error;}finally{await db.end();}
 }
 async checkpoint(challenge){
  if(!uuid.test(challenge))fail('Fresh checkpoint challenge required');
  const db=await this.connect();try{const h=(await db.query('select * from erasure_ledger.head where singleton=true')).rows[0];if(!h||h.ledger_id!==this.ledgerId)fail('Wrong ledger database');return signed({kind:'erasure_checkpoint',ledger_id:this.ledgerId,sequence:Number(h.sequence),head_hash:h.event_hash,challenge},this.signingKeyId,this.signingKey);}finally{await db.end();}
 }
}
/** The challenge is generated by the isolated restore operator for this restore,
 * obtained from the live independent ledger, never from the product backup. */
export function verifyReplayCoverage({records,checkpoint,challenge,ledgerId,minimumWatermark,verificationKeys,encryptionKeys}){
 const {event_hash,key_id,signature,...body}=checkpoint;
 if(!minimumWatermark||minimumWatermark.ledger_id!==ledgerId||!Number.isSafeInteger(minimumWatermark.sequence)||minimumWatermark.sequence<0||(minimumWatermark.sequence===0?minimumWatermark.event_hash!==null:!hash.test(minimumWatermark.event_hash)))fail('Independent minimum watermark required');
 if(body.sequence<minimumWatermark.sequence)fail('Ledger behind independent watermark');
 if(body.kind!=='erasure_checkpoint'||body.challenge!==challenge||body.ledger_id!==ledgerId||!verificationKeys[key_id]||digest(canonical(body))!==event_hash||!verify(null,Buffer.from(event_hash),verificationKeys[key_id],Buffer.from(signature,'base64')))fail('Untrusted restore checkpoint');
 if(!Number.isSafeInteger(body.sequence)||body.sequence<0||records.length!==body.sequence)fail('Incomplete ledger coverage');
 let last=null;const streams=new Map(),verified=[];
 for(let i=0;i<records.length;i++){
  const {receipt,encrypted_envelope}=records[i];verifyReceipt(receipt,verificationKeys);
  if(receipt.ledger_id!==ledgerId||receipt.ledger_sequence!==i+1||receipt.previous_ledger_hash!==last)fail('Ledger continuity gap');
  const text=decryptEnvelope(encrypted_envelope,encryptionKeys,receipt.envelope_hash),e=parseEnvelope(text),previous=streams.get(e.request_id);
  if(e.request_id!==receipt.request_id||e.company_id!==receipt.company_id||e.sequence!==receipt.request_sequence||e.generation!==receipt.generation||e.phase!==receipt.phase||e.manifest_hash!==receipt.manifest_hash||e.previous_event_hash!==receipt.previous_event_hash)fail('Receipt envelope mismatch');
  const boundary=digest(canonical(Object.fromEntries(Object.entries(e).filter(([k])=>!['phase','sequence','previous_phase','previous_event_hash','manifest_hash'].includes(k)))));
  if(boundary!==receipt.boundary_hash||(previous?(e.sequence!==previous.sequence+1||e.previous_event_hash!==previous.event_hash||e.previous_phase!==previous.phase||receipt.boundary_hash!==previous.boundary_hash||(!(['authorized','erasing'].includes(previous.phase)&&e.phase==='erasing')&&previous.manifest_hash!==e.manifest_hash)||!phases[previous.phase].includes(e.phase)):(e.sequence!==1||e.phase!=='authorized'||e.previous_event_hash!==null||e.previous_phase!==null)))fail('Request continuity gap');
  streams.set(e.request_id,{sequence:e.sequence,event_hash:receipt.event_hash,phase:e.phase,boundary_hash:receipt.boundary_hash,manifest_hash:e.manifest_hash});last=receipt.event_hash;verified.push({envelopeText:text,receipt});
 }
 if(last!==body.head_hash)fail('Checkpoint watermark mismatch');
 if(minimumWatermark.sequence>0&&records[minimumWatermark.sequence-1]?.receipt.event_hash!==minimumWatermark.event_hash)fail('Independent watermark hash mismatch');
 return verified;
}
