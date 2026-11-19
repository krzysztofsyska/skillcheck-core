// R6-1c part 6: SC-011-B6 operator resolution of unknown voice dispatches as a
// real migration (20261120090000_r6_voice_resolution_r22.sql) on the full
// checked-in chain: only a platform operator resolves an unknown claim, once;
// `not_placed` cancels the preparation and returns its interview; `placed`
// records the call and settles it once through the R21 settlement ledger; a
// do-not-call outcome found on a finished call is recorded on it and blocks for
// good; erasure purges resolutions and refunds only a unit an unresolved claim
// still holds. Native disposable PostgreSQL only; synthetic data; no provider,
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

// Pinned to its own step: R23 (part 7) adds the voice transcripts on top.
const signature = '3e6a9df7b8146c65fac9b7b04cbb60f68b1b47b98039461d077a252426e1adee';
const table = 'private.sc011b_dispatch_resolutions';
const ledger = 'private.sc011b_voice_settlements';
const guards = ['private.sc011b_resolution_guard()'];
const operatorFns = ['private.sc011b_list_unknown_dispatches(integer)', 'private.sc011b_resolve_unknown_dispatch(uuid,uuid,text,text,text,text)'];
const definers = [...operatorFns, 'private.erasure_row_candidates(text,jsonb)', 'private.erasure_inventory_rows(uuid,uuid[])'];
const behaviors = behaviorGuideDefinitions.map((x, i) => x.label + ': ' + (i < 4 ? 'Wysoki' : 'Standardowy'));
const ratings = ['insufficient_data', 'meets', 'below', 'meets', 'above'];
const digest = value => createHash('sha256').update(value).digest('hex');
const callId = () => 'call_' + randomBytes(12).toString('hex');
const agentId = 'agent_' + 'a'.repeat(24);
const operator = users.outsider;
const code = (...codes) => e => codes.includes(e.code);
const message = (c, m) => e => e.code === c && e.message === m;

test('R6-1c part 6: operator resolution of unknown voice dispatches settles the pool once and is erased with the candidate', async t => {
  const { db, h, x } = await activeBoot(t, { fullChain: true, throughMigration: '20261120090000_r6_voice_resolution_r22.sql' });
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
  // Trusted server preparation (same transaction shape as the R19/R21 tests).
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
  // A claim whose provider result never became known (worker gave up without redialing).
  const unknownClaim = async (f, prep) => {
    await asServer(f.owner);
    await db.query(`insert into private.sc011b_voice_dispatches(company_id,preparation_id,provider_key_digest,payload_sha256)
      values($1,$2,$3,$4) on conflict do nothing`, [f.companyId, prep.id, prep.keyDigest, digest('synthetic-payload')]);
    await db.query("update private.sc011b_voice_dispatches set state='unknown' where company_id=$1 and preparation_id=$2", [f.companyId, prep.id]);
  };
  const lateAttempt = async (f, prep, call = callId()) => {
    await asServer(f.owner);
    const id = await one(`insert into private.sc011b_voice_attempts(company_id,preparation_id,candidate_id,provider_account_id,provider_call_id)
      values($1,$2,$3,$4,$5) returning id as v`, [f.companyId, prep.id, f.candidate.id, agentId, call]);
    return { id, call };
  };
  const resolve = async (f, prep, resolution, call = null, outcome = null, agent = agentId, actor = operator) => {
    await asServer(actor);
    return one('select private.sc011b_resolve_unknown_dispatch($1,$2,$3,$4,$5,$6) as v', [f.companyId, prep.id, resolution, agent, call, outcome]);
  };
  const row = async (sql, args) => { await h.asAdmin(); return (await db.query(sql, args)).rows[0]; };
  const dispatchState = async prep => (await row('select state from private.sc011b_voice_dispatches where preparation_id=$1', [prep.id])).state;
  const prepState = async prep => (await row('select state from private.sc010c_voice_preparations where id=$1', [prep.id])).state;
  const quota = async id => row('select used,reserved from private.sc19_voice_entitlements where id=$1', [id]);
  const settled = async prep => { await h.asAdmin(); return (await db.query(`select consumed from ${ledger} where preparation_id=$1`, [prep.id])).rows.map(r => r.consumed); };
  const resolutions = async prep => { await h.asAdmin(); return (await db.query(`select * from ${table} where preparation_id=$1`, [prep.id])).rows; };
  const attemptOf = async prep => row('select status,outcome,dnc_requested from private.sc011b_voice_attempts where preparation_id=$1', [prep.id]);

  await t.test('installs inventory R22, RLS forced, operator functions owner-only', async () => {
    await h.asAdmin();
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
    const known = await one('select known_tables as v from private.erasure_inventory_baseline_r22 where singleton');
    for (const name of [table, 'private.erasure_inventory_baseline_r22', ledger]) assert.ok(known.includes(name), name);
    assert.equal(await one(`select count(*)::int as v from ${table}`), 0, 'nothing is seeded');
    assert.equal(await one('select c.relrowsecurity and c.relforcerowsecurity as v from pg_class c where c.oid=$1::regclass', [table]), true);
    for (const role of ['anon', 'authenticated', 'service_role', 'voice_permission_verifier']) {
      if (!await one('select to_regrole($1) is not null as v', [role])) continue;
      assert.equal(await one('select has_table_privilege($1,$2,$3) as v',
        [role, table, 'select,insert,update,delete,truncate,references,trigger']), false, `${role} ${table}`);
      for (const fn of [...guards, ...definers]) assert.equal(await one('select has_function_privilege($1,$2,$3) as v', [role, fn, 'execute']), false, `${role} ${fn}`);
    }
    for (const fn of guards) assert.equal(await one('select prosecdef as v from pg_proc where oid=$1::regprocedure', [fn]), false, fn);
    for (const fn of definers) assert.equal(await one('select prosecdef as v from pg_proc where oid=$1::regprocedure', [fn]), true, fn);
    for (const fn of [...guards, ...definers])
      assert.equal(await one('select proconfig[1] as v from pg_proc where oid=$1::regprocedure', [fn]), 'search_path=""', fn);
    for (const privilege of ['select', 'delete'])
      assert.equal(await one('select has_table_privilege($1,$2,$3) as v', ['erasure_purge_owner', table, privilege]), true, privilege);
    await h.asUser(users.owner);
    await assert.rejects(db.query(`select * from ${table}`), code('42501'));
    await assert.rejects(db.query('select * from private.sc011b_list_unknown_dispatches(10)'), code('42501'));
    await h.asAdmin();
  });

  await h.asAdmin();
  await db.query('insert into private.voice_plan_template_catalog(version,manifest_digest,active) values($1,$2,true)',
    ['skillcheck-voice-plan-v1', trustedVoiceTemplateDigest('skillcheck-voice-plan-v1')]);
  await db.query('insert into public.platform_operators(user_id) values($1)', [operator]);
  const a = await ready();
  const [b, c, d, e, g] = [await ready(a), await ready(a), await ready(a), await ready(a), await ready(a)];
  const pool = await grant(a, 10);
  const [pa, pb, pc, pd, pe, pg] = [await prepare(a, pool), await prepare(b, pool), await prepare(c, pool),
    await prepare(d, pool), await prepare(e, pool), await prepare(g, pool)];
  for (const [f, p] of [[a, pa], [b, pb], [c, pc], [d, pd], [e, pe], [g, pg]]) await unknownClaim(f, p);

  await t.test('only a platform operator lists and resolves; an unknown claim keeps its reserved unit', async () => {
    assert.deepEqual(await quota(pool), { used: 0, reserved: 6 });
    await asServer(a.owner);
    await assert.rejects(db.query('select * from private.sc011b_list_unknown_dispatches(10)'), message('42501', 'VOICE_DISPATCH_RESOLUTION_FORBIDDEN'));
    await assert.rejects(resolve(a, pa, 'not_placed', null, null, agentId, a.owner), message('42501', 'VOICE_DISPATCH_RESOLUTION_FORBIDDEN'));
    await h.asAdmin();
    await db.query("select set_config('request.jwt.claim.sub','',false)");
    await assert.rejects(db.query('select private.sc011b_resolve_unknown_dispatch($1,$2,$3,null,null,null)', [a.companyId, pa.id, 'not_placed']),
      message('42501', 'VOICE_DISPATCH_RESOLUTION_FORBIDDEN'), 'no system bypass without an operator');
    await asServer(operator);
    const listed = (await db.query('select * from private.sc011b_list_unknown_dispatches(50)')).rows;
    assert.deepEqual(Object.keys(listed[0]).sort(), ['attempts', 'company_id', 'last_attempt_at', 'preparation_id', 'started_at'], 'no candidate data');
    assert.deepEqual(new Set(listed.map(r => r.preparation_id)), new Set([pa, pb, pc, pd, pe, pg].map(p => p.id)));
    assert.equal((await db.query('select * from private.sc011b_list_unknown_dispatches(2)')).rows.length, 2);
    assert.deepEqual(await resolutions(pa), []);
  });

  await t.test('not_placed cancels the preparation and returns its unit once', async () => {
    await assert.rejects(resolve(a, pa, 'not_placed', callId(), null), message('PT422', 'VOICE_DISPATCH_RESOLUTION_INVALID'));
    await assert.rejects(resolve(a, pa, 'maybe'), message('PT422', 'VOICE_DISPATCH_RESOLUTION_INVALID'));
    // The operator identity is restored for the rest of the caller's transaction.
    await asServer(operator);
    await db.query('begin');
    try {
      assert.equal(await one('select private.sc011b_resolve_unknown_dispatch($1,$2,$3,null,null,null) as v', [a.companyId, pa.id, 'not_placed']), 'not_placed');
      assert.equal(await one("select current_setting('request.jwt.claim.sub',true) as v"), operator);
      await db.query('commit');
    } catch (error) { await db.query('rollback'); throw error; }
    assert.equal(await dispatchState(pa), 'abandoned');
    assert.equal(await prepState(pa), 'cancelled_offline');
    assert.deepEqual(await quota(pool), { used: 0, reserved: 5 });
    assert.deepEqual(await settled(pa), [], 'no call, no settlement');
    const [r] = await resolutions(pa);
    assert.deepEqual([r.resolution, r.provider_call_id, r.outcome, r.resolved_by], ['not_placed', null, null, operator]);
    await assert.rejects(resolve(a, pa, 'not_placed'), message('PT409', 'VOICE_DISPATCH_NOT_UNKNOWN'));
    assert.deepEqual(await quota(pool), { used: 0, reserved: 5 }, 'resolved once');
  });

  await t.test('not_placed is refused when a call attempt exists', async () => {
    await lateAttempt(c, pc);
    await assert.rejects(resolve(c, pc, 'not_placed'), message('PT409', 'VOICE_PREPARATION_DISPATCHED'));
    assert.equal(await dispatchState(pc), 'unknown');
    assert.deepEqual(await quota(pool), { used: 0, reserved: 5 });
  });

  await t.test('placed records the call and settles it once through the ledger', async () => {
    await assert.rejects(resolve(b, pb, 'placed', null, 'completed'), message('PT422', 'VOICE_DISPATCH_RESOLUTION_INVALID'));
    await assert.rejects(resolve(b, pb, 'placed', callId(), null), message('PT422', 'VOICE_DISPATCH_RESOLUTION_INVALID'));
    const call = callId();
    assert.equal(await resolve(b, pb, 'placed', call, 'completed'), 'placed');
    assert.equal(await dispatchState(pb), 'accepted');
    assert.deepEqual(await attemptOf(pb), { status: 'completed', outcome: 'completed', dnc_requested: false });
    assert.deepEqual(await quota(pool), { used: 1, reserved: 4 });
    assert.deepEqual(await settled(pb), [true]);
    // Unanswered call: the reservation is released, nothing is used.
    assert.equal(await resolve(d, pd, 'placed', callId(), 'no_answer'), 'placed');
    assert.deepEqual(await attemptOf(pd), { status: 'failed', outcome: 'no_answer', dnc_requested: false });
    assert.deepEqual(await quota(pool), { used: 1, reserved: 3 });
    assert.deepEqual(await settled(pd), [false]);
    await assert.rejects(resolve(b, pb, 'placed', call, 'completed'), message('PT409', 'VOICE_DISPATCH_NOT_UNKNOWN'));
    assert.deepEqual(await quota(pool), { used: 1, reserved: 3 });
  });

  await t.test('a late accepted call is reused only when it is the same call', async () => {
    const call = (await row('select provider_call_id from private.sc011b_voice_attempts where preparation_id=$1', [pc.id])).provider_call_id;
    await assert.rejects(resolve(c, pc, 'placed', callId(), 'completed'), message('PT409', 'VOICE_DISPATCH_CALL_MISMATCH'));
    await assert.rejects(resolve(c, pc, 'placed', call, 'completed', 'agent_' + 'b'.repeat(24)), message('PT409', 'VOICE_DISPATCH_CALL_MISMATCH'));
    assert.equal(await resolve(c, pc, 'placed', call, 'busy'), 'placed');
    assert.equal(await one('select count(*)::int as v from private.sc011b_voice_attempts where preparation_id=$1', [pc.id]), 1);
    assert.deepEqual(await attemptOf(pc), { status: 'failed', outcome: 'busy', dnc_requested: false });
    assert.deepEqual(await quota(pool), { used: 1, reserved: 2 });
    assert.deepEqual(await settled(pc), [false]);
  });

  await t.test('do-not-call found on an already finished call is recorded on it and blocks for good, without resettling', async () => {
    const { id, call } = await lateAttempt(e, pe);
    await asServer(e.owner);
    await db.query("update private.sc011b_voice_attempts set status='failed',outcome='voicemail' where id=$1", [id]);
    assert.deepEqual(await quota(pool), { used: 1, reserved: 1 }, 'the webhook settled the call');
    assert.deepEqual(await settled(pe), [false]);
    assert.equal(await resolve(e, pe, 'placed', call, 'dnc_requested'), 'placed');
    assert.deepEqual(await attemptOf(pe), { status: 'failed', outcome: 'dnc_requested', dnc_requested: true }, 'status kept');
    assert.deepEqual(await quota(pool), { used: 1, reserved: 1 }, 'not settled twice');
    assert.deepEqual(await settled(pe), [false]);
    const p = await row('select blocked_channels,source from public.candidate_contact_preferences where company_id=$1 and candidate_id=$2', [e.companyId, e.candidate.id]);
    assert.deepEqual(p.blocked_channels, ['email', 'sms', 'voice']);
    assert.equal(p.source, 'operator_recorded');
    await h.asAdmin();
    await assert.rejects(db.query("update public.candidate_contact_preferences set blocked_channels=array['email']::text[] where company_id=$1 and candidate_id=$2",
      [e.companyId, e.candidate.id]), message('PT409', 'CANDIDATE_REQUESTED_NO_CONTACT'));
    assert.equal(await dispatchState(pe), 'accepted');
  });

  await t.test('the resolutions table is written only by a resolution and is immutable', async () => {
    await h.asAdmin();
    await assert.rejects(db.query(`insert into ${table}(company_id,preparation_id,resolution,resolved_by) values($1,$2,'not_placed',$3)`,
      [g.companyId, pg.id, operator]), message('42501', 'VOICE_DISPATCH_RESOLUTION_UNBOUND'));
    await assert.rejects(db.query(`insert into ${table}(company_id,preparation_id,resolution,provider_call_id,outcome,resolved_by) values($1,$2,'placed',$3,'completed',$4)`,
      [g.companyId, pg.id, callId(), operator]), message('42501', 'VOICE_DISPATCH_RESOLUTION_UNBOUND'));
    await assert.rejects(db.query(`insert into ${table}(company_id,preparation_id,resolution,resolved_by) values($1,$2,'not_placed',$3)`,
      [a.companyId, pa.id, operator]), code('23505', '42501'));
    await assert.rejects(db.query(`update ${table} set resolution='placed' where preparation_id=$1`, [pa.id]), code('42501'));
    await assert.rejects(db.query(`delete from ${table} where preparation_id=$1`, [pa.id]), code('42501'));
    await assert.rejects(db.query(`truncate ${table}`), code('42501'));
  });

  await t.test('erasure purges resolutions before claims and refunds only the unit an unresolved claim holds', async () => {
    // a: not_placed (unit already returned); b: placed+completed (used); g: still unknown (holds a unit).
    await h.asAdmin();
    const subjects = [a.candidate.id, b.candidate.id, g.candidate.id];
    const rows = (await db.query('select adapter,row_key from private.erasure_inventory_rows($1,$2)', [a.companyId, subjects])).rows;
    assert.deepEqual(rows.filter(r => r.adapter === table).map(r => r.row_key).sort(),
      [`${a.companyId}:${pa.id}`, `${b.companyId}:${pb.id}`].sort());
    assert.deepEqual(await quota(pool), { used: 1, reserved: 1 });
    const life = lifecycleHarness(h);
    await h.asUser(a.owner);
    await life.policy(a, 0, lifecycleRules);
    a.resolutionId = await life.resolve(a, subjects);
    await x.configure();
    const frozen = await life.freeze(a);
    // A frozen candidate's claim cannot be resolved meanwhile.
    await assert.rejects(resolve(g, pg, 'not_placed'), message('PT409', 'Candidate workflow frozen'));
    assert.equal(await dispatchState(pg), 'unknown');
    await h.asUser(a.owner);
    await x.transition(frozen.request_id, 0, 'authorized');
    await x.transition(frozen.request_id, 1, 'erasing');
    await x.purge(frozen.request_id, 2);
    await h.asAdmin();
    for (const prep of [pa, pb, pg]) {
      assert.equal(await one(`select count(*)::int as v from ${table} where preparation_id=$1`, [prep.id]), 0);
      assert.equal(await one('select count(*)::int as v from private.sc011b_voice_dispatches where preparation_id=$1', [prep.id]), 0);
      assert.equal(await one('select count(*)::int as v from private.sc010c_voice_preparations where id=$1', [prep.id]), 0);
    }
    assert.deepEqual(await quota(pool), { used: 1, reserved: 0 }, 'only the unresolved claim of g returned its unit');
    for (const prep of [pc, pd, pe]) assert.equal((await resolutions(prep)).length, 1, 'same-company resolutions survive');
  });

  await t.test('operational rollback keeps rows, adapters and signature', async () => {
    await h.asAdmin();
    await db.query(await readFile(new URL('../supabase/rollbacks/20261120090000_r6_voice_resolution_r22_down.sql', import.meta.url), 'utf8'));
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
    assert.equal(await one(`select count(*)::int as v from ${table}`), 3);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      if (!await one('select to_regrole($1) is not null as v', [role])) continue;
      assert.equal(await one('select has_table_privilege($1,$2,$3) as v', [role, table, 'select']), false);
      for (const fn of operatorFns) assert.equal(await one('select has_function_privilege($1,$2,$3) as v', [role, fn, 'execute']), false);
    }
  });
});
