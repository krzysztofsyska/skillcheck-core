// Copy to a private absolute path OUTSIDE the repository. Provision secrets
// through the hosting provider's secret manager. This example does not start.
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';

// The deployed checkout is read-only; it supplies the pinned pg dependency.
const require=createRequire('/opt/skillcheck/package.json');
const {Client}=require('pg');
const text=path=>readFile(path,'utf8');
const secretRoot='/run/secrets/erasure-ledger';
const connectionString=(await text(`${secretRoot}/database-url`)).trim();
const ca=await text(`${secretRoot}/database-ca.pem`);
const url=new URL(connectionString);
// SSL URL parameters may override pg's explicit TLS object. Never allow them.
if(!['postgres:','postgresql:'].includes(url.protocol)||url.search||url.hash)throw new Error('Invalid database URL');
// Pin this to the endpoint shown in the approved project's Connect panel.
if(url.hostname!=='db.jfacjlrfbusqlednluzu.supabase.co'||decodeURIComponent(url.username)!=='erasure_ledger_service')throw new Error('Wrong ledger endpoint');
export const ledgerOptions={
 ledgerId:'4cde6438-c27e-46b1-9b7d-1396b688643f',
 connect:async()=>{
  const client=new Client({connectionString,ssl:{ca,rejectUnauthorized:true},connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:12000});
  try{await client.connect();return client;}catch(error){await client.end().catch(()=>{});throw error;}
 },
 encryptionKeyId:'aes-v1',encryptionKey:await readFile(`${secretRoot}/aes-v1.bin`),
 signingKeyId:'sign-v1',signingKey:await text(`${secretRoot}/sign-v1-private.pem`),
 verificationKeys:{'sign-v1':await text(`${secretRoot}/sign-v1-public.pem`)},
 // PUBLIC key only; the prover private key belongs to a separate attestor.
 reservationKeys:{'reservation-v1':await text(`${secretRoot}/reservation-v1-public.pem`)}
};
export const appendToken=(await text(`${secretRoot}/append-token`)).trim();
export const readToken=(await text(`${secretRoot}/read-token`)).trim();
// Deliberately missing: startup must fail until a reviewed durable independent
// register adapter is supplied. Do NOT replace with async()=>{}, local memory,
// a value read from ledger.head, or a file in an ephemeral function filesystem.
export const checkpointRegister=undefined;
