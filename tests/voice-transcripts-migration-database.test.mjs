// R6-1c part 7: SC-011-B3 voice interview transcripts as a real migration
// (20261120120000_r6_voice_transcripts_r23.sql) on the full checked-in chain:
// one minimized transcript per completed call, bound to the call attempt and
// never changed; retention removes it 90 days after its recruitment closes
// (reopening pauses it) and skips a candidate frozen for erasure; a candidate
// erasure (inventory R23) removes it earlier, before its call attempt. Native
// disposable PostgreSQL only; synthetic data; no provider, no API grant, no
// reader or screen.
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

const signature = '4dab3fae234c8233104d691381b62710570324bee0db8bd5df4be28f3d6702f7';
const table = 'private.sc011b_voice_transcripts';
const guards = ['private.sc011b_transcript_guard()'];
const domainFns = ['private.sc011b_purge_voice_transcripts()', 'private.sc011b_recruitment_closed_at()'];
const definers = [...domainFns, 'private.erasure_row_candidates(text,jsonb)', 'private.erasure_inventory_rows(uuid,uuid[])'];
const behaviors = behaviorGuideDefinitions.map((x, i) => x.label + ': ' + (i < 4 ? 'Wysoki' : 'Standardowy'));
const ratings = ['insufficient_data', 'meets', 'below', 'meets', 'above'];
const digest = value => createHash('sha256').update(value).digest('hex');
const callId = () => 'call_' + randomBytes(12).toString('hex');
const agentId = 'agent_' + 'a'.repeat(24);
const utterances = [{ speaker: 'agent', text: 'Syntetyczne pytanie.' }, { speaker: 'candidate', text: 'Syntetyczna odpowiedź.' }];
const code = (...codes) => e => codes.includes(e.code);
const message = (c, m) => e => e.code === c && e.message === m;

test('R6-1c part 7: voice transcripts are bound to a completed call, kept until retention and erased with the candidate', async t => {
  const { db, h, x } = await activeBoot(t, { fullChain: true });
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
  // Trusted server preparation (same transaction shape as the R19/R21/R22 tests).
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
  // A dispatched call with its attempt (same shape as the R22 test), optionally finished.
  const call = async (f, prep, status = null, outcome = null) => {
    await asServer(f.owner);
    await db.query(`insert into private.sc011b_voice_dispatches(company_id,preparation_id,provider_key_digest,payload_sha256)
      values($1,$2,$3,$4) on conflict do nothing`, [f.companyId, prep.id, prep.keyDigest, digest('synthetic-payload')]);
    await db.query("update private.sc011b_voice_dispatches set state='unknown' where company_id=$1 and preparation_id=$2", [f.companyId, prep.id]);
    const id = await one(`insert into private.sc011b_voice_attempts(company_id,preparation_id,candidate_id,provider_account_id,provider_call_id)
      values($1,$2,$3,$4,$5) returning id as v`, [f.companyId, prep.id, f.candidate.id, agentId, callId()]);
    if (status) await db.query("update private.sc011b_voice_attempts set status=$2,outcome=$3,dnc_requested=($3='dnc_requested') where id=$1", [id, status, outcome]);
    return id;
  };
  // Same insert shape as lib/voice/retell-dispatch-ledger.ts, with caller-chosen recruitment/candidate.
  const store = async (f, attempt, recruitmentId = f.recruitment.id, candidateId = f.candidate.id, rows = utterances) => {
    await asServer(f.owner);
    await db.query(`insert into ${table}(attempt_id,company_id,recruitment_id,candidate_id,utterances) values($1,$2,$3,$4,$5::jsonb)`,
      [attempt, f.companyId, recruitmentId, candidateId, JSON.stringify(rows)]);
  };
  const count = async attempt => { await h.asAdmin(); return one(`select count(*)::int as v from ${table} where attempt_id=$1`, [attempt]); };
  const attempts = async attempt => { await h.asAdmin(); return one('select count(*)::int as v from private.sc011b_voice_attempts where id=$1', [attempt]); };
  const purge = async () => { await h.asAdmin(); return one('select private.sc011b_purge_voice_transcripts() as v'); };
  const recruitment = async (f, sql, args = []) => { await h.asAdmin(); await db.query(`update public.recruitments set ${sql} where id=$1`, [f.recruitment.id, ...args]); };
  const closedAt = async f => { await h.asAdmin(); return one('select closed_at as v from public.recruitments where id=$1', [f.recruitment.id]); };

  await t.test('installs inventory R23, RLS forced, nothing granted to API roles', async () => {
    await h.asAdmin();
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
    const known = await one('select known_tables as v from private.erasure_inventory_baseline_r23 where singleton');
    for (const name of [table, 'private.erasure_inventory_baseline_r23', 'private.sc011b_dispatch_resolutions']) assert.ok(known.includes(name), name);
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
    for (const privilege of ['insert', 'update'])
      assert.equal(await one('select has_table_privilege($1,$2,$3) as v', ['erasure_purge_owner', table, privilege]), false, privilege);
    await h.asUser(users.owner);
    await assert.rejects(db.query(`select * from ${table}`), code('42501'));
    await assert.rejects(db.query('select private.sc011b_purge_voice_transcripts()'), code('42501'));
    await h.asAdmin();
  });

  await h.asAdmin();
  await db.query('insert into private.voice_plan_template_catalog(version,manifest_digest,active) values($1,$2,true)',
    ['skillcheck-voice-plan-v1', trustedVoiceTemplateDigest('skillcheck-voice-plan-v1')]);
  const a = await ready();
  const [b, c, d] = [await ready(a), await ready(a), await ready(a)];
  const pool = await grant(a, 10);
  const [pa, pb, pc, pd] = [await prepare(a, pool), await prepare(b, pool), await prepare(c, pool), await prepare(d, pool)];
  const ta = await call(a, pa, 'completed', 'completed');
  const tb = await call(b, pb, 'completed', 'dnc_requested');
  const tc = await call(c, pc, 'completed', 'completed');
  const td = await call(d, pd);

  await t.test('a transcript is stored only for a completed call, bound to its attempt', async () => {
    // Caller-supplied candidate and recruitment are replaced by the attempt's.
    await store(a, ta, b.recruitment.id, b.candidate.id);
    await store(b, tb);
    await store(c, tc);
    await h.asAdmin();
    const row = (await db.query(`select candidate_id,recruitment_id,company_id,utterances from ${table} where attempt_id=$1`, [ta])).rows[0];
    assert.deepEqual([row.candidate_id, row.recruitment_id, row.company_id], [a.candidate.id, a.recruitment.id, a.companyId]);
    assert.deepEqual(row.utterances, utterances);
    await assert.rejects(store(d, td), message('PT409', 'VOICE_TRANSCRIPT_UNAVAILABLE'), 'call not completed');
    await assert.rejects(store(a, randomUUID()), message('PT409', 'VOICE_TRANSCRIPT_UNAVAILABLE'), 'unknown attempt');
    await assert.rejects(store(a, ta), code('23505'), 'one transcript per attempt');
    await asServer(d.owner);
    await db.query("update private.sc011b_voice_attempts set status='failed',outcome='voicemail' where id=$1", [td]);
    await assert.rejects(store(d, td), message('PT409', 'VOICE_TRANSCRIPT_UNAVAILABLE'), 'voicemail is not an interview');
    await assert.rejects(store(c, tc, c.recruitment.id, c.candidate.id, []), code('23514'), 'at least one utterance');
    assert.equal(await count(td), 0);
  });

  await t.test('a transcript is never changed and only retention or erasure removes it', async () => {
    await h.asAdmin();
    await assert.rejects(db.query(`update ${table} set utterances='[{"speaker":"agent","text":"x"}]'::jsonb where attempt_id=$1`, [ta]),
      message('42501', 'VOICE_TRANSCRIPT_IMMUTABLE'));
    await assert.rejects(db.query(`delete from ${table} where attempt_id=$1`, [ta]), message('42501', 'VOICE_TRANSCRIPT_IMMUTABLE'));
    await assert.rejects(db.query(`truncate ${table}`), message('42501', 'VOICE_TRANSCRIPT_IMMUTABLE'));
    assert.equal(await count(ta), 1);
  });

  await t.test('retention: kept while open, 89 days after closing and after reopening; closing by status stamps closed_at', async () => {
    assert.equal(await purge(), 0, 'open recruitment');
    await recruitment(a, "status='closed',closed_at=clock_timestamp()-interval '89 days'");
    assert.equal(await purge(), 0, 'closed 89 days ago');
    await recruitment(a, "status='open',closed_at=clock_timestamp()-interval '200 days'");
    assert.equal(await purge(), 0, 'reopened pauses retention');
    await recruitment(a, "status='closed'");
    const stamped = await closedAt(a);
    assert.ok(Date.now() - stamped.getTime() < 60_000, 'closing by status alone restarts the 90 days');
    assert.equal(await purge(), 0);
    for (const attempt of [ta, tb, tc]) assert.equal(await count(attempt), 1);
  });

  await t.test('erasure inventory R23 lists transcripts by attempt for their own candidates only', async () => {
    await h.asAdmin();
    const rows = (await db.query('select adapter,row_key from private.erasure_inventory_rows($1,$2)', [a.companyId, [a.candidate.id]])).rows;
    assert.deepEqual(rows.filter(r => r.adapter === table).map(r => r.row_key), [`${a.companyId}:${ta}`]);
  });

  await t.test('retention skips a candidate frozen for erasure; erasure removes the transcript before its attempt', async () => {
    // 91 days after closing (set before the freeze: a frozen candidate's recruitment is not changed).
    await recruitment(a, "closed_at=clock_timestamp()-interval '91 days'");
    const life = lifecycleHarness(h);
    await h.asUser(a.owner);
    await life.policy(a, 0, lifecycleRules);
    a.resolutionId = await life.resolve(a, [a.candidate.id]);
    await x.configure();
    const frozen = await life.freeze(a);
    assert.equal(await purge(), 2, 'b and c removed, a left to its erasure');
    assert.equal(await count(ta), 1);
    for (const attempt of [tb, tc]) { assert.equal(await count(attempt), 0); assert.equal(await attempts(attempt), 1, 'the call attempt stays'); }
    // A direct retention delete of the frozen candidate's transcript is refused too.
    await h.asAdmin();
    await db.query('begin');
    try {
      await db.query("select set_config('skillcheck.sc011b_transcript_purge','on',true)");
      await assert.rejects(db.query(`delete from ${table} where attempt_id=$1`, [ta]), message('PT409', 'Candidate workflow frozen'));
    } finally { await db.query('rollback'); }
    await h.asUser(a.owner);
    await x.transition(frozen.request_id, 0, 'authorized');
    await x.transition(frozen.request_id, 1, 'erasing');
    await x.purge(frozen.request_id, 2);
    assert.equal(await count(ta), 0);
    assert.equal(await attempts(ta), 0);
    await h.asAdmin();
    assert.equal(await one('select count(*)::int as v from private.sc010c_voice_preparations where id=$1', [pa.id]), 0);
    assert.equal(await purge(), 0);
  });

  await t.test('operational rollback keeps rows, adapters and signature', async () => {
    await h.asAdmin();
    const before = await one(`select count(*)::int as v from ${table}`);
    await db.query(await readFile(new URL('../supabase/rollbacks/20261120120000_r6_voice_transcripts_r23_down.sql', import.meta.url), 'utf8'));
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
    assert.equal(await one(`select count(*)::int as v from ${table}`), before);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      if (!await one('select to_regrole($1) is not null as v', [role])) continue;
      assert.equal(await one('select has_table_privilege($1,$2,$3) as v', [role, table, 'select']), false);
      for (const fn of [...guards, ...domainFns]) assert.equal(await one('select has_function_privilege($1,$2,$3) as v', [role, fn, 'execute']), false);
    }
  });
});
