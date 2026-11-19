// R6-1c part 4: SC-011-B2 voice dispatch ledger (call attempts, webhook receipts)
// and SC-011-B5 once-only dispatch claims as a real migration
// (20261119180000_r6_voice_dispatch_r20.sql) on the full checked-in chain.
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

// Pinned to its own step: R21 (part 5) adds settlement of finished calls on top.
const signature = '1a657cdd163107054029c177c44c66e44a05ad5615a374fb85466c30bc95b806';
const candidateTables = ['private.sc011b_voice_attempts', 'private.sc011b_voice_webhook_receipts', 'private.sc011b_voice_dispatches'];
const guards = ['private.sc011b_attempt_guard()', 'private.sc011b_receipt_guard()', 'private.sc011b_dispatch_guard()'];
const definers = ['private.sc011b_block_cancel_after_dispatch()', 'private.sc011b_dispatch_rejected()',
  'private.sc011b_block_cancel_while_dispatching()'];
const behaviors = behaviorGuideDefinitions.map((x, i) => x.label + ': ' + (i < 4 ? 'Wysoki' : 'Standardowy'));
const ratings = ['insufficient_data', 'meets', 'below', 'meets', 'above'];
const digest = value => createHash('sha256').update(value).digest('hex');
const callId = () => 'call_' + randomBytes(12).toString('hex');
const agentId = 'agent_' + 'a'.repeat(24);
const code = (...codes) => e => codes.includes(e.code);

test('R6-1c part 4: voice dispatch migration is closed, once-only and erased with the candidate', async t => {
  const { db, h, x } = await activeBoot(t, { fullChain: true, throughMigration: '20261119180000_r6_voice_dispatch_r20.sql' });
  const one = async (sql, args) => (await db.query(sql, args)).rows[0].v;
  const asServer = async actor => { await h.asAdmin(); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [actor]); };
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

  // Shortlisted candidate with contact evidence, interview permission and a released plan (R18/R19).
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
  // Trusted server preparation (same transaction shape as the R19 test).
  const prepare = async (f, entitlementId) => {
    await asServer(f.owner);
    await db.query('begin');
    try {
      const contact = await one('select private.sc010c_lock_voice_contact($1,$2,$3,$4) as v',
        [f.companyId, f.communicationId, f.approvalId, f.permissionReceiptId]);
      await db.query('update private.sc19_voice_entitlements set reserved=reserved+1 where company_id=$1 and id=$2', [f.companyId, entitlementId]);
      const binding = JSON.stringify({ version: 1, companyId: f.companyId, applicationId: f.application.id,
        planId: f.planId, releaseId: f.releaseId, entitlementId, synthetic: true });
      const keyDigest = digest(randomUUID());
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
        keyDigest, f.owner]);
      await db.query(`insert into private.sc010c_voice_preparation_requests(company_id,actor_id,request_key,operation_id,binding_hash)
        values($1,$2,$3,$4,$5)`, [f.companyId, f.owner, randomUUID(), operationId, digest(binding)]);
      await db.query('commit');
      return { id: operationId, keyDigest };
    } catch (error) { await db.query('rollback'); throw error; }
  };
  const claim = async (f, prep, keyDigest = prep.keyDigest) => {
    await asServer(f.owner);
    return db.query(`insert into private.sc011b_voice_dispatches(company_id,preparation_id,provider_key_digest,payload_sha256)
      values($1,$2,$3,$4) on conflict do nothing`, [f.companyId, prep.id, keyDigest, digest('synthetic-payload')]);
  };
  const dispatch = async (f, prep) => { await h.asAdmin(); return (await db.query(
    'select * from private.sc011b_voice_dispatches where company_id=$1 and preparation_id=$2', [f.companyId, prep.id])).rows[0]; };
  const quota = async id => { await h.asAdmin(); return (await db.query('select * from private.sc19_voice_entitlements where id=$1', [id])).rows[0]; };
  const counts = async f => {
    await h.asAdmin();
    const result = {};
    for (const table of candidateTables) result[table] = await one(`select count(*)::int as v from ${table} t
      where t.company_id=$1 and $2=any(private.erasure_row_candidates('${table}',to_jsonb(t)))`, [f.companyId, f.candidate.id]);
    return result;
  };

  await t.test('installs inventory R20, RLS forced, nothing granted to API roles, guards run as the caller', async () => {
    await h.asAdmin();
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
    const known = await one('select known_tables as v from private.erasure_inventory_baseline_r20 where singleton');
    for (const table of [...candidateTables, 'private.erasure_inventory_baseline_r20']) assert.ok(known.includes(table), table);
    for (const table of candidateTables) {
      assert.equal(await one(`select count(*)::int as v from ${table}`), 0, `${table} is not seeded`);
      assert.equal(await one('select c.relrowsecurity and c.relforcerowsecurity as v from pg_class c where c.oid=$1::regclass', [table]), true, table);
    }
    for (const role of ['anon', 'authenticated', 'service_role', 'voice_permission_verifier']) {
      if (!await one('select to_regrole($1) is not null as v', [role])) continue;
      for (const table of candidateTables) assert.equal(await one('select has_table_privilege($1,$2,$3) as v',
        [role, table, 'select,insert,update,delete,truncate,references,trigger']), false, `${role} ${table}`);
      for (const fn of [...guards, ...definers]) assert.equal(await one('select has_function_privilege($1,$2,$3) as v', [role, fn, 'execute']), false, `${role} ${fn}`);
    }
    for (const fn of guards) assert.equal(await one('select prosecdef as v from pg_proc where oid=$1::regprocedure', [fn]), false, fn);
    for (const fn of definers) assert.equal(await one('select prosecdef as v from pg_proc where oid=$1::regprocedure', [fn]), true, fn);
    for (const fn of [...guards, ...definers])
      assert.equal(await one('select proconfig[1] as v from pg_proc where oid=$1::regprocedure', [fn]), 'search_path=""', fn);
    for (const table of candidateTables) for (const privilege of ['select', 'delete'])
      assert.equal(await one('select has_table_privilege($1,$2,$3) as v', ['erasure_purge_owner', table, privilege]), true, `${table} ${privilege}`);
    await h.asUser(users.owner);
    await assert.rejects(db.query('select * from private.sc011b_voice_dispatches'), code('42501'));
    await h.asUser(null, 'anon');
    await assert.rejects(db.query('select * from private.sc011b_voice_attempts'), code('42501'));
    await h.asAdmin();
  });

  await h.asAdmin();
  await db.query('insert into private.voice_plan_template_catalog(version,manifest_digest,active) values($1,$2,true)',
    ['skillcheck-voice-plan-v1', trustedVoiceTemplateDigest('skillcheck-voice-plan-v1')]);
  const a = await ready();
  const b = await ready(a);
  const pool = await grant(a, 3);
  const pa = await prepare(a, pool);
  const pb = await prepare(b, pool);
  let attemptId, survivorAttempt;
  const loose = 'f'.repeat(64);

  await t.test('dispatch claim is once-only, bound to the preparation key and leased', async () => {
    await assert.rejects(claim(a, pa, digest('other-key')), code('42501'));
    await claim(a, pa);
    const first = await dispatch(a, pa);
    assert.equal(first.state, 'sending');
    assert.equal(first.attempts, 1);
    assert.ok(first.lease_until > first.started_at);
    await claim(a, pa);
    assert.deepEqual(await dispatch(a, pa), first, 'a repeated claim leaves the first one as is');
    await asServer(a.owner);
    await assert.rejects(db.query('update private.sc011b_voice_dispatches set attempts=2 where preparation_id=$1', [pa.id]),
      e => e.code === 'PT409' && e.message === 'VOICE_DISPATCH_IN_FLIGHT');
    await db.query('update private.sc011b_voice_dispatches set lease_until=null where preparation_id=$1', [pa.id]);
    await db.query('update private.sc011b_voice_dispatches set attempts=2 where preparation_id=$1', [pa.id]);
    assert.equal((await dispatch(a, pa)).attempts, 2);
    await asServer(a.owner);
    await assert.rejects(db.query("update private.sc011b_voice_dispatches set payload_sha256=$2 where preparation_id=$1", [pa.id, loose]), code('42501'));
    await assert.rejects(db.query('delete from private.sc011b_voice_dispatches where preparation_id=$1', [pa.id]), code('42501'));
    // Only the (not yet installed) operator resolution may abandon an unknown claim.
    await db.query("update private.sc011b_voice_dispatches set state='unknown' where preparation_id=$1", [pa.id]);
    await assert.rejects(db.query("update private.sc011b_voice_dispatches set state='abandoned' where preparation_id=$1", [pa.id]), code('42501'));
    await db.query("update private.sc011b_voice_dispatches set state='accepted' where preparation_id=$1", [pa.id]);
    assert.equal((await dispatch(a, pa)).lease_until, null);
  });

  await t.test('a call attempt is recorded once, blocks cancellation and keeps its terminal outcome', async () => {
    await asServer(a.owner);
    attemptId = await one(`insert into private.sc011b_voice_attempts(company_id,preparation_id,candidate_id,provider_account_id,provider_call_id)
      values($1,$2,$3,$4,$5) returning id as v`, [a.companyId, pa.id, a.candidate.id, agentId, callId()]);
    await assert.rejects(db.query(`insert into private.sc011b_voice_attempts(company_id,preparation_id,candidate_id,provider_account_id,provider_call_id)
      values($1,$2,$3,$4,$5)`, [a.companyId, pa.id, a.candidate.id, agentId, callId()]), code('23505'));
    await assert.rejects(db.query("update private.sc010c_voice_preparations set state='cancelled_offline' where id=$1", [pa.id]),
      e => e.code === 'PT409' && e.message === 'VOICE_PREPARATION_DISPATCHED');
    await db.query("update private.sc011b_voice_attempts set status='ringing' where id=$1", [attemptId]);
    await db.query("update private.sc011b_voice_attempts set status='completed',outcome='completed' where id=$1", [attemptId]);
    await assert.rejects(db.query("update private.sc011b_voice_attempts set status='failed',outcome='busy' where id=$1", [attemptId]), code('42501'));
    await assert.rejects(db.query('update private.sc011b_voice_attempts set provider_call_id=$2 where id=$1', [attemptId, callId()]), code('42501'));
    await assert.rejects(db.query('delete from private.sc011b_voice_attempts where id=$1', [attemptId]), code('42501'));
    // Webhook receipts: correlated (candidate data) and an ignored delivery without a tenant.
    await db.query(`insert into private.sc011b_voice_webhook_receipts(receipt_id,company_id,attempt_id,event,result)
      values($1,$2,$3,'call_ended','applied')`, [digest('a-ended'), a.companyId, attemptId]);
    await db.query(`insert into private.sc011b_voice_webhook_receipts(receipt_id,event,result) values($1,'other','ignored')`, [digest('ignored')]);
    await assert.rejects(db.query("update private.sc011b_voice_webhook_receipts set result='duplicate_status' where receipt_id=$1", [digest('a-ended')]), code('42501'));
    await assert.rejects(db.query('delete from private.sc011b_voice_webhook_receipts where receipt_id=$1', [digest('ignored')]), code('42501'));
    // No settlement in this step: the held unit stays reserved, nothing is marked used.
    const q = await quota(pool);
    assert.equal(q.reserved, 2);
    assert.equal(q.used, 0);
    assert.deepEqual(Object.values(await counts(a)), [1, 1, 1]);
  });

  await t.test('a request the provider refused cancels the preparation and returns its unit once', async () => {
    await claim(b, pb);
    await asServer(b.owner);
    await db.query("update private.sc011b_voice_dispatches set state='rejected',rejection='invalid_request' where preparation_id=$1", [pb.id]);
    await h.asAdmin();
    assert.equal(await one('select state as v from private.sc010c_voice_preparations where id=$1', [pb.id]), 'cancelled_offline');
    assert.equal((await quota(pool)).reserved, 1);
    await asServer(b.owner);
    await assert.rejects(db.query("update private.sc011b_voice_dispatches set state='sending' where preparation_id=$1", [pb.id]), code('42501'));
    await assert.rejects(db.query(`insert into private.sc011b_voice_attempts(company_id,preparation_id,candidate_id,provider_account_id,provider_call_id)
      values($1,$2,$3,$4,$5)`, [b.companyId, pb.id, b.candidate.id, agentId, callId()]), e => e.code === 'PT409');
    assert.deepEqual(Object.values(await counts(b)), [0, 0, 1]);
  });

  await t.test('candidate erasure inventories R20 rows and purges them before the preparation', async () => {
    // A same-company survivor with a placed call keeps every row.
    const c = await ready(a);
    const pc = await prepare(c, pool);
    await claim(c, pc);
    await asServer(c.owner);
    await db.query("update private.sc011b_voice_dispatches set state='accepted' where preparation_id=$1", [pc.id]);
    survivorAttempt = await one(`insert into private.sc011b_voice_attempts(company_id,preparation_id,candidate_id,provider_account_id,provider_call_id)
      values($1,$2,$3,$4,$5) returning id as v`, [c.companyId, pc.id, c.candidate.id, agentId, callId()]);
    await db.query(`insert into private.sc011b_voice_webhook_receipts(receipt_id,company_id,attempt_id,event,result)
      values($1,$2,$3,'call_started','applied')`, [digest('c-started'), c.companyId, survivorAttempt]);
    await h.asAdmin();
    const rows = (await db.query('select adapter,row_key from private.erasure_inventory_rows($1,$2)', [a.companyId, [a.candidate.id]])).rows;
    assert.deepEqual(rows.filter(r => candidateTables.includes(r.adapter)).map(r => [r.adapter, r.row_key]).sort(), [
      ['private.sc011b_voice_attempts', attemptId],
      ['private.sc011b_voice_dispatches', `${a.companyId}:${pa.id}`],
      ['private.sc011b_voice_webhook_receipts', digest('a-ended')]].sort());
    const before = await quota(pool);
    const life = lifecycleHarness(h);
    await h.asUser(a.owner);
    await life.policy(a, 0, lifecycleRules);
    a.resolutionId = await life.resolve(a, [a.candidate.id]);
    await x.configure();
    const frozen = await life.freeze(a);
    // While frozen, no new dispatch evidence can be written for the candidate.
    await asServer(a.owner);
    await assert.rejects(db.query(`insert into private.sc011b_voice_webhook_receipts(receipt_id,company_id,attempt_id,event,result)
      values($1,$2,$3,'call_analyzed','recorded')`, [digest('a-analyzed'), a.companyId, attemptId]), code('PT409'));
    await h.asUser(a.owner);
    await x.transition(frozen.request_id, 0, 'authorized');
    await x.transition(frozen.request_id, 1, 'erasing');
    await x.purge(frozen.request_id, 2);
    await h.asAdmin();
    assert.equal(await one('select count(*)::int as v from private.sc011b_voice_attempts where candidate_id=$1', [a.candidate.id]), 0);
    assert.equal(await one('select count(*)::int as v from private.sc011b_voice_dispatches where preparation_id=$1', [pa.id]), 0);
    assert.equal(await one('select count(*)::int as v from private.sc011b_voice_webhook_receipts where receipt_id=$1', [digest('a-ended')]), 0);
    assert.equal(await one('select count(*)::int as v from private.sc010c_voice_preparations where id=$1', [pa.id]), 0);
    assert.equal(await one('select count(*)::int as v from public.candidates where id=$1', [a.candidate.id]), 0);
    assert.equal(await one('select count(*)::int as v from private.sc011b_voice_webhook_receipts where company_id is null', []), 1,
      'a delivery without a tenant is not candidate data');
    // R19 refund of the purged prepared_offline operation, exactly once.
    const after = await quota(pool);
    assert.equal(after.reserved, before.reserved - 1);
    assert.equal(after.used, before.used);
    assert.deepEqual(Object.values(await counts(b)), [0, 0, 1], 'same-company rejected claim survives');
    assert.deepEqual(Object.values(await counts(c)), [1, 1, 1], 'same-company placed call survives');
  });

  await t.test('operational rollback keeps rows, adapters and signature', async () => {
    await h.asAdmin();
    await db.query(await readFile(new URL('../supabase/rollbacks/20261119180000_r6_voice_dispatch_r20_down.sql', import.meta.url), 'utf8'));
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
    assert.equal(await one('select count(*)::int as v from private.sc011b_voice_attempts where id=$1', [survivorAttempt]), 1);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      if (!await one('select to_regrole($1) is not null as v', [role])) continue;
      for (const table of candidateTables) assert.equal(await one('select has_table_privilege($1,$2,$3) as v', [role, table, 'select']), false);
    }
  });
});
