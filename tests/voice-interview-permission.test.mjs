import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { Client } from 'pg';
import { parse } from 'pg-connection-string';
import { RECEIPT_DOMAIN } from '../lib/contact-verification.ts';
import { ingestVoiceInterviewPermission } from '../lib/voice/interview-permission.ts';
import { setupRankingDatabase, createRankingHarness, users } from './helpers/screening-ranking-fixture.mjs';
import {
  installVoiceInterviewPermissionSchema, voiceInterviewPermissionHarness,
  grantHostileInterviewPermissionDefaults, INTERVIEW_TEST_LEGACY_ROLES,
} from './helpers/voice-interview-permission-fixture.mjs';

const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const rejected = error => error.code === 'VOICE_INTERVIEW_PERMISSION_REJECTED' && error.message === error.code;
const notAccepted = error => error.code === 'VOICE_INTERVIEW_PERMISSION_NOT_ACCEPTED' && error.message === error.code;
const sqlRejected = error => ['PT422', 'PT409'].includes(error.code) &&
  ['VOICE_INTERVIEW_PERMISSION_REJECTED', 'VOICE_INTERVIEW_PERMISSION_NOT_ACCEPTED'].includes(error.message);
const sqlCode = expected => error => error.code === expected;
async function assertHostileInterviewDefaultsClosed(db, h, v, defaultsBefore) {
  const f = await v.ready(), r = v.receipt(f);
  const tables = ['voice_interview_permission_policies', 'voice_interview_permission_issuers',
    'voice_interview_permission_receipts', 'voice_interview_permission_revocations'];
  const functions = ['voice_interview_permission_protect_history()', 'voice_interview_permission_protect_registry()',
    'voice_interview_permission_lock_revocation()', 'voice_interview_permission_status(uuid,uuid,uuid)',
    'ingest_voice_interview_permission_receipt(jsonb)'];
  for (const role of [...INTERVIEW_TEST_LEGACY_ROLES, 'anon', 'authenticated', 'screening_worker', 'contact_verifier', 'voice_permission_verifier']) {
    await h.asAdmin();
    for (const table of tables) {
      assert.equal((await db.query('select has_table_privilege($1,$2,\'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER\') as allowed',
        [role, `private.${table}`])).rows[0].allowed, false, `${role}: ${table}`);
    }
    for (const signature of functions) {
      const expected = role === 'voice_permission_verifier' && signature === 'ingest_voice_interview_permission_receipt(jsonb)';
      assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') as allowed",
        [role, `private.${signature}`])).rows[0].allowed, expected, `${role}: ${signature}`);
    }
    if (INTERVIEW_TEST_LEGACY_ROLES.includes(role)) {
      await db.exec(`set role "${role.replaceAll('"', '""')}"`);
      // A structurally valid unsigned JSON receipt must never cross this role
      // boundary. Its only supported entry point is the pinned TS verifier.
      await assert.rejects(db.query('select private.ingest_voice_interview_permission_receipt($1::jsonb)',
        [JSON.stringify(r)]), sqlCode('42501'), role);
      for (const table of tables) await assert.rejects(db.query(`select * from private.${table}`), sqlCode('42501'), role);
      assert.equal((await db.query('select private.interview_acl_legacy_probe() as value')).rows[0].value, 1);
      assert.deepEqual((await db.query('select * from private.interview_acl_legacy_probe')).rows, []);
    }
  }
  await h.asAdmin();
  assert.deepEqual((await db.query(`select defaclrole,defaclnamespace,defaclobjtype,defaclacl::text
    from pg_catalog.pg_default_acl order by defaclrole,defaclnamespace,defaclobjtype`)).rows, defaultsBefore);
  assert.equal((await db.query('select count(*)::int n from private.voice_interview_permission_receipts where id=$1', [r.receipt_id])).rows[0].n, 0);
  assert.equal(await v.ingest(f, r), r.receipt_id, 'the positively pinned and signed verifier remains usable');
  assert.equal(await v.status(f, r.receipt_id), null);
}
function cryptoFixture() {
  const v = voiceInterviewPermissionHarness({ db: null });
  const f = { companyId: uuid(1), candidate: { id: uuid(2) }, recruitment: { id: uuid(3) },
    application: { id: uuid(4) }, contactReceiptId: uuid(5) };
  const now = new Date('2026-10-17T12:00:00.000Z');
  const context = v.context(f), config = v.config(f);
  const receipt = v.receipt(f, { notice_received_at: '2026-10-17T11:59:58.000Z',
    interview_permission_granted_at: '2026-10-17T11:59:59.000Z', issued_at: now.toISOString(),
    expires_at: '2026-10-17T12:05:00.000Z' });
  const calls = [];
  const input = () => ({ context, config, now, attestation: v.attest(receipt),
    execute: async (sql, parameters) => { calls.push({ sql, parameters }); return receipt.receipt_id; } });
  return { v, f, now, context, config, receipt, calls, input };
}

test('separate signed interview permission records explicit notice/consent and sends zero destination data', async () => {
  const f = cryptoFixture();
  assert.equal(await ingestVoiceInterviewPermission(f.input()), f.receipt.receipt_id);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].sql, 'select private.ingest_voice_interview_permission_receipt($1::jsonb) as receipt_id');
  assert.deepEqual(JSON.parse(f.calls[0].parameters[0]), f.receipt);
  assert.equal(f.receipt.purpose, 'voice_interview');
  assert.equal(f.receipt.recording_allowed, false);
  assert.ok(f.receipt.notice_received_at && f.receipt.interview_permission_granted_at);
  assert.doesNotMatch(JSON.stringify(f.calls), /destination|phone|@|\+48|cv_text|transcript|privateKey/);
});

for (const [name, mutate] of Object.entries({
  'invitation purpose': f => { f.receipt.purpose = f.context.purpose = 'verification_invitation'; },
  'contact-only proof': f => { f.receipt.proof_type = 'candidate_contact_and_permission_verified_v1'; },
  'recording permission': f => { f.receipt.recording_allowed = f.context.recording_allowed = true; },
  'non-voice channel': f => { f.receipt.channel = f.context.channel = 'email'; },
  'missing notice event': f => { delete f.receipt.notice_received_at; },
  'missing permission event': f => { delete f.receipt.interview_permission_granted_at; },
  'notice after consent': f => { f.receipt.notice_received_at = f.receipt.issued_at; },
  'consent after issuance': f => { f.receipt.interview_permission_granted_at = '2026-10-17T12:00:01.000Z'; },
  'ancient notice': f => { f.receipt.notice_received_at = '2026-10-17T11:44:59.999Z'; },
  'future issuance': f => { f.receipt.issued_at = '2026-10-17T12:00:01.000Z'; },
  'expired receipt': f => { f.receipt.expires_at = f.now.toISOString(); },
  'long lifetime': f => { f.receipt.expires_at = '2026-10-17T12:15:00.001Z'; },
  'invalid calendar': f => { f.receipt.notice_received_at = '2026-02-30T11:59:58.000Z'; },
  'noncanonical time': f => { f.receipt.notice_received_at = '2026-10-17T11:59:58Z'; },
  'negative generation': f => { f.receipt.contact_version = f.context.contact_version = -1; },
  'unsafe revision': f => { f.receipt.preference_revision = f.context.preference_revision = Number.MAX_SAFE_INTEGER; },
  'string revision': f => { f.receipt.preference_revision = f.context.preference_revision = '1'; },
  'wrong application': f => { f.context.application_id = uuid(99); },
  'wrong candidate': f => { f.context.candidate_id = uuid(99); },
  'wrong recruitment': f => { f.context.recruitment_id = uuid(99); },
  'wrong contact receipt': f => { f.context.contact_receipt_id = uuid(99); },
  'wrong generation': f => { f.context.contact_version = 2; },
  'wrong policy hash': f => { f.context.policy_sha256 = 'a'.repeat(64); },
  'wrong notice': f => { f.context.notice_version = 'other-notice'; },
  'wrong tenant key pin': f => { f.config.issuers[0].company_id = uuid(99); },
  'wrong signing key': f => { f.config.issuers[0].publicKeyPem = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }); },
  'ambiguous key pins': f => { f.config.issuers.push({ ...f.config.issuers[0] }); },
  'untrusted issuer': f => { f.receipt.issuer_id = 'operator'; },
  'unknown field': f => { f.receipt.destination = 'PRIVATE@example.invalid'; },
  'extra trusted context field': f => { f.context.noticeDelivered = true; },
  'wrong schema': f => { f.receipt.schema_version = 2; },
})) test(`${name} rejects before SQL with a generic error`, async () => {
  const f = cryptoFixture(); mutate(f);
  await assert.rejects(ingestVoiceInterviewPermission(f.input()), rejected);
  assert.equal(f.calls.length, 0);
});

test('old signature domain, payload mutations, duplicate keys and ambiguous encodings cannot mint evidence', async () => {
  for (const mode of ['old-domain', 'mutation', 'duplicate', 'whitespace', 'padding', 'short-signature']) {
    const f = cryptoFixture(), input = f.input();
    if (mode === 'old-domain') input.attestation = f.v.attest(f.receipt, RECEIPT_DOMAIN);
    if (mode === 'mutation') input.attestation.payload = Buffer.from(JSON.stringify({ ...f.receipt, nonce: randomUUID() })).toString('base64url');
    if (mode === 'duplicate') input.attestation.payload = Buffer.from(JSON.stringify(f.receipt).replace('{', '{"purpose":"voice_interview",')).toString('base64url');
    if (mode === 'whitespace') input.attestation.payload = Buffer.from(` ${JSON.stringify(f.receipt)}`).toString('base64url');
    if (mode === 'padding') input.attestation.payload += '=';
    if (mode === 'short-signature') input.attestation.signature = 'c2ln';
    await assert.rejects(ingestVoiceInterviewPermission(input), rejected, mode);
    assert.equal(f.calls.length, 0);
  }
});
test('executor failures cannot leak private diagnostics or cause automatic retry', async () => {
  const f = cryptoFixture(); let calls = 0;
  await assert.rejects(ingestVoiceInterviewPermission({ ...f.input(), execute: async () => {
    calls++; throw new Error('PRIVATE@example.invalid +48123456789');
  } }), notAccepted);
  assert.equal(calls, 1);
});

test('isolated SQL owns interview evidence, current revocation and tenant binding independently of B2 approval', async t => {
  const db = new PGlite({ extensions: { pgcrypto } }); t.after(() => db.close());
  const h = await setupRankingDatabase(db); await h.asAdmin();
  const defaultsBefore = await grantHostileInterviewPermissionDefaults(db);
  await installVoiceInterviewPermissionSchema(db);
  const v = voiceInterviewPermissionHarness(h);
  await t.test('hostile existing default ACLs cannot mint unsigned authority and remain unchanged on other objects', async () => {
    await assertHostileInterviewDefaultsClosed(db, h, v, defaultsBefore);
  });
  await t.test('default-deny roles cannot directly mint/read permission or call its private status', async () => {
    await h.asAdmin();
    const role = (await db.query("select rolcanlogin,rolinherit,rolsuper,rolbypassrls from pg_roles where rolname='voice_permission_verifier'")).rows[0];
    assert.deepEqual(role, { rolcanlogin: false, rolinherit: false, rolsuper: false, rolbypassrls: false });
    assert.equal((await db.query("select count(*)::int n from pg_auth_members where roleid='voice_permission_verifier'::regrole or member='voice_permission_verifier'::regrole")).rows[0].n, 0);
    for (const role of ['anon', 'authenticated', 'screening_worker', 'contact_verifier', 'voice_permission_verifier']) {
      const row = (await db.query(`select
        has_function_privilege($1,'private.ingest_voice_interview_permission_receipt(jsonb)','EXECUTE') as ingest,
        has_function_privilege($1,'private.voice_interview_permission_status(uuid,uuid,uuid)','EXECUTE') as status,
        has_table_privilege($1,'private.voice_interview_permission_receipts','SELECT,INSERT,UPDATE,DELETE') as rows`, [role])).rows[0];
      assert.deepEqual(row, { ingest: role === 'voice_permission_verifier', status: false, rows: false }, role);
    }
    const f = await v.ready(); await h.asUser(f.owner);
    await assert.rejects(db.query('select private.ingest_voice_interview_permission_receipt($1::jsonb)', [JSON.stringify(v.receipt(f))]), sqlCode('42501'));
    await assert.rejects(db.query('select * from private.voice_interview_permission_receipts'), sqlCode('42501'));
  });
  await t.test('B2 approval alone cannot imply interview permission; a separate valid receipt binds a different interview notice', async () => {
    const f = await v.ready();
    assert.equal((await v.contact.status(f.communicationId)).is_current, true);
    assert.equal(await v.status(f, randomUUID()), 'interview_permission_unavailable');
    const r = v.receipt(f), id = await v.ingest(f, r);
    assert.equal(id, r.receipt_id); assert.equal(await v.status(f, id), null);
    assert.notEqual(r.notice_version, f.contactReceipt.notice_version);
    const row = (await db.query('select * from private.voice_interview_permission_receipts where id=$1', [id])).rows[0];
    assert.equal(row.application_id, f.application.id); assert.equal(row.contact_receipt_id, f.contactReceiptId);
    assert.equal(row.recording_allowed, false); assert.equal(row.purpose, 'voice_interview');
    assert.doesNotMatch(JSON.stringify(row), /destination|\+48221234567|PRIVATE original CV/);
  });
  await t.test('exact replay preserves identity and never restores withdrawn permission', async () => {
    const f = await v.ready(), r = v.receipt(f), id = await v.ingest(f, r);
    assert.equal(await v.ingest(f, r), id);
    await assert.rejects(v.ingest(f, { ...r, nonce: randomUUID() }), notAccepted);
    await assert.rejects(v.ingest(f, { ...r, receipt_id: randomUUID() }), notAccepted);
    await v.revoke(f, id);
    assert.equal(await v.ingest(f, r), id); assert.equal(await v.status(f, id), 'interview_permission_revoked');
    await h.asUser(f.owner); assert.equal((await v.contact.status(f.communicationId)).is_current, true);
    await h.asAdmin();
    assert.equal((await db.query('select count(*)::int n from private.voice_interview_permission_receipts where company_id=$1', [f.companyId])).rows[0].n, 1);
    await assert.rejects(db.query('delete from private.voice_interview_permission_revocations where receipt_id=$1', [id]), sqlCode('42501'));
    await assert.rejects(db.query('update private.voice_interview_permission_receipts set recording_allowed=true where id=$1', [id]), sqlCode('42501'));
  });
  await t.test('immutable registries default to disabled and may only be permanently disabled', async () => {
    for (const option of ['policyEnabled', 'issuerEnabled']) {
      const f = await v.ready({ [option]: false }); await assert.rejects(v.ingest(f), notAccepted);
    }
    const f = await v.ready(), id = await v.ingest(f); await h.asAdmin();
    await assert.rejects(db.query("update private.voice_interview_permission_policies set policy_sha256=repeat('a',64) where company_id=$1", [f.companyId]), sqlCode('42501'));
    await db.query('update private.voice_interview_permission_policies set enabled=false where company_id=$1', [f.companyId]);
    await assert.rejects(db.query('update private.voice_interview_permission_policies set enabled=true where company_id=$1', [f.companyId]), sqlCode('42501'));
    await assert.rejects(db.query('delete from private.voice_interview_permission_issuers where company_id=$1', [f.companyId]), sqlCode('42501'));
    assert.equal(await v.status(f, id), 'interview_policy_unavailable');
    const defaults = (await db.query(`select count(*)::int n from information_schema.columns where table_schema='private'
      and table_name in ('voice_interview_permission_policies','voice_interview_permission_issuers') and column_name='enabled' and column_default='false'`)).rows[0].n;
    assert.equal(defaults, 2);
  });
  await t.test('SQL validates malformed raw receipts independently of TypeScript and rolls failed inserts back', async () => {
    const f = await v.ready(), r = v.receipt(f);
    const invalid = [null, [], { ...r, destination: 'PRIVATE@example.invalid' }, { ...r, recording_allowed: 'false' },
      { ...r, recording_allowed: true }, { ...r, purpose: 'verification_invitation' }, { ...r, schema_version: '1' },
      { ...r, notice_received_at: null }, { ...r, notice_received_at: '2026-02-30T00:00:00.000Z' },
      { ...r, notice_received_at: r.expires_at }, { ...r, interview_permission_granted_at: r.expires_at },
      { ...r, contact_version: 0 }, { ...r, preference_revision: '1' }, { ...r, global_permission_revision: 9007199254740991 },
      { ...r, expires_at: new Date(Date.now() - 1000).toISOString() },
      { ...r, issued_at: new Date(Date.now() + 10000).toISOString() }];
    for (const raw of invalid) {
      await v.asVerifier();
      await assert.rejects(db.query('select private.ingest_voice_interview_permission_receipt($1::jsonb)', [JSON.stringify(raw)]), sqlRejected);
    }
    await h.asAdmin(); assert.equal((await db.query('select count(*)::int n from private.voice_interview_permission_receipts where company_id=$1', [f.companyId])).rows[0].n, 0);
  });
  await t.test('same-company other application, foreign tenant/contact, generation and revisions cannot be rebound', async () => {
    const f = await v.ready(), other = await v.ready(), r = v.receipt(f);
    await h.asUser(f.owner); const sameCompany = await h.candidate(f);
    for (const changes of [{ application_id: sameCompany.application.id }, { application_id: other.application.id },
      { company_id: other.companyId }, { candidate_id: other.candidate.id }, { recruitment_id: other.recruitment.id },
      { contact_receipt_id: other.contactReceiptId }, { contact_version: 2 }, { preference_revision: 0 },
      { global_permission_revision: 1 }, { scoped_permission_revision: 1 }]) {
      await v.asVerifier(); await assert.rejects(db.query('select private.ingest_voice_interview_permission_receipt($1::jsonb)',
        [JSON.stringify({ ...r, ...changes })]), sqlRejected);
    }
    const id = await v.ingest(f, r);
    assert.equal(await v.status(f, id, sameCompany.application.id), 'interview_permission_unavailable');
    assert.equal(await v.status(f, id, f.application.id, other.contactReceiptId), 'interview_permission_unavailable');
  });
  for (const kind of ['global-deny', 'scoped-deny', 'preferences', 'contact-replacement', 'contact-edit',
    'contact-issuer', 'contact-policy', 'interview-issuer', 'interview-policy', 'application', 'recruitment']) {
    await t.test(`${kind} invalidates a previously valid interview receipt`, async () => {
      const f = await v.ready(), id = await v.ingest(f); assert.equal(await v.status(f, id), null);
      await h.asUser(f.owner);
      if (kind === 'global-deny' || kind === 'scoped-deny') await v.contact.permission(f, 'revoked', 0, randomUUID(), kind === 'global-deny' ? null : f.recruitment.id, 'voice');
      if (kind === 'preferences') await v.contact.preferences(f, 1);
      if (kind === 'contact-edit') await db.query("update public.candidates set phone='+48229999999' where id=$1", [f.candidate.id]);
      if (kind === 'contact-replacement') {
        const bound = { channel: 'voice', destination: '+48229999999', expected_contact_version: 1, preference_revision: 1 };
        await v.contact.ingest(f, v.contact.receipt(f, bound), { context: bound });
      }
      if (kind === 'application') await db.query("update public.applications set status='withdrawn' where id=$1", [f.application.id]);
      if (kind === 'recruitment') await db.query("update public.recruitments set status='closed' where id=$1", [f.recruitment.id]);
      const tables = { 'contact-issuer': 'contact_trusted_issuers', 'contact-policy': 'contact_policy_templates',
        'interview-issuer': 'voice_interview_permission_issuers', 'interview-policy': 'voice_interview_permission_policies' };
      if (tables[kind]) { await h.asAdmin(); await db.query(`update private.${tables[kind]} set enabled=false where company_id=$1`, [f.companyId]); }
      assert.notEqual(await v.status(f, id), null);
    });
  }
  await t.test('an already frozen synthetic candidate cannot gain interview evidence and may still withdraw it', async () => {
    const f = await v.ready(), id = await v.ingest(f); await h.asAdmin();
    // Seed the existing, typed R2 frozen-state graph as database owner. This test
    // verifies consumption of that state, not authorization of a new erasure.
    const ticket = (await db.query(`insert into private.erasure_preview_tickets
      (company_id,actor_id,anchor_candidate_id,scope_kind,candidate_ids,manifest_hash,generations,expires_at)
      values($1,$2,$3,'candidate_record',$4::uuid[],repeat('0',64),'{}',now()+interval '5 minutes') returning id`,
    [f.companyId, f.owner, f.candidate.id, [f.candidate.id]])).rows[0].id;
    const request = (await db.query(`insert into private.erasure_requests
      (company_id,actor_id,anchor_candidate_id,candidate_ids,scope_kind,preview_ticket_id,manifest_hash,policy_revision,resolution_revision,status,generation)
      values($1,$2,$3,$4::uuid[],'candidate_record',$5,repeat('0',64),1,0,'authorized',1) returning id`,
    [f.companyId, f.owner, f.candidate.id, [f.candidate.id], ticket])).rows[0].id;
    await db.query(`insert into private.erasure_candidate_lifecycle(company_id,candidate_id,generation,status,request_id)
      values($1,$2,1,'frozen',$3)`, [f.companyId, f.candidate.id, request]);
    assert.equal(await v.status(f, id), 'candidate_unavailable');
    await assert.rejects(v.ingest(f), notAccepted);
    await v.revoke(f, id); assert.equal(await v.status(f, id), 'interview_permission_revoked');
  });
  await t.test('restore isolation blocks existing authority and new receipts; new graph does not bypass erasure inventory', async () => {
    const f = await v.ready(), id = await v.ingest(f); await h.asAdmin();
    await db.query('update private.erasure_execution_config set restore_isolated=true where singleton');
    try {
      assert.equal(await v.status(f, id), 'candidate_unavailable');
      await assert.rejects(v.ingest(f), notAccepted);
      await assert.rejects(v.revoke(f, id), sqlRejected);
    } finally { await h.asAdmin(); await db.query('update private.erasure_execution_config set restore_isolated=false where singleton'); }
    await h.asUser(f.owner);
    const preview = (await db.query('select public.preview_candidate_erasure($1) as preview', [f.candidate.id])).rows[0].preview;
    assert.ok(preview.blockers.includes('schema_dependency_unknown'));
  });
});

test('real PostgreSQL interview permission uses the same candidate and registry lock boundary', async t => {
  const maintenanceUrl = process.env.SCREENING_TEST_DATABASE_URL;
  assert.ok(maintenanceUrl, 'SCREENING_TEST_DATABASE_URL required; no PGlite concurrency substitute');
  const databaseName = `voice_interview_permission_${process.pid}`;
  const configuration = name => ({ ...parse(maintenanceUrl), database: name });
  const maintenance = new Client(configuration('postgres')); await maintenance.connect();
  await maintenance.query(`drop database if exists ${databaseName}`); await maintenance.query(`create database ${databaseName}`); await maintenance.end();
  const clients = [];
  const connect = async () => {
    const db = new Client(configuration(databaseName)); await db.connect(); db.exec = sql => db.query(sql); clients.push(db);
    await db.query("set statement_timeout='10s';set lock_timeout='2s'"); return db;
  };
  t.after(async () => {
    await Promise.all(clients.map(db => db.end().catch(() => {})));
    const cleanup = new Client(configuration('postgres')); await cleanup.connect();
    await cleanup.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1', [databaseName]);
    await cleanup.query(`drop database if exists ${databaseName}`); await cleanup.end();
  });
  const db = await connect(), h = await setupRankingDatabase(db); await h.asAdmin();
  const defaultsBefore = await grantHostileInterviewPermissionDefaults(db);
  await installVoiceInterviewPermissionSchema(db);
  const v = voiceInterviewPermissionHarness(h);
  const session = async () => {
    const db = await connect(), h = createRankingHarness(db); await h.asUser();
    return { db, h, v: voiceInterviewPermissionHarness(h) };
  };
  await t.test('real PostgreSQL closes all hostile inherited ACLs before enabling the pinned verifier', async () => {
    await assertHostileInterviewDefaultsClosed(db, h, v, defaultsBefore);
  });
  for (const operation of ['ingest', 'revoke']) {
    await t.test(`${operation} first: an actual restore UPDATE waits until the evidence transaction commits`, async () => {
      const f = await v.ready(), r = v.receipt(f), a = await session(), b = await session();
      if (operation === 'revoke') await v.ingest(f, r);
      await a.db.query('begin'); await b.h.asAdmin(); await h.asAdmin();
      let pendingRestore;
      try {
        if (operation === 'ingest') assert.equal(await a.v.ingest(f, r), r.receipt_id);
        else await a.v.revoke(f, r.receipt_id);
        const pid = (await b.db.query('select pg_backend_pid() as pid')).rows[0].pid;
        let restoreCompleted = false;
        pendingRestore = b.db.query('update private.erasure_execution_config set restore_isolated=true where singleton')
          .then(result => { restoreCompleted = true; return { result }; }, error => ({ error }));
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          waiting = (await db.query("select wait_event_type='Lock' as waiting from pg_catalog.pg_stat_activity where pid=$1", [pid])).rows[0]?.waiting;
          if (waiting || restoreCompleted) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(waiting, true, 'restore must wait on the transaction-held singleton lock');
        assert.equal(restoreCompleted, false, 'restore cannot commit between receipt ingestion/withdrawal and COMMIT');
        assert.equal((await db.query('select restore_isolated from private.erasure_execution_config where singleton')).rows[0].restore_isolated, false);
        await a.db.query('commit');
        const result = await pendingRestore;
        assert.ifError(result.error); assert.equal(result.result.rowCount, 1);
        assert.equal((await db.query('select restore_isolated from private.erasure_execution_config where singleton')).rows[0].restore_isolated, true);
      } finally {
        await a.db.query('rollback');
        if (pendingRestore) await pendingRestore;
        await h.asAdmin(); await db.query('update private.erasure_execution_config set restore_isolated=false where singleton');
      }
    });
    await t.test(`restore first: ${operation} rejects a locked or committed restore gate`, async () => {
      const f = await v.ready(), r = v.receipt(f), a = await session(), b = await session();
      if (operation === 'revoke') await v.ingest(f, r);
      const action = () => operation === 'ingest' ? b.v.ingest(f, r) : b.v.revoke(f, r.receipt_id);
      const denial = operation === 'ingest' ? notAccepted : sqlRejected;
      await a.h.asAdmin(); await a.db.query('begin');
      try {
        await a.db.query('update private.erasure_execution_config set restore_isolated=true where singleton');
        await assert.rejects(action(), denial);
        await a.db.query('commit');
        await assert.rejects(action(), denial);
        await h.asAdmin();
        const table = operation === 'ingest' ? 'voice_interview_permission_receipts' : 'voice_interview_permission_revocations';
        assert.equal((await db.query(`select count(*)::int n from private.${table} where company_id=$1`, [f.companyId])).rows[0].n, 0);
      } finally {
        await a.db.query('rollback'); await h.asAdmin();
        await db.query('update private.erasure_execution_config set restore_isolated=false where singleton');
      }
    });
  }
  await t.test('a missing singleton restore configuration denies ingestion, replay and withdrawal', async () => {
    const f = await v.ready(), r = v.receipt(f), id = await v.ingest(f, r), a = await session();
    await a.h.asAdmin(); await a.db.query('begin');
    try {
      await a.db.query('delete from private.erasure_execution_config where singleton');
      for (const action of [() => a.v.ingest(f), () => a.v.ingest(f, r), () => a.v.revoke(f, id)]) {
        await a.db.query('savepoint denied');
        await assert.rejects(action(), error => notAccepted(error) || sqlRejected(error));
        await a.db.query('rollback to savepoint denied');
      }
    } finally { await a.db.query('rollback'); }
    assert.equal(await v.status(f, id), null);
  });
  await t.test('two identical receipts have one winner and retry returns the single persisted identity', async () => {
    const f = await v.ready(), r = v.receipt(f), a = await session(), b = await session();
    await a.db.query('begin'); assert.equal(await a.v.ingest(f, r), r.receipt_id);
    await assert.rejects(b.v.ingest(f, r), notAccepted); await a.db.query('commit');
    assert.equal(await b.v.ingest(f, r), r.receipt_id);
    await h.asAdmin(); assert.equal((await db.query('select count(*)::int n from private.voice_interview_permission_receipts where company_id=$1', [f.companyId])).rows[0].n, 1);
  });
  for (const first of ['receipt', 'revoke']) await t.test(`${first} first: global voice withdrawal cannot leave current interview authority`, async () => {
    const f = await v.ready(), r = v.receipt(f), a = await session(), b = await session();
    await a.db.query('begin');
    if (first === 'receipt') {
      await a.v.ingest(f, r);
      await assert.rejects(b.v.contact.permission(f, 'revoked', 0, randomUUID(), null, 'voice'), sqlCode('PT409'));
      await a.db.query('commit'); await b.v.contact.permission(f, 'revoked', 0, randomUUID(), null, 'voice');
      assert.equal(await v.status(f, r.receipt_id), 'permission_denied');
    } else {
      await a.v.contact.permission(f, 'revoked', 0, randomUUID(), null, 'voice');
      await assert.rejects(b.v.ingest(f, r), notAccepted); await a.db.query('commit');
      await assert.rejects(b.v.ingest(f, r), notAccepted);
    }
  });
  for (const first of ['receipt', 'policy']) await t.test(`${first} first: policy withdrawal is serialized against evidence ingestion`, async () => {
    const f = await v.ready(), r = v.receipt(f), a = await session(), b = await session();
    await a.h.asAdmin(); await a.db.query('begin');
    if (first === 'receipt') {
      await a.v.ingest(f, r); await b.h.asAdmin();
      await assert.rejects(b.db.query('select 1 from private.voice_interview_permission_policies where company_id=$1 for update nowait', [f.companyId]), sqlCode('55P03'));
      await a.db.query('commit');
      await b.db.query('update private.voice_interview_permission_policies set enabled=false where company_id=$1', [f.companyId]);
      assert.equal(await v.status(f, r.receipt_id), 'interview_policy_unavailable');
    } else {
      await a.db.query('update private.voice_interview_permission_policies set enabled=false where company_id=$1', [f.companyId]);
      await assert.rejects(b.v.ingest(f, r), notAccepted); await a.db.query('commit');
      await assert.rejects(b.v.ingest(f, r), notAccepted);
    }
  });
  await t.test('receipt-specific withdrawal locks candidate and replay cannot recover revoked authority', async () => {
    const f = await v.ready(), r = v.receipt(f), id = await v.ingest(f, r), a = await session(), b = await session();
    await a.h.asAdmin(); await a.db.query('begin'); await a.v.revoke(f, id);
    await assert.rejects(b.v.ingest(f, r), notAccepted); await a.db.query('commit');
    assert.equal(await b.v.ingest(f, r), id); assert.equal(await v.status(f, id), 'interview_permission_revoked');
  });
  await t.test('repeatable-read cannot use a stale consent snapshot', async () => {
    const f = await v.ready(), r = v.receipt(f), a = await session();
    await a.db.query('begin isolation level repeatable read');
    try { await assert.rejects(a.v.ingest(f, r), notAccepted); }
    finally { await a.db.query('rollback'); }
  });
  await t.test('wall-clock expiry invalidates permission even inside an earlier-started transaction', async () => {
    const f = await v.ready(), a = await session();
    const r = v.receipt(f, { expires_at: new Date(Date.now() + 1000).toISOString() });
    const id = await v.ingest(f, r);
    await a.h.asAdmin(); await a.db.query('begin');
    try {
      assert.equal(await a.v.status(f, id), null);
      await a.db.query('select pg_sleep(1.1)');
      assert.equal(await a.v.status(f, id), 'interview_permission_expired');
    } finally { await a.db.query('rollback'); }
  });
});
