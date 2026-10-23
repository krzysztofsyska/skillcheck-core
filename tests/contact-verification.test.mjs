import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { ingestContactVerification, decryptContactEnvelope, RECEIPT_DOMAIN } from '../lib/contact-verification.ts';
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture() {
  const {publicKey,privateKey} = generateKeyPairSync('ed25519');
  const now = new Date('2026-10-09T12:00:00.000Z');
  const context = {company_id:uuid(1),candidate_id:uuid(2),recruitment_id:uuid(3),channel:'email',purpose:'verification_invitation',notice_version:'notice-v1',policy_version:'policy-v1',template_version:'template-v1',global_permission_revision:0,scoped_permission_revision:0,preference_revision:0,expected_contact_version:0,destination:'synthetic@example.invalid'};
  const receipt = {...context,proof_type:'candidate_contact_and_permission_verified_v1',receipt_id:uuid(4),nonce:uuid(5),issuer_id:'trusted',key_id:'signing-v1',issued_at:now.toISOString(),expires_at:new Date(now.getTime()+300000).toISOString()};
  const config = {issuers:[{issuer_id:'trusted',key_id:'signing-v1',company_id:uuid(1),publicKeyPem:publicKey.export({type:'spki',format:'pem'})}],encryptionKey:randomBytes(32),fingerprintKey:randomBytes(32),encryptionKeyId:'vault-v1'};
  const calls=[];
  const attestation = (value=receipt, key=privateKey) => {const bytes=Buffer.from(JSON.stringify(value));return {payload:bytes.toString('base64url'),signature:sign(null,Buffer.concat([Buffer.from(RECEIPT_DOMAIN),bytes]),key).toString('base64url')};};
  const input = () => ({attestation:attestation(),context,config,now,execute:async(sql,params)=>{calls.push({sql,params});return uuid(4)}});
  return {now,context,receipt,config,calls,attestation,input};
}
test('verified permission/contact receipt ingests only encrypted contact and keyed digest',async()=>{
  const f=fixture();assert.equal(await ingestContactVerification(f.input()),uuid(4));
  assert.equal(f.calls.length,1);const {sql,params}=f.calls[0];
  assert.equal(sql,'select private.ingest_verified_contact_receipt($1::jsonb, $2::jsonb) as receipt_id');
  assert.ok(!params.join('').includes(f.context.destination));
  const [proof,envelope]=params.map(JSON.parse);assert.match(proof.contact_digest,/^[a-f0-9]{64}$/);assert.ok(!('destination' in proof));
  assert.equal(decryptContactEnvelope(envelope,f.context,f.config),f.context.destination);
  await ingestContactVerification(f.input());const [secondProof,secondEnvelope]=f.calls[1].params.map(JSON.parse);
  assert.equal(secondProof.contact_digest,proof.contact_digest);assert.notEqual(secondEnvelope.iv,envelope.iv);
});
for (const [label,mutate] of Object.entries({
  'untrusted issuer':f=>{f.receipt.issuer_id='operator'},
  'wrong issuer key':f=>{f.config.issuers[0].publicKeyPem=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'})},
  'wrong tenant allowlist':f=>{f.config.issuers[0].company_id=uuid(90)},
  'wrong bound tenant':f=>{f.context.company_id=uuid(90)},
  'wrong destination':f=>{f.context.destination='other@example.invalid'},
  'wrong scope revision':f=>{f.context.global_permission_revision=1},
  'wrong policy':f=>{f.context.policy_version='policy-v2'},
  'wrong proof type':f=>{f.receipt.proof_type='contact_only'},
  'unknown extra fields':f=>{f.receipt.dispatch=true},
  'expired proof':f=>{f.receipt.expires_at=f.now.toISOString()},
  'future proof':f=>{f.receipt.issued_at='2026-10-09T12:00:01.000Z'},
  'excessive lifetime':f=>{f.receipt.expires_at='2026-10-09T13:00:00.000Z'},
  'invalid calendar date':f=>{f.receipt.issued_at='2026-02-30T12:00:00.000Z'},
  'bad revision':f=>{f.receipt.preference_revision=-1;f.context.preference_revision=-1},
  'non-normalized destination':f=>{f.receipt.destination='Synthetic@example.invalid';f.context.destination=f.receipt.destination},
  'short key':f=>{f.config.encryptionKey=randomBytes(16)},
  'key reuse':f=>{f.config.fingerprintKey=f.config.encryptionKey},
})) test(`${label} rejects before SQL`,async()=>{const f=fixture();mutate(f);await assert.rejects(ingestContactVerification(f.input()),/^Error: CONTACT_VERIFICATION_REJECTED$/);assert.equal(f.calls.length,0)});
test('altered payload, wrong domain, duplicate keys and noncanonical base64 reject before SQL',async()=>{
  for(const mode of ['altered','domain','duplicate','padding']){
    const f=fixture(), input=f.input();
    if(mode==='altered'){input.attestation.payload=Buffer.from(JSON.stringify({...f.receipt,nonce:uuid(99)})).toString('base64url')}
    if(mode==='domain'){input.attestation.signature=sign(null,Buffer.from(input.attestation.payload,'base64url'),generateKeyPairSync('ed25519').privateKey).toString('base64url')}
    if(mode==='duplicate'){input.attestation.payload=Buffer.from(JSON.stringify(f.receipt).replace('{','{"channel":"email",')).toString('base64url')}
    if(mode==='padding')input.attestation.payload+='=';
    await assert.rejects(ingestContactVerification(input),/CONTACT_VERIFICATION_REJECTED/);assert.equal(f.calls.length,0);
  }
});
test('vault ciphertext binds tenant, candidate, channel, generation, key and authentication tag',async()=>{
 const f=fixture();await ingestContactVerification(f.input());const env=JSON.parse(f.calls[0].params[1]);
 for(const change of [{company_id:uuid(9)},{candidate_id:uuid(9)},{channel:'sms'},{expected_contact_version:1}])assert.throws(()=>decryptContactEnvelope(env,{...f.context,...change},f.config),/CONTACT_VERIFICATION_REJECTED/);
 assert.throws(()=>decryptContactEnvelope({...env,tag:randomBytes(16).toString('base64url')},f.context,f.config),/CONTACT_VERIFICATION_REJECTED/);
 assert.throws(()=>decryptContactEnvelope({...env,key_id:'other'},f.context,f.config),/CONTACT_VERIFICATION_REJECTED/);
});
test('database replay/conflict is generic, not leaked or retried',async()=>{
 const f=fixture();let count=0;await assert.rejects(ingestContactVerification({...f.input(),execute:async()=>{count++;throw new Error('SECRET_CANDIDATE@example.invalid replay')}}),/^Error: CONTACT_VERIFICATION_NOT_ACCEPTED$/);assert.equal(count,1);
});
test('SMS/voice normalization accepts E164 only and flags cannot create dispatch',async()=>{
 for(const channel of ['sms','voice']){const f=fixture();f.receipt.channel=f.context.channel=channel;f.receipt.destination=f.context.destination='+48123456789';await ingestContactVerification(f.input());assert.equal(f.calls.length,1);assert.doesNotMatch(f.calls[0].sql,/dispatch|send|schedule/);}
 const f=fixture();f.receipt.channel=f.context.channel='sms';f.receipt.destination=f.context.destination='123456789';await assert.rejects(ingestContactVerification(f.input()),/CONTACT_VERIFICATION_REJECTED/);assert.equal(f.calls.length,0);
});
test('environment flags cannot activate contact dispatch',async()=>{
 const keys=['CONTACT_DISPATCH_ENABLED','COMMUNICATION_ENABLED','SC010_DISPATCH_ENABLED'];
 const previous=keys.map(k=>process.env[k]);
 try { for(const k of keys)process.env[k]='true';const f=fixture();await ingestContactVerification(f.input());assert.equal(f.calls.length,1);assert.equal(f.calls[0].sql,'select private.ingest_verified_contact_receipt($1::jsonb, $2::jsonb) as receipt_id'); }
 finally {keys.forEach((k,i)=>{if(previous[i]===undefined)delete process.env[k];else process.env[k]=previous[i]})}
});
