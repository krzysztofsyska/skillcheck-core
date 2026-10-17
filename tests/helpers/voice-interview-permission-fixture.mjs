import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verificationHarness } from './contact-verification-fixture.mjs';
import {
  ingestVoiceInterviewPermission, VOICE_INTERVIEW_PERMISSION_DOMAIN,
  VOICE_INTERVIEW_PERMISSION_PROOF_TYPE,
} from '../../lib/voice/interview-permission.ts';

// Ephemeral synthetic attestor, independent of the B2 contact attestor. No real
// consent, secrets, provider transport or candidate details are used by tests.
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
export const INTERVIEW_TEST_ISSUER = 'synthetic-interview-permission';
export const INTERVIEW_TEST_KEY = 'interview-key-v1';
export const INTERVIEW_TEST_NOTICE = 'notice-pl-202610';
export const INTERVIEW_TEST_POLICY_SHA256 = createHash('sha256').update(JSON.stringify({
  purpose: 'voice_interview', recordingAllowed: false,
  notice: 'Synthetic interview notice received before explicit interview permission.',
})).digest('hex');

export async function installVoiceInterviewPermissionSchema(db) {
  await db.exec(await readFile(new URL('../../db/isolated/sc010c-interview-permission.sql', import.meta.url), 'utf8'));
}

export const INTERVIEW_TEST_LEGACY_ROLES = ['service_role', 'erasure_worker', 'voice permission "legacy" fixture'];
export async function grantHostileInterviewPermissionDefaults(db) {
  // Deliberately unsafe defaults exist only in disposable synthetic databases.
  // The quoted legacy role also checks identifier escaping in the ACL cleanup.
  for (const role of INTERVIEW_TEST_LEGACY_ROLES) {
    const identifier = `"${role.replaceAll('"', '""')}"`;
    if (!(await db.query('select 1 from pg_catalog.pg_roles where rolname=$1', [role])).rows.length) {
      await db.exec(`create role ${identifier} nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    }
    await db.exec(`grant usage on schema private to ${identifier};
      alter default privileges in schema private grant execute on functions to ${identifier};
      alter default privileges in schema private grant all on tables to ${identifier}`);
  }
  // Existing objects and the owner's defaults must retain these rights. The
  // installer is responsible only for its four tables and five functions.
  await db.exec(`create table private.interview_acl_legacy_probe(id integer);
    create function private.interview_acl_legacy_probe() returns integer language sql as 'select 1'`);
  return (await db.query(`select defaclrole,defaclnamespace,defaclobjtype,defaclacl::text
    from pg_catalog.pg_default_acl order by defaclrole,defaclnamespace,defaclobjtype`)).rows;
}

export function voiceInterviewPermissionHarness(h) {
  const { db } = h;
  const contact = verificationHarness(h);
  const asVerifier = async () => {
    await db.exec('reset role;set role voice_permission_verifier');
    await db.query("select set_config('request.jwt.claim.sub','',false)");
  };
  const register = async (f, { policyEnabled = true, issuerEnabled = true } = {}) => {
    await h.asAdmin();
    await db.query(`insert into private.voice_interview_permission_issuers
      (company_id,issuer_id,key_id,enabled,valid_from,valid_until)
      values($1,$2,$3,$4,now()-interval '1 day',now()+interval '1 day') on conflict do nothing`,
    [f.companyId, INTERVIEW_TEST_ISSUER, INTERVIEW_TEST_KEY, issuerEnabled]);
    await db.query(`insert into private.voice_interview_permission_policies
      (company_id,notice_version,policy_sha256,enabled,valid_from,valid_until)
      values($1,$2,$3,$4,now()-interval '1 day',now()+interval '1 day') on conflict do nothing`,
    [f.companyId, INTERVIEW_TEST_NOTICE, INTERVIEW_TEST_POLICY_SHA256, policyEnabled]);
    await h.asUser(f.owner);
  };
  const context = (f, overrides = {}) => ({
    company_id: f.companyId, candidate_id: f.candidate.id, recruitment_id: f.recruitment.id,
    application_id: f.application.id, contact_receipt_id: f.contactReceiptId, contact_version: 1,
    global_permission_revision: f.contactReceipt?.global_permission_revision ?? 0,
    scoped_permission_revision: f.contactReceipt?.scoped_permission_revision ?? 0,
    preference_revision: f.contactReceipt?.preference_revision ?? 1,
    channel: 'voice', purpose: 'voice_interview', recording_allowed: false,
    notice_version: INTERVIEW_TEST_NOTICE, policy_sha256: INTERVIEW_TEST_POLICY_SHA256,
    ...overrides,
  });
  const receipt = (f, overrides = {}) => {
    const now = Date.now();
    return {
      ...context(f), schema_version: 1, proof_type: VOICE_INTERVIEW_PERMISSION_PROOF_TYPE,
      receipt_id: randomUUID(), issuer_id: INTERVIEW_TEST_ISSUER, key_id: INTERVIEW_TEST_KEY, nonce: randomUUID(),
      notice_received_at: new Date(now - 400).toISOString(),
      interview_permission_granted_at: new Date(now - 200).toISOString(),
      issued_at: new Date(now - 100).toISOString(), expires_at: new Date(now + 240000).toISOString(),
      ...overrides,
    };
  };
  const config = f => ({ issuers: [{ company_id: f.companyId, issuer_id: INTERVIEW_TEST_ISSUER, key_id: INTERVIEW_TEST_KEY, publicKeyPem }] });
  const attest = (r, domain = VOICE_INTERVIEW_PERMISSION_DOMAIN) => {
    const bytes = Buffer.from(JSON.stringify(r));
    return { payload: bytes.toString('base64url'), signature: sign(null, Buffer.concat([Buffer.from(domain), bytes]), privateKey).toString('base64url') };
  };
  const ingest = async (f, r = receipt(f), options = {}) => {
    await asVerifier();
    return ingestVoiceInterviewPermission({ attestation: attest(r), config: config(f),
      execute: async (sql, parameters) => (await db.query(sql, parameters)).rows[0].receipt_id,
      ...options, context: context(f, options.context),
    });
  };
  // Status and revocation are deliberately private: only the synthetic database
  // owner may inspect them directly, never the verifier or an application role.
  const status = async (f, id, application = f.application.id, contactId = f.contactReceiptId) => {
    await h.asAdmin();
    return (await db.query('select private.voice_interview_permission_status($1,$2,$3) as reason',
      [application, contactId, id])).rows[0].reason;
  };
  const revoke = async (f, id) => {
    await h.asAdmin();
    await db.query('insert into private.voice_interview_permission_revocations(company_id,receipt_id) values($1,$2)', [f.companyId, id]);
  };
  const ready = async (options = {}) => {
    let source = options.tenant ? await h.candidate(options.tenant) : await h.seed();
    if (options.requiredBehaviors) {
      if (options.tenant) {
        assert.deepEqual(source.position.required_behaviors, options.requiredBehaviors,
          'Reusing a tenant must not change another candidate\'s already reviewed position');
      } else {
        source = { ...source, position: (await db.query('update public.positions set required_behaviors=$1 where id=$2 returning *',
          [options.requiredBehaviors, source.position.id])).rows[0] };
      }
    }
    const f = await h.completedApplication(source, options.ratings ?? Array(5).fill('meets'));
    f.shortlistId = await h.add(f, 'manual');
    if (!options.tenant) await contact.register(f);
    await h.asAdmin();
    await db.query(`insert into private.contact_policy_templates
      (company_id,notice_version,policy_version,template_version,channel,purpose,enabled,valid_from,valid_until)
      values($1,'notice-v1','policy-v1','template-v1','voice','verification_invitation',true,now()-interval '1 day',now()+interval '1 day') on conflict do nothing`, [f.companyId]);
    await register(f, options);
    await contact.preferences(f, 0, randomUUID(), [], 'UTC',
      Array.from({ length: 7 }, (_, index) => ({ weekday: index + 1, start_minute: 0, end_minute: 1440 })));
    const communicationId = await contact.prepare(f, randomUUID(), 'voice');
    const bound = { channel: 'voice', destination: '+48221234567', preference_revision: 1 };
    const contactReceipt = contact.receipt(f, bound);
    const contactReceiptId = await contact.ingest(f, contactReceipt, { context: bound });
    await h.asUser(f.owner);
    const approvalId = await contact.approve(communicationId, contactReceiptId);
    await h.asAdmin();
    const contactPoint = (await db.query(`select p.* from private.candidate_verified_contact_points p
      join private.candidate_verified_contact_receipts r on r.company_id=p.company_id and r.contact_point_id=p.id
      where r.id=$1`, [contactReceiptId])).rows[0];
    await h.asUser(f.owner);
    return { ...f, contactReceiptId, contactReceipt, communicationId, approvalId,
      contactConfig: contact.config(f), contactContext: contact.context(f, bound), contactPoint };
  };
  return { db, h, contact, asVerifier, register, context, receipt, config, attest, ingest, status, revoke, ready };
}
