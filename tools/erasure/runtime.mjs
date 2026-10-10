import {randomUUID} from 'node:crypto';
import {digest,parseEnvelope,verifyReceipt,verifyReplayCoverage} from './ledger.mjs';

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
/** No local mutation precedes the independent ledger COMMIT. Ambiguous transport
 * failures are retried with the SAME reservation/event ID, never a guessed ACK. */
export async function commitReservedTransition({reservation,ledger,attest}){
 const receipt=await ledger.append({eventId:reservation.reservation_id,envelopeText:reservation.envelope_text,envelopeHash:reservation.envelope_hash});
 return attest(reservation,receipt);
}
/** Call only with isolated product DB credentials and a fresh response from the
 * independent live ledger. All records are verified BEFORE the first replay. */
export async function replayVerifiedLedger({records,checkpoint,challenge,ledgerId,minimumWatermark,verificationKeys,encryptionKeys,connect}){
 const verified=verifyReplayCoverage({records,checkpoint,challenge,ledgerId,minimumWatermark,verificationKeys,encryptionKeys});
 const latest=new Map();for(const item of verified)latest.set(item.receipt.request_id,item);
 const replay=verified.filter(item=>latest.get(item.receipt.request_id)===item);
 const db=await connect();try{
  // Expired envelopes are deliberately NOT filtered. The isolated SQL ingress
  // must prove exact scope absence or reject; age alone never permits skipping,
  // purging, unfreezing, or discarding irreversible tombstones.
  const results=[];for(const {envelopeText,receipt} of replay){
   results.push((await db.query('select private.replay_erasure_envelope($1::text,$2::text,$3::bigint,$4::text) result',[envelopeText,receipt.event_hash,checkpoint.sequence,checkpoint.head_hash])).rows[0].result);
  }return {replayed:replay.length,verifiedEvents:verified.length,checkpoint:checkpoint.head_hash,checkpointReceipt:checkpoint.event_hash,results};
 }finally{await db.end();}
}
export const newRestoreChallenge=()=>randomUUID();
