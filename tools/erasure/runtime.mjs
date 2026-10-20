import {randomUUID} from 'node:crypto';
import {digest,parseEnvelope,signReservationProof,verifyReceipt,verifyReplayCoverage} from './ledger.mjs';

/** This adapter belongs ONLY in the independently deployed attestor process.
 * The product worker gets reserve/get-work/purge RPCs, no connection from here.
 * Key identities/ledger identity must be pinned outside the product backup. */
export function createLedgerAttestor({connect,ledgerId,verificationKeys}){
 return async function attest(reservation,receipt){
  verifyReceipt(receipt,verificationKeys);
  const e=parseEnvelope(reservation.envelope_text);
  if(receipt.ledger_id!==ledgerId||receipt.event_id!==reservation.reservation_id||receipt.envelope_hash!==reservation.envelope_hash||digest(reservation.envelope_text)!==reservation.envelope_hash||receipt.request_id!==e.request_id||receipt.company_id!==e.company_id||receipt.generation!==e.generation||receipt.phase!==e.phase||receipt.request_sequence!==e.sequence||receipt.previous_event_hash!==e.previous_event_hash)throw new Error('Receipt does not bind reservation');
  const db=await connect();try{return (await db.query('select private.confirm_erasure_ledger_event($1::uuid,$2::uuid,$3::bigint,$4::text,$5::text,$6::text) result',[e.request_id,reservation.reservation_id,receipt.request_sequence,receipt.previous_event_hash,receipt.event_hash,receipt.envelope_hash])).rows[0].result;}finally{await db.end();}
 };
}
/** Reads the product reservation and signs it. The private key never belongs to
 * the worker or the ledger. A caller-supplied envelope that differs from the
 * stored binding is not signed. */
export function createReservationProver({connect,signingKeyId,signingKey}){
 if(!signingKeyId||!signingKey)throw new Error('Reservation authority required');
 return async function prove(reservation){
  if(!reservation?.reservation_id)throw new Error('Reservation proof rejected');
  const db=await connect();
  try{
   const bound=(await db.query('select private.get_erasure_reservation_binding($1::uuid) value',[reservation.reservation_id])).rows[0]?.value;
   if(!bound||bound.envelope_text!==reservation.envelope_text||bound.envelope_hash!==reservation.envelope_hash||digest(reservation.envelope_text)!==bound.envelope_hash)throw new Error('Reservation proof rejected');
   return {reservation_key_id:signingKeyId,reservation_proof:signReservationProof(bound.envelope_hash,signingKey)};
  }finally{await db.end();}
 };
}
/** No local mutation precedes the independent ledger COMMIT. Ambiguous transport
 * failures are retried with the SAME reservation/event ID, never a guessed ACK.
 * prove() must be the attestor binding above, not a signature over caller bytes. */
export async function commitReservedTransition({reservation,ledger,attest,prove}){
 if(typeof prove!=='function')throw new Error('Reservation proof rejected');
 const proof=await prove(reservation);
 const receipt=await ledger.append({eventId:reservation.reservation_id,envelopeText:reservation.envelope_text,envelopeHash:reservation.envelope_hash,reservationKeyId:proof.reservation_key_id,reservationProof:proof.reservation_proof});
 return attest(reservation,receipt);
}
/** Call only with isolated product DB credentials and a fresh response from the
 * independent live ledger. All records are verified BEFORE the first replay. */
export async function replayVerifiedLedger({records,checkpoint,challenge,ledgerId,minimumWatermark,verificationKeys,encryptionKeys,reservationKeys,connect}){
 const verified=verifyReplayCoverage({records,checkpoint,challenge,ledgerId,minimumWatermark,verificationKeys,encryptionKeys,reservationKeys});
 const latest=new Map();for(const item of verified)latest.set(item.receipt.request_id,item);
 const replay=verified.filter(item=>latest.get(item.receipt.request_id)===item);
 const db=await connect();try{
  // Expired envelopes are deliberately NOT filtered. The isolated SQL ingress
  // must distinguish a reversible freeze from irreversible scope absence; age alone never permits skipping,
  // purging, unfreezing, or discarding irreversible tombstones.
  const results=[];for(const {envelopeText,receipt} of replay){
   results.push((await db.query('select private.replay_erasure_envelope($1::text,$2::text,$3::bigint,$4::text) result',[envelopeText,receipt.event_hash,checkpoint.sequence,checkpoint.head_hash])).rows[0].result);
  }return {replayed:replay.length,verifiedEvents:verified.length,checkpoint:checkpoint.head_hash,checkpointReceipt:checkpoint.event_hash,results};
 }finally{await db.end();}
}
export const newRestoreChallenge=()=>randomUUID();

/** Read-only operational evidence. Adapters and keys must be pinned operator
 * configuration, never product/caller data. No health result releases isolation
 * or authorizes erasure. The checkpoint challenge is generated here per call. */
export async function inspectErasureLedgerHealth({ledgerId,getCheckpoint,getRecords,getMinimumWatermark,verificationKeys,encryptionKeys,reservationKeys}){
 const challenge=newRestoreChallenge();
 try{
  if(typeof getCheckpoint!=='function'||typeof getRecords!=='function'||typeof getMinimumWatermark!=='function')throw new Error('Missing operator adapter');
  const [checkpoint,minimumWatermark]=await Promise.all([getCheckpoint(challenge),getMinimumWatermark()]);
  const records=await getRecords(checkpoint.sequence);
  const verified=verifyReplayCoverage({records,checkpoint,challenge,ledgerId,minimumWatermark,verificationKeys,encryptionKeys,reservationKeys});
  const blockers=['deployment_not_attested','restore_drill_required'];
  if(minimumWatermark.sequence!==checkpoint.sequence||minimumWatermark.event_hash!==checkpoint.head_hash)blockers.push('checkpoint_register_behind');
  return {ledger_verified:true,production_ready:false,verified_events:verified.length,checkpoint_sequence:checkpoint.sequence,checkpoint_hash:checkpoint.head_hash,blockers};
 }catch{
  // Do not leak adapter errors, DSNs, key material or decrypted recovery scopes.
  return {ledger_verified:false,production_ready:false,blockers:['independent_ledger_verification_failed','deployment_not_attested','restore_drill_required']};
 }
}

/** One explicit, bounded scheduling tick; never installs a timer or starts a
 * worker. connect() must be the dedicated erasure_scheduler identity, which has
 * no ledger/attestor/purge rights. The database rechecks all activation gates. */
export async function runRetentionScheduleTick({connect,batchLimit=25}){
 if(!Number.isSafeInteger(batchLimit)||batchLimit<1||batchLimit>100)throw new Error('Invalid scheduler batch limit');
 let db;
 try{
  db=await connect();
  const identity=(await db.query('select current_user as role')).rows[0]?.role;
  if(identity!=='erasure_scheduler')throw new Error('Wrong scheduler identity');
  const result=(await db.query('select private.tick_retention_schedule($1::integer) result',[batchLimit])).rows[0]?.result;
  if(!result||!['processed','suggested','authorized','blocked'].every(k=>Number.isSafeInteger(result[k])&&result[k]>=0&&result[k]<=batchLimit)||!Array.isArray(result.results)||result.results.length>batchLimit)throw new Error('Invalid scheduler response');
  // Only aggregate counters leave this adapter; no candidates or request payload.
  return {processed:result.processed,suggested:result.suggested,authorized:result.authorized,blocked:result.blocked};
 }catch{throw new Error('RETENTION_SCHEDULE_TICK_FAILED');}
 finally{if(db){try{await db.end()}catch{throw new Error('RETENTION_SCHEDULE_TICK_FAILED')}}}
}
