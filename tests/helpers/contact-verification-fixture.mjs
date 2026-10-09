import {randomUUID,randomBytes,generateKeyPairSync,sign} from 'node:crypto';
import {ingestContactVerification,RECEIPT_DOMAIN} from '../../lib/contact-verification.ts';
import {communicationHarness} from './candidate-communication-fixture.mjs';

// One ephemeral synthetic verifier service per test process. Independent database
// sessions share its signing/encryption/HMAC configuration; changing the HMAC key
// would change the attested contact digest and correctly conflict on replay.
// This proves software boundaries, not real candidate consent.
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const publicKeyPem=publicKey.export({type:'spki',format:'pem'});
const issuer='synthetic-test',key='test-key';
const encryptionKey=randomBytes(32),fingerprintKey=randomBytes(32);
export function verificationHarness(h){
 const {db}=h,c=communicationHarness(h);
 const asVerifier=async()=>{await db.exec('reset role;set role contact_verifier');await db.query("select set_config('request.jwt.claim.sub','',false)");};
 const register=async(f)=>{await h.asAdmin();
  await db.query("insert into private.contact_trusted_issuers(company_id,issuer_id,key_id,enabled,valid_from,valid_until) values($1,$2,$3,true,now()-interval '1 day',now()+interval '1 day')",[f.companyId,issuer,key]);
  await db.query("insert into private.contact_policy_templates(company_id,notice_version,policy_version,template_version,channel,purpose,enabled,valid_from,valid_until) values($1,'notice-v1','policy-v1','template-v1','email','verification_invitation',true,now()-interval '1 day',now()+interval '1 day')",[f.companyId]);
  await h.asUser(f.owner);
 };
 const approve=async(id,r,version=1,key=randomUUID())=>(await db.query('select public.approve_candidate_communication($1,$2,$3,$4) as id',[id,version,r,key])).rows[0].id;
 const status=async(id)=>(await db.query('select * from public.get_communication_approval_status($1)',[id])).rows[0];
 const ready=async(ratings)=>{const f=await c.ready(ratings);await register(f);return f;};
 const context=(f,overrides={})=>({company_id:f.companyId,candidate_id:f.candidate.id,recruitment_id:f.recruitment.id,channel:'email',purpose:'verification_invitation',notice_version:'notice-v1',policy_version:'policy-v1',template_version:'template-v1',global_permission_revision:0,scoped_permission_revision:0,preference_revision:0,expected_contact_version:0,destination:'synthetic@example.test',...overrides});
 const receipt=(f,overrides={})=>({...context(f),proof_type:'candidate_contact_and_permission_verified_v1',receipt_id:randomUUID(),issuer_id:issuer,key_id:key,nonce:randomUUID(),issued_at:new Date(Date.now()-1000).toISOString(),expires_at:new Date(Date.now()+600000).toISOString(),...overrides});
 const config=f=>({issuers:[{issuer_id:issuer,key_id:key,company_id:f.companyId,publicKeyPem}],encryptionKey,fingerprintKey,encryptionKeyId:'test-encryption-v1'});
 const attest=r=>{const bytes=Buffer.from(JSON.stringify(r));return {payload:bytes.toString('base64url'),signature:sign(null,Buffer.concat([Buffer.from(RECEIPT_DOMAIN),bytes]),privateKey).toString('base64url')};};
 const ingest=async(f,r=receipt(f),options={})=>{await asVerifier();return ingestContactVerification({attestation:attest(r),context:context(f,options.context),config:config(f),execute:async(sql,args)=>(await db.query(sql,args)).rows[0].receipt_id,...options,context:context(f,options.context)});};
 return {...c,db,ready,register,approve,status,asVerifier,context,receipt,config,attest,ingest,issuer,key};
}
