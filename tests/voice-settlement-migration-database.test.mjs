// R6-1c part 5: SC-011-B4 voice settlement as a real migration
// (20261119210000_r6_voice_settlement_r21.sql) on the full checked-in chain:
// only a call that took place uses the voice pool, every other finished call
// releases its reservation, each prepared call is settled once, an in-call
// do-not-call request blocks every channel for good, and erasure does not refund
// a settled call. Native disposable PostgreSQL only; synthetic data; no provider,
// no API grant.
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

// Pinned to its own step: R22 (part 6) adds the operator resolution of unknown dispatches on top.
const signature = '680f3eaa808e7280b545ad9aaabaa0d4144aafdf8c26f40d174d7670d4da7189';
const ledger = 'private.sc011b_voice_settlements';
const guards = ['private.sc011b_settlement_guard()'];
const definers = ['private.sc011b_block_candidate_contact(uuid,uuid)', 'private.sc011b_attempt_settlement()',
  'private.sc011b_keep_candidate_block()', 'private.erasure_voice_refund_deleted()', 'private.erasure_voice_lock_entitlements(uuid)'];
const behaviors = behaviorGuideDefinitions.map((x, i) => x.label + ': ' + (i < 4 ? 'Wysoki' : 'Standardowy'));
const ratings = ['insufficient_data', 'meets', 'below', 'meets', 'above'];
const digest = value => createHash('sha256').update(value).digest('hex');
const callId = () => 'call_' + randomBytes(12).toString('hex');
const agentId = 'agent_' + 'a'.repeat(24);
const code = (...codes) => e => codes.includes(e.code);
const message = (c, m) => e => e.code === c && e.message === m;

test('R6-1c part 5: voice settlement uses the pool once, releases unplaced calls and blocks on do-not-call', async t => {
  const { db, h, x } = await activeBoot(t, { fullChain: true, throughMigration: '20261119210000_r6_voice_settlement_r21.sql' });
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

  const placed = async (f, prep) => {
    await claim(f, prep);
    await asServer(f.owner);
    await db.query("update private.sc011b_voice_dispatches set state='accepted' where preparation_id=$1", [prep.id]);
    return one(`insert into private.sc011b_voice_attempts(company_id,preparation_id,candidate_id,provider_account_id,provider_call_id)
      values($1,$2,$3,$4,$5) returning id as v`, [f.companyId, prep.id, f.candidate.id, agentId, callId()]);
  };
  const finish = async (f, attempt, status, outcome) => {
    await asServer(f.owner);
    await db.query('update private.sc011b_voice_attempts set status=$2,outcome=$3,dnc_requested=$4 where id=$1',
      [attempt, status, outcome, outcome === 'dnc_requested']);
  };
  const settled = async prep => { await h.asAdmin(); return (await db.query(`select * from ${ledger} where preparation_id=$1`, [prep.id])).rows; };
  const preferences = async f => { await h.asAdmin(); return (await db.query(
    'select blocked_channels,revision,source from public.candidate_contact_preferences where company_id=$1 and candidate_id=$2',
    [f.companyId, f.candidate.id])).rows[0]; };

  await t.test('installs inventory R21, RLS forced, nothing granted to API roles', async () => {
    await h.asAdmin();
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
    const known = await one('select known_tables as v from private.erasure_inventory_baseline_r21 where singleton');
    for (const table of [ledger, 'private.erasure_inventory_baseline_r21', 'private.sc011b_voice_attempts']) assert.ok(known.includes(table), table);
    assert.equal(await one(`select count(*)::int as v from ${ledger}`), 0, 'ledger is not seeded');
    assert.equal(await one('select c.relrowsecurity and c.relforcerowsecurity as v from pg_class c where c.oid=$1::regclass', [ledger]), true);
    for (const role of ['anon', 'authenticated', 'service_role', 'voice_permission_verifier']) {
      if (!await one('select to_regrole($1) is not null as v', [role])) continue;
      assert.equal(await one('select has_table_privilege($1,$2,$3) as v',
        [role, ledger, 'select,insert,update,delete,truncate,references,trigger']), false, `${role} ${ledger}`);
      for (const fn of [...guards, ...definers]) assert.equal(await one('select has_function_privilege($1,$2,$3) as v', [role, fn, 'execute']), false, `${role} ${fn}`);
    }
    for (const fn of guards) assert.equal(await one('select prosecdef as v from pg_proc where oid=$1::regprocedure', [fn]), false, fn);
    for (const fn of definers) assert.equal(await one('select prosecdef as v from pg_proc where oid=$1::regprocedure', [fn]), true, fn);
    for (const fn of [...guards, ...definers])
      assert.equal(await one('select proconfig[1] as v from pg_proc where oid=$1::regprocedure', [fn]), 'search_path=""', fn);
    for (const privilege of ['select', 'delete'])
      assert.equal(await one('select has_table_privilege($1,$2,$3) as v', ['erasure_purge_owner', ledger, privilege]), true, privilege);
    await h.asUser(users.owner);
    await assert.rejects(db.query(`select * from ${ledger}`), code('42501'));
    await h.asAdmin();
  });

  await h.asAdmin();
  await db.query('insert into private.voice_plan_template_catalog(version,manifest_digest,active) values($1,$2,true)',
    ['skillcheck-voice-plan-v1', trustedVoiceTemplateDigest('skillcheck-voice-plan-v1')]);
  const a = await ready();
  const b = await ready(a);
  const c = await ready(a);
  const d = await ready(a);
  const pool = await grant(a, 5);
  const pa = await prepare(a, pool);
  const pb = await prepare(b, pool);
  const pc = await prepare(c, pool);
  const pd = await prepare(d, pool);
  let attemptA, attemptB;

  await t.test('only a call that took place uses the pool; any other outcome releases the reservation', async () => {
    assert.equal((await quota(pool)).reserved, 4);
    attemptA = await placed(a, pa);
    attemptB = await placed(b, pb);
    await finish(a, attemptA, 'ringing', null);
    assert.deepEqual(await settled(pa), [], 'progress is not a settlement');
    await finish(a, attemptA, 'completed', 'completed');
    let q = await quota(pool);
    assert.deepEqual([q.used, q.reserved], [1, 3]);
    assert.deepEqual((await settled(pa)).map(r => [r.entitlement_id, r.consumed]), [[pool, true]]);
    await finish(b, attemptB, 'failed', 'no_answer');
    q = await quota(pool);
    assert.deepEqual([q.used, q.reserved], [1, 2]);
    assert.deepEqual((await settled(pb)).map(r => r.consumed), [false]);
    // A finished call never moves again, so it is never settled twice.
    await asServer(a.owner);
    await assert.rejects(db.query("update private.sc011b_voice_attempts set status='failed',outcome='busy' where id=$1", [attemptA]), code('42501'));
    assert.deepEqual([(await quota(pool)).used, (await quota(pool)).reserved], [1, 2]);
  });

  await t.test('the settlement ledger is written only by a settlement and is immutable', async () => {
    await h.asAdmin();
    await assert.rejects(db.query(`insert into ${ledger}(company_id,preparation_id,entitlement_id,consumed) values($1,$2,$3,true)`,
      [c.companyId, pc.id, pool]), message('42501', 'VOICE_SETTLEMENT_INVALID'));
    await assert.rejects(db.query(`insert into ${ledger}(company_id,preparation_id,entitlement_id,consumed) values($1,$2,$3,true)`,
      [a.companyId, pa.id, pool]), code('23505', '42501'));
    await assert.rejects(db.query(`update ${ledger} set consumed=false where preparation_id=$1`, [pa.id]), code('42501'));
    await assert.rejects(db.query(`delete from ${ledger} where preparation_id=$1`, [pa.id]), code('42501'));
    await assert.rejects(db.query(`truncate ${ledger}`), code('42501'));
  });

  await t.test('a do-not-call request blocks every channel and a later edit cannot lift it', async () => {
    const attemptC = await placed(c, pc);
    const prior = await preferences(c);
    await finish(c, attemptC, 'completed', 'dnc_requested');
    let p = await preferences(c);
    assert.deepEqual(p.blocked_channels, ['email', 'sms', 'voice']);
    assert.equal(Number(p.revision), Number(prior?.revision ?? 0) + 1, 'a changed revision invalidates prepared contact');
    assert.equal(p.source, 'operator_recorded', 'the app-facing source column is unchanged');
    const q = await quota(pool);
    assert.deepEqual([q.used, q.reserved], [2, 1], 'the call took place, so it used one interview');
    await h.asAdmin();
    await assert.rejects(db.query("update public.candidate_contact_preferences set blocked_channels=array['email']::text[] where company_id=$1 and candidate_id=$2",
      [c.companyId, c.candidate.id]), message('PT409', 'CANDIDATE_REQUESTED_NO_CONTACT'));
    await db.query("update public.candidate_contact_preferences set timezone='UTC' where company_id=$1 and candidate_id=$2", [c.companyId, c.candidate.id]);
    // A late request on an already finished call still blocks, without settling again.
    await h.asUser(b.owner);
    const before = await preferences(b);
    await finish(b, attemptB, 'failed', 'dnc_requested');
    p = await preferences(b);
    assert.deepEqual(p.blocked_channels, ['email', 'sms', 'voice']);
    assert.equal(Number(p.revision), Number(before?.revision ?? 0) + 1);
    assert.deepEqual((await settled(pb)).map(r => r.consumed), [false]);
    assert.deepEqual([(await quota(pool)).used, (await quota(pool)).reserved], [2, 1]);
  });

  await t.test('erasure purges the ledger and refunds only the preparation still holding a unit', async () => {
    // d holds a placed, unfinished call: its unit is still reserved.
    await placed(d, pd);
    await h.asAdmin();
    const rows = (await db.query('select adapter,row_key from private.erasure_inventory_rows($1,$2)', [a.companyId, [a.candidate.id, d.candidate.id]])).rows;
    assert.deepEqual(rows.filter(r => r.adapter === ledger).map(r => r.row_key), [`${a.companyId}:${pa.id}`]);
    const before = await quota(pool);
    assert.deepEqual([before.used, before.reserved], [2, 1]);
    const life = lifecycleHarness(h);
    await h.asUser(a.owner);
    await life.policy(a, 0, lifecycleRules);
    a.resolutionId = await life.resolve(a, [a.candidate.id, d.candidate.id]);
    await x.configure();
    const frozen = await life.freeze(a);
    await h.asUser(a.owner);
    await x.transition(frozen.request_id, 0, 'authorized');
    await x.transition(frozen.request_id, 1, 'erasing');
    await x.purge(frozen.request_id, 2);
    await h.asAdmin();
    for (const prep of [pa, pd]) {
      assert.equal(await one(`select count(*)::int as v from ${ledger} where preparation_id=$1`, [prep.id]), 0);
      assert.equal(await one('select count(*)::int as v from private.sc010c_voice_preparations where id=$1', [prep.id]), 0);
    }
    const after = await quota(pool);
    assert.equal(after.used, 2, 'a used interview stays used');
    assert.equal(after.reserved, 0, 'only the unfinished call of d returned its unit; the settled call of a did not');
    assert.equal((await settled(pb)).length, 1, 'same-company settlements survive');
    assert.equal((await settled(pc)).length, 1);
  });

  await t.test('operational rollback keeps rows, adapters and signature', async () => {
    await h.asAdmin();
    await db.query(await readFile(new URL('../supabase/rollbacks/20261119210000_r6_voice_settlement_r21_down.sql', import.meta.url), 'utf8'));
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
    assert.equal(await one(`select count(*)::int as v from ${ledger}`), 2);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      if (!await one('select to_regrole($1) is not null as v', [role])) continue;
      assert.equal(await one('select has_table_privilege($1,$2,$3) as v', [role, ledger, 'select']), false);
    }
  });
});
