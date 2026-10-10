import {randomUUID,randomBytes,generateKeyPairSync} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PostgresErasureLedger} from '../../tools/erasure/ledger.mjs';
import {createLedgerAttestor,commitReservedTransition,replayVerifiedLedger} from '../../tools/erasure/runtime.mjs';
import {lifecycleHarness} from './erasure-lifecycle-fixture.mjs';

export function executionHarness(h){
 const {db}=h,l=lifecycleHarness(h);
 const role=async name=>{
  if(!['erasure_worker','erasure_ledger_attestor','erasure_restore_attestor'].includes(name))throw new Error('Unexpected test capability');
  await h.asAdmin();await db.exec(`set role ${name}`);
 };
 const reserve=async(request,sequence,phase,key=randomUUID())=>{
  await role('erasure_worker');return(await db.query('select private.reserve_erasure_transition($1,$2,$3,$4) value',[request,sequence,phase,key])).rows[0].value;
 };
 const work=async request=>{await role('erasure_worker');return(await db.query('select private.get_erasure_work($1) value',[request])).rows[0].value;};
 const purge=async(request,sequence)=>{await role('erasure_worker');return(await db.query('select private.purge_candidate_erasure($1,$2) value',[request,sequence])).rows[0].value;};
 const configure=async(overrides={})=>{await h.asAdmin();const c={enabled:true,external_inventory_verified:true,backup_horizon_days:30,artifact_horizon_days:30,retention_margin_days:7,restore_isolated:false,...overrides};await db.query('update private.erasure_execution_config set enabled=$1,external_inventory_verified=$2,backup_horizon_days=$3,artifact_horizon_days=$4,retention_margin_days=$5,restore_isolated=$6 where singleton',[c.enabled,c.external_inventory_verified,c.backup_horizon_days,c.artifact_horizon_days,c.retention_margin_days,c.restore_isolated]);};
 const requestStatus=async(f,request)=>{await h.asUser(f.owner);return(await db.query('select public.get_erasure_status($1) value',[request])).rows[0].value;};
 return {...l,role,reserve,work,purge,requestStatus,configure};
}

// Independent ledger persistence, real encryption/signatures and attestation adapter.
export async function setupExecutionLedger(x,ledgerDb){
 await (ledgerDb.exec??ledgerDb.query).call(ledgerDb,await readFile(new URL('../../tools/erasure/ledger.sql',import.meta.url),'utf8'));
 const ledgerId=randomUUID(),encryptionKey=randomBytes(32),{privateKey,publicKey}=generateKeyPairSync('ed25519');
 await ledgerDb.query('insert into erasure_ledger.head(singleton,ledger_id) values(true,$1)',[ledgerId]);
 const verificationKeys={synthetic:publicKey},encryptionKeys={synthetic:encryptionKey};
 const ledger=new PostgresErasureLedger({connect:async()=>({query:(...args)=>ledgerDb.query(...args),end:async()=>{}}),ledgerId,encryptionKeyId:'synthetic',encryptionKey,signingKeyId:'synthetic',signingKey:privateKey,verificationKeys});
 const attest=createLedgerAttestor({ledgerId,verificationKeys,connect:async()=>{await x.role('erasure_ledger_attestor');return {query:(...args)=>x.db.query(...args),end:async()=>{}};}});
 const ack=async reservation=>commitReservedTransition({reservation,ledger,attest});
 const transition=async(request,sequence,phase,key)=>{const reservation=await x.reserve(request,sequence,phase,key);await ack(reservation);return reservation;};
 const replay=async(target=x)=>{
  const challenge=randomUUID(),checkpoint=await ledger.checkpoint(challenge),records=(await ledgerDb.query('select receipt,encrypted_envelope from erasure_ledger.events order by sequence')).rows;
  return replayVerifiedLedger({records,checkpoint,challenge,ledgerId,minimumWatermark:{ledger_id:ledgerId,sequence:checkpoint.sequence,event_hash:checkpoint.head_hash},verificationKeys,encryptionKeys,connect:async()=>{await target.role('erasure_restore_attestor');return {query:(...args)=>target.db.query(...args),end:async()=>{}};}});
 };
 return Object.assign(x,{ledger,attest,ack,transition,replay,ledgerDb,ledgerId,verificationKeys,encryptionKeys});
}
