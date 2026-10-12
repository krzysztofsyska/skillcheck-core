import {createPrivateKey,createPublicKey,randomBytes,sign,verify} from 'node:crypto';
import {PostgresErasureLedger} from './ledger.mjs';

// Operator-owned configuration only. Never obtain keys, roles or connection
// factories from an HTTP request or from either restored database.
export async function createServiceBackend(options){
 const {connect,ledgerId,encryptionKeyId,encryptionKey,signingKeyId,signingKey,verificationKeys,reservationKeys}=options;
 const keyId=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
 if(typeof connect!=='function'||!Buffer.isBuffer(encryptionKey)||encryptionKey.length!==32||!keyId.test(encryptionKeyId??'')||!keyId.test(signingKeyId??''))throw new Error('Invalid ledger configuration');
 const privateKey=signingKey?.type==='private'?signingKey:createPrivateKey(signingKey);
 if(privateKey.asymmetricKeyType!=='ed25519')throw new Error('Ed25519 required');
 const publicKeys=ring=>{
  if(!ring||!Object.keys(ring).length)throw new Error('Public keys required');
  return Object.fromEntries(Object.entries(ring).map(([id,key])=>{
   if(!keyId.test(id)||key?.type==='private')throw new Error('Public key required');
   // Reject private PEM input rather than silently deriving a public key.
   if(typeof key==='string'&&!key.startsWith('-----BEGIN PUBLIC KEY-----'))throw new Error('Public key required');
   if(typeof key!=='string'&&key?.type!=='public')throw new Error('Public key required');
   const parsed=key?.type==='public'?key:createPublicKey(key);
   if(parsed.asymmetricKeyType!=='ed25519')throw new Error('Ed25519 required');
   return [id,parsed];
  }));
 };
 const publicSigning=publicKeys(verificationKeys),publicReservation=publicKeys(reservationKeys);
 const signingPublic=createPublicKey(privateKey).export({type:'spki',format:'der'});
 if(Object.values(publicReservation).some(key=>key.export({type:'spki',format:'der'}).equals(signingPublic)))throw new Error('Reservation and ledger keys must be independent');
 const challenge=randomBytes(32);
 if(!publicSigning[signingKeyId]||!verify(null,challenge,publicSigning[signingKeyId],sign(null,challenge,privateKey)))throw new Error('Signing key mismatch');
 const db=await connect();
 try{
  const state=(await db.query(`select current_user as role, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
   (select count(*)::int from pg_auth_members m where m.member=r.oid) as memberships,
   has_schema_privilege(current_user,'erasure_ledger','CREATE') as schema_create,
   exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='erasure_ledger' and c.relowner=r.oid) as owns_objects,
   has_table_privilege(current_user,'erasure_ledger.events','SELECT') as events_select,
   has_table_privilege(current_user,'erasure_ledger.events','INSERT') as events_insert,
   has_table_privilege(current_user,'erasure_ledger.events','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as events_extra,
   has_any_column_privilege(current_user,'erasure_ledger.events','UPDATE,REFERENCES') as events_column_extra,
   has_table_privilege(current_user,'erasure_ledger.head','SELECT') as head_select,
   has_table_privilege(current_user,'erasure_ledger.head','UPDATE') as head_update,
   has_table_privilege(current_user,'erasure_ledger.head','INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER') as head_extra
   from pg_roles r where r.rolname=current_user`)).rows[0];
  if(!state||state.role!=='erasure_ledger_service'||state.memberships!==0||['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','schema_create','owns_objects','events_extra','events_column_extra','head_extra'].some(k=>state[k]!==false)||['events_select','events_insert','head_select','head_update'].some(k=>state[k]!==true))throw new Error('Wrong ledger service privileges');
  const head=(await db.query('select ledger_id from erasure_ledger.head where singleton=true')).rows;
  if(head.length!==1||head[0].ledger_id!==ledgerId)throw new Error('Wrong ledger database');
 }finally{await db.end();}
 return {
  ledger:new PostgresErasureLedger({...options,signingKey:privateKey,verificationKeys:publicSigning,reservationKeys:publicReservation}),
  readRecords:async({after,through,limit})=>{
   if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(through)||through<after||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('Invalid record range');
   const client=await connect();
   try{return (await client.query('select receipt,encrypted_envelope from erasure_ledger.events where sequence>$1 and sequence<=$2 order by sequence limit $3',[after,through,limit])).rows;}
   finally{await client.end();}
  }
 };
}
