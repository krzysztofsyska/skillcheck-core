// R6-1c part 2: SC-010-C interview permission receipts, the SC-019 voice interview
// pool (no package or price) and SC-010-C offline preparations as a real migration
// (20261119120000_r6_voice_permission_pool_r19.sql) on the full checked-in chain.
// Native disposable PostgreSQL only; synthetic data; no provider, no API grant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { activeBoot, users } from './helpers/competency-active-fixture.mjs';
import { seedSyntheticPolicy } from './helpers/sc19-migration-fixture.mjs';
import { lifecycleHarness, lifecycleRules } from './helpers/erasure-lifecycle-fixture.mjs';
import { voiceInterviewPermissionHarness } from './helpers/voice-interview-permission-fixture.mjs';
import { behaviorGuideDefinitions } from '../lib/behavior-guide.ts';
import { canonicalVoiceSourceSnapshot } from '../lib/voice/plan-persistence-contract.ts';
import { trustedVoiceTemplateDigest } from '../lib/voice/template-registry.ts';
import { reconstructTrustedVoiceSource } from '../lib/voice/trusted-source-verifier.ts';
import { prepareOfflineVoiceDraft, cancelOfflineVoicePreparation } from '../lib/voice/offline-preparation.ts';
import { syntheticRetellProof } from './helpers/voice-preparation-provider-fixture.mjs';

// Full current chain: R24 (SC-003a criterion review history) on top of R23 (R6-1c part 7 voice transcripts), which builds on this step.
const signature = 'bc5fe11ba2c0cd33015c00b2283403532f338630f3e9661b91847d6979726235';
const candidateTables = ['private.voice_interview_permission_receipts', 'private.voice_interview_permission_revocations',
  'private.sc010c_voice_preparations', 'private.sc010c_voice_preparation_requests'];
const sharedTables = ['private.voice_interview_permission_policies', 'private.voice_interview_permission_issuers',
  'private.sc19_voice_entitlements'];
const newTables = [...candidateTables, ...sharedTables];
const entryPoints = ['private.ingest_voice_interview_permission_receipt(jsonb)', 'private.voice_interview_permission_status(uuid,uuid,uuid)',
  'private.sc010c_lock_voice_contact(uuid,uuid,uuid,uuid)', 'private.sc19_voice_entitlement_eligible(private.sc19_voice_entitlements)',
  'private.erasure_voice_lock_entitlements(uuid)', 'private.erasure_voice_refund_deleted()'];
const behaviors = behaviorGuideDefinitions.map((x, i) => x.label + ': ' + (i < 4 ? 'Wysoki' : 'Standardowy'));
const ratings = ['insufficient_data', 'meets', 'below', 'meets', 'above'];
const digest = value => createHash('sha256').update(value).digest('hex');

test('R6-1c part 2: voice permission, pool and preparation migration is closed and erased with the candidate', async t => {
  const { db, h, x } = await activeBoot(t, { fullChain: true });
  const one = async (sql, args) => (await db.query(sql, args)).rows[0].v;
  const asServer = async actor => { await h.asAdmin(); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [actor]); };
  // Full-chain analyses need synthetic credits; grant them to every seeded tenant.
  let policySeeded = false;
  const credited = { ...h, seed: async (owner = users.owner, ...rest) => {
    const f = await h.seed(owner, ...rest);
    await h.asAdmin();
    if (!policySeeded) { await seedSyntheticPolicy(db); policySeeded = true; }
    await db.query('select private.sc19_grant_paid($1,$2)', [f.companyId, `synthetic-voice-${randomUUID()}`]);
    await h.asUser(owner);
    return f;
  } };
  const permission = voiceInterviewPermissionHarness(credited);

  // Shortlisted candidate with B2 voice contact evidence, an interview permission
  // receipt and a released voice plan (R18), ready for an offline preparation.
  const ready = async tenant => {
    let f = await permission.ready({ tenant, requiredBehaviors: [...behaviors], ratings: [...ratings] });
    const permissionReceiptId = await permission.ingest(f, permission.receipt(f));
    f = { ...f, permissionReceiptId };
    await asServer(f.owner);
    const source = await reconstructTrustedVoiceSource(db, { companyId: f.companyId, applicationId: f.application.id,
      analysisId: f.analysis_id, reviewId: f.reviewId, shortlistEntryId: f.shortlistId });
    const planId = await one(`insert into public.voice_plan_versions
      (company_id,recruitment_id,application_id,position_id,analysis_id,screening_review_id,shortlist_entry_id,
       plan_version,source_hash,envelope_hash,source_snapshot,plan_envelope,template_version,created_by,
       retention_policy_version,retention_deadline)
      values($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10::jsonb,$11::jsonb,'skillcheck-voice-plan-v1',$12,'synthetic-v1',
       clock_timestamp()+interval '30 days') returning id as v`,
    [f.companyId, f.recruitment.id, f.application.id, f.position.id, f.analysis_id, f.reviewId, f.shortlistId,
      source.sourceHash, source.planContractHash,
      JSON.stringify(canonicalVoiceSourceSnapshot(source.sourceBinding, source.planSourceFingerprint)), JSON.stringify(source), f.owner]);
    const reviewId = await one('select private.sc012b_review_plan($1,0,$2,$3,null,$4) as v', [planId, source.sourceHash, 'approved', randomUUID()]);
    const releaseId = await one('select private.sc012b_release_plan($1,$2,$3,null,null,$4) as v', [planId, reviewId, source.sourceHash, randomUUID()]);
    const pointerVersion = await one(`select pointer_version as v from private.voice_plan_current_releases
      where company_id=$1 and application_id=$2`, [f.companyId, f.application.id]);
    return { ...f, planId, releaseId, pointerVersion };
  };
  const grant = async (f, total) => {
    await h.asAdmin();
    return one(`insert into private.sc19_voice_entitlements
      (company_id,total,grant_reference,valid_from,expires_at,active,company_verified,
       company_verification_reference,company_verification_expires_at,grant_verified)
      values($1,$2,$3,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 day',true,true,$4,
       clock_timestamp()+interval '1 hour',true) returning id as v`, [f.companyId, total, randomUUID(), randomUUID()]);
  };
  // Trusted server preparation in one transaction: lock and recheck the contact
  // and permission authority, hold one pool unit, persist the operation and its
  // request key. The deferred currentness guard re-verifies everything at COMMIT.
  const prepare = async (f, entitlementId) => {
    await asServer(f.owner);
    await db.query('begin');
    try {
      const contact = await one('select private.sc010c_lock_voice_contact($1,$2,$3,$4) as v',
        [f.companyId, f.communicationId, f.approvalId, f.permissionReceiptId]);
      await db.query('update private.sc19_voice_entitlements set reserved=reserved+1 where company_id=$1 and id=$2', [f.companyId, entitlementId]);
      const binding = JSON.stringify({ version: 1, companyId: f.companyId, applicationId: f.application.id,
        planId: f.planId, releaseId: f.releaseId, entitlementId, synthetic: true });
      const operationId = await one(`insert into private.sc010c_voice_preparations
        (company_id,recruitment_id,candidate_id,application_id,communication_id,approval_id,permission_receipt_id,
         contact_receipt_id,contact_point_id,contact_version,plan_id,release_id,pointer_version,entitlement_id,
         binding_json,binding_hash,provider_key_envelope,provider_key_digest,created_by)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17::jsonb,$18,$19) returning id as v`,
      [f.companyId, contact.recruitmentId, contact.candidateId, contact.applicationId, f.communicationId, f.approvalId,
        f.permissionReceiptId, contact.contactReceiptId, contact.contactPointId, contact.contactVersion, f.planId, f.releaseId,
        f.pointerVersion, entitlementId, binding, digest(binding),
        JSON.stringify({ algorithm: 'A256GCM', key_id: 'synthetic-key-v1', iv: randomBytes(12).toString('base64url'),
          ciphertext: randomBytes(32).toString('base64url'), tag: randomBytes(16).toString('base64url') }),
        digest(randomUUID()), f.owner]);
      await db.query(`insert into private.sc010c_voice_preparation_requests(company_id,actor_id,request_key,operation_id,binding_hash)
        values($1,$2,$3,$4,$5)`, [f.companyId, f.owner, randomUUID(), operationId, digest(binding)]);
      await db.query('commit');
      return operationId;
    } catch (error) { await db.query('rollback'); throw error; }
  };
  const quota = async id => { await h.asAdmin(); return (await db.query('select * from private.sc19_voice_entitlements where id=$1', [id])).rows[0]; };
  const counts = async f => {
    await h.asAdmin();
    const result = {};
    for (const table of candidateTables) result[table] = await one(`select count(*)::int as v from ${table} t
      where t.company_id=$1 and $2=any(private.erasure_row_candidates('${table}',to_jsonb(t)))`, [f.companyId, f.candidate.id]);
    return result;
  };

  await t.test('installs inventory R19, no package or price column, nothing granted to API roles', async () => {
    await h.asAdmin();
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
    const known = await one('select known_tables as v from private.erasure_inventory_baseline_r19 where singleton');
    for (const table of [...newTables, 'private.erasure_inventory_baseline_r19']) assert.ok(known.includes(table), table);
    const columns = (await db.query(`select attname from pg_attribute where attrelid='private.sc19_voice_entitlements'::regclass
      and attnum>0 and not attisdropped`)).rows.map(r => r.attname);
    for (const forbidden of ['package', 'price', 'free_trial_approved', 'paid_settlement_verified']) assert.ok(!columns.includes(forbidden), forbidden);
    for (const table of newTables) {
      assert.equal(await one(`select count(*)::int as v from ${table}`), 0, `${table} is not seeded`);
      assert.equal(await one('select c.relrowsecurity and c.relforcerowsecurity as v from pg_class c where c.oid=$1::regclass', [table]), true, table);
    }
    for (const role of ['anon', 'authenticated', 'service_role', 'voice_permission_verifier']) {
      if (!await one('select to_regrole($1) is not null as v', [role])) continue;
      for (const table of newTables) assert.equal(await one('select has_table_privilege($1,$2,$3) as v',
        [role, table, 'select,insert,update,delete,truncate,references,trigger']), false, `${role} ${table}`);
      for (const fn of entryPoints) assert.equal(await one('select has_function_privilege($1,$2,$3) as v', [role, fn, 'execute']),
        role === 'voice_permission_verifier' && fn.startsWith('private.ingest_'), `${role} ${fn}`);
    }
    for (const fn of entryPoints.filter(f => !f.includes('eligible'))) {
      assert.equal(await one('select prosecdef as v from pg_proc where oid=$1::regprocedure', [fn]), true, fn);
      assert.equal(await one('select proconfig[1] as v from pg_proc where oid=$1::regprocedure', [fn]), 'search_path=""', fn);
    }
    assert.equal(await one("select rolcanlogin or rolinherit or rolbypassrls as v from pg_roles where rolname='voice_permission_verifier'"), false);
    await h.asUser(users.owner);
    await assert.rejects(db.query('select * from private.sc19_voice_entitlements'), e => e.code === '42501');
    await assert.rejects(db.query('select private.ingest_voice_interview_permission_receipt($1)', ['{}']), e => e.code === '42501');
    await h.asUser(null, 'anon');
    await assert.rejects(db.query('select * from private.voice_interview_permission_receipts'), e => e.code === '42501');
    await h.asAdmin();
  });

  await h.asAdmin();
  await db.query('insert into private.voice_plan_template_catalog(version,manifest_digest,active) values($1,$2,true)',
    ['skillcheck-voice-plan-v1', trustedVoiceTemplateDigest('skillcheck-voice-plan-v1')]);
  const a = await ready();
  const b = await ready(a);
  let pool, policiesBefore;

  await t.test('interview permission: verifier ingests, status is current, revocation is final', async () => {
    assert.equal(await permission.status(a, a.permissionReceiptId), null);
    const extra = await permission.ingest(b, permission.receipt(b));
    await permission.revoke(b, extra);
    assert.equal(await permission.status(b, extra), 'interview_permission_revoked');
    await h.asAdmin();
    await assert.rejects(db.query('delete from private.voice_interview_permission_receipts where id=$1', [extra]), e => e.code === '42501');
    await assert.rejects(db.query('delete from private.voice_interview_permission_revocations where receipt_id=$1', [extra]), e => e.code === '42501');
    assert.equal(await permission.status(b, b.permissionReceiptId), null, 'another receipt stays current');
  });

  await t.test('voice pool: immutable grant, one-unit transitions, no deletion', async () => {
    pool = await grant(a, 3);
    await h.asAdmin();
    assert.equal(await one('select private.sc19_voice_entitlement_eligible(e) as v from private.sc19_voice_entitlements e where id=$1', [pool]), true);
    await assert.rejects(db.query('update private.sc19_voice_entitlements set total=4 where id=$1', [pool]), e => e.code === '55000');
    await assert.rejects(db.query('update private.sc19_voice_entitlements set reserved=reserved+2 where id=$1', [pool]), e => e.code === '55000');
    await assert.rejects(db.query('delete from private.sc19_voice_entitlements where id=$1', [pool]), e => e.code === '42501');
    await assert.rejects(db.query(`insert into private.sc19_voice_entitlements(company_id,total,grant_reference,expires_at,used)
      values($1,1,$2,clock_timestamp()+interval '1 day',1)`, [a.companyId, randomUUID()]), e => e.code === '22023');
    const unverified = await one(`insert into private.sc19_voice_entitlements(company_id,total,grant_reference,expires_at,active)
      values($1,1,$2,clock_timestamp()+interval '1 day',true) returning id as v`, [a.companyId, randomUUID()]);
    await assert.rejects(db.query('update private.sc19_voice_entitlements set reserved=1 where id=$1', [unverified]), e => e.code === 'PT402');
  });

  await t.test('offline preparation holds one unit per operation and is immutable outside the purge', async () => {
    const first = await prepare(a, pool);
    await prepare(b, pool);
    assert.equal((await quota(pool)).reserved, 2);
    await h.asAdmin();
    await assert.rejects(db.query('delete from private.sc010c_voice_preparations where id=$1', [first]), e => e.code === '42501');
    await assert.rejects(db.query("update private.sc010c_voice_preparations set binding_hash=$2 where id=$1", [first, 'f'.repeat(64)]), e => e.code === '42501');
    await assert.rejects(db.query('delete from private.sc010c_voice_preparation_requests where operation_id=$1', [first]), e => e.code === '42501');
    // Withdrawal after preparation stays possible and is erased with the candidate.
    await permission.revoke(a, a.permissionReceiptId);
    assert.deepEqual(Object.values(await counts(a)), [1, 1, 1, 1]);
    policiesBefore = (await db.query(`select (select count(*)::int from private.voice_interview_permission_policies) p,
      (select count(*)::int from private.voice_interview_permission_issuers) i`)).rows[0];
  });

  await t.test('candidate erasure inventories R19 rows, purges them and refunds only that held unit', async () => {
    await h.asAdmin();
    const rows = (await db.query('select adapter from private.erasure_inventory_rows($1,$2)', [a.companyId, [a.candidate.id]])).rows;
    for (const table of candidateTables) assert.ok(rows.some(r => r.adapter === table), table);
    assert.equal(rows.filter(r => candidateTables.includes(r.adapter)).length, 4);
    const before = await quota(pool);
    const life = lifecycleHarness(h);
    await h.asUser(a.owner);
    await life.policy(a, 0, lifecycleRules);
    a.resolutionId = await life.resolve(a, [a.candidate.id]);
    await x.configure();
    const frozen = await life.freeze(a);
    await x.transition(frozen.request_id, 0, 'authorized');
    await x.transition(frozen.request_id, 1, 'erasing');
    await x.purge(frozen.request_id, 2);
    await h.asAdmin();
    for (const table of ['private.voice_interview_permission_receipts', 'private.sc010c_voice_preparations'])
      assert.equal(await one(`select count(*)::int as v from ${table} where candidate_id=$1`, [a.candidate.id]), 0, table);
    assert.equal(await one('select count(*)::int as v from private.voice_interview_permission_revocations where receipt_id=$1',
      [a.permissionReceiptId]), 0);
    assert.equal(await one('select count(*)::int as v from private.sc010c_voice_preparations where company_id=$1', [a.companyId]), 1);
    assert.equal(await one('select count(*)::int as v from private.sc010c_voice_preparation_requests where company_id=$1', [a.companyId]), 1);
    assert.equal(await one('select count(*)::int as v from public.candidates where id=$1', [a.candidate.id]), 0);
    const after = await quota(pool);
    assert.equal(after.reserved, before.reserved - 1, 'exactly one held unit is refunded');
    assert.equal(after.used, before.used);
    for (const key of ['id', 'company_id', 'total', 'grant_reference', 'created_at']) assert.deepEqual(after[key], before[key], key);
    assert.deepEqual(Object.values(await counts(b)), [2, 1, 1, 1], 'same-company survivor keeps its rows');
    assert.deepEqual((await db.query(`select (select count(*)::int from private.voice_interview_permission_policies) p,
      (select count(*)::int from private.voice_interview_permission_issuers) i`)).rows[0], policiesBefore, 'configuration is not candidate data');
  });

  await t.test('R6-1c part 3: the offline preparation module runs on the migrated pool and binds no package', async () => {
    const c = await ready(a);
    const own = await grant(c, 2);
    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = async () => { networkCalls++; throw new Error('External network forbidden'); };
    try {
      const proof = await syntheticRetellProof();
      const vaultKey = randomBytes(32);
      const deps = () => ({ retell: proof.retell, verifiedAgent: proof.verifiedAgent,
        contactVault: structuredClone(c.contactConfig),
        idempotencyVault: { keyId: 'synthetic-offline-provider-key-v1', encryptionKey: vaultKey } });
      const request = { communicationId: c.communicationId, approvalId: c.approvalId, permissionReceiptId: c.permissionReceiptId,
        planId: c.planId, releaseId: c.releaseId, pointerVersion: Number(c.pointerVersion), entitlementId: own, requestKey: randomUUID() };
      await asServer(c.owner);
      const first = await prepareOfflineVoiceDraft(db, { companyId: c.companyId }, request, deps());
      assert.equal(first.state, 'prepared_offline');
      assert.equal(first.replayed, false);
      assert.equal(first.preflightOnly, true);
      await asServer(c.owner);
      const again = await prepareOfflineVoiceDraft(db, { companyId: c.companyId }, request, deps());
      assert.equal(again.operationId, first.operationId);
      assert.equal(again.replayed, true);
      assert.equal((await quota(own)).reserved, 1, 'a replay holds no second unit');
      await h.asAdmin();
      const row = (await db.query('select binding_json,binding_hash,entitlement_id from private.sc010c_voice_preparations where id=$1',
        [first.operationId])).rows[0];
      assert.equal(row.entitlement_id, own);
      for (const forbidden of ['package', 'price', 'order', 'freeTrialApproved', 'paidSettlementVerified'])
        assert.ok(!(forbidden in row.binding_json), forbidden);
      const pool = await quota(own);
      assert.equal(row.binding_json.entitlementGrant, pool.grant_reference);
      assert.equal(row.binding_json.total, pool.total);
      assert.equal(row.binding_json.recordingAllowed, false);
      assert.match(row.binding_hash, /^[0-9a-f]{64}$/);
      await asServer(c.owner);
      assert.deepEqual(await cancelOfflineVoicePreparation(db, { companyId: c.companyId }, first.operationId),
        { operationId: first.operationId, state: 'cancelled_offline' });
      const after = await quota(own);
      assert.equal(after.reserved, 0, 'cancellation releases the held unit');
      assert.equal(after.used, 0);
      // A pool row whose operator grant is not verified is never usable.
      const d = await ready(a);
      await h.asAdmin();
      const unverified = await one(`insert into private.sc19_voice_entitlements
        (company_id,total,grant_reference,valid_from,expires_at,active,company_verified,
         company_verification_reference,company_verification_expires_at,grant_verified)
        values($1,1,$2,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 day',true,true,$3,
         clock_timestamp()+interval '1 hour',false) returning id as v`, [d.companyId, randomUUID(), randomUUID()]);
      await asServer(d.owner);
      await assert.rejects(prepareOfflineVoiceDraft(db, { companyId: d.companyId }, { communicationId: d.communicationId,
        approvalId: d.approvalId, permissionReceiptId: d.permissionReceiptId, planId: d.planId, releaseId: d.releaseId,
        pointerVersion: Number(d.pointerVersion), entitlementId: unverified, requestKey: randomUUID() }, deps()),
      // R6-2: the company still has another usable grant with free units, so this is not "no free interview".
      e => e.code === 'VOICE_PREPARATION_UNAVAILABLE');
      assert.equal((await quota(unverified)).reserved, 0);
      assert.equal(networkCalls, 0, 'no provider is called');
    } finally { globalThis.fetch = originalFetch; await h.asAdmin(); }
  });

  await t.test('operational rollback keeps rows, adapters and signature', async () => {
    await h.asAdmin();
    await db.query(await readFile(new URL('../supabase/rollbacks/20261119120000_r6_voice_permission_pool_r19_down.sql', import.meta.url), 'utf8'));
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
    assert.deepEqual(Object.values(await counts(b)), [2, 1, 1, 1]);
    assert.equal((await quota(pool)).reserved, 1);
  });
});
