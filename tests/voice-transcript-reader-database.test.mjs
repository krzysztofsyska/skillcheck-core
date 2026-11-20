// R6 #542: the recruiter's read-only transcript reader
// (20261120180000_r6_voice_transcript_reader.sql) on the full checked-in chain.
// public.read_voice_interview_transcripts returns the completed calls of ONE
// application with {speaker,text} lines only, to the company owner or a recruiter;
// a viewer, a non-member, a foreign company or a foreign application get 42501;
// a candidate frozen for erasure 55000; a transcript past the 90-day retention is shown
// as erased (also before the purge runs); every read is logged without text.
// Native disposable PostgreSQL only; synthetic data; no provider.
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
const fn = 'public.read_voice_interview_transcripts(uuid,uuid,uuid)';
const log = 'report_audit.voice_transcript_reads';
const behaviors = behaviorGuideDefinitions.map((x, i) => x.label + ': ' + (i < 4 ? 'Wysoki' : 'Standardowy'));
const ratings = ['insufficient_data', 'meets', 'below', 'meets', 'above'];
const digest = value => createHash('sha256').update(value).digest('hex');
const callId = () => 'call_' + randomBytes(12).toString('hex');
const agentId = 'agent_' + 'a'.repeat(24);
const code = (...codes) => e => codes.includes(e.code);

test('R6 #542: voice transcript reader is tenant-scoped, minimal, retention-aware and logged', async t => {
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

  // Same setup as tests/voice-transcripts-migration-database.test.mjs (R18..R23).
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
  const store = async (f, attempt, rows) => {
    await asServer(f.owner);
    await db.query(`insert into private.sc011b_voice_transcripts(attempt_id,company_id,recruitment_id,candidate_id,utterances)
      values($1,$2,$3,$4,$5::jsonb)`, [attempt, f.companyId, f.recruitment.id, f.candidate.id, JSON.stringify(rows)]);
  };
  const read = async (actor, f, overrides = {}) => {
    await h.asUser(actor);
    const args = { company: f.companyId, recruitment: f.recruitment.id, application: f.application.id, ...overrides };
    return (await db.query('select * from public.read_voice_interview_transcripts($1,$2,$3)',
      [args.company, args.recruitment, args.application])).rows;
  };
  const reads = async f => {
    await h.asAdmin();
    return (await db.query(`select actor_id,actor_role,application_id,transcripts_shown from ${log} where company_id=$1 order by created_at,id`,
      [f.companyId])).rows;
  };
  const member = async (f, user, role) => {
    await h.asAdmin();
    await db.query('insert into public.company_members(company_id,user_id,role) values($1,$2,$3)', [f.companyId, user, role]);
  };

  await t.test('installs: only authenticated executes, definer with empty search_path, log closed, signature unchanged', async () => {
    await h.asAdmin();
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
    assert.equal(await one('select prosecdef as v from pg_proc where oid=$1::regprocedure', [fn]), true);
    assert.equal(await one('select proconfig[1] as v from pg_proc where oid=$1::regprocedure', [fn]), 'search_path=""');
    assert.equal(await one("select has_function_privilege('authenticated',$1,'execute') as v", [fn]), true);
    for (const role of ['anon', 'service_role', 'screening_worker']) {
      if (!await one('select to_regrole($1) is not null as v', [role])) continue;
      assert.equal(await one('select has_function_privilege($1,$2,$3) as v', [role, fn, 'execute']), false, role);
    }
    for (const role of ['anon', 'authenticated', 'service_role']) {
      if (!await one('select to_regrole($1) is not null as v', [role])) continue;
      assert.equal(await one("select has_schema_privilege($1,'report_audit','usage') as v", [role]), false, role);
      assert.equal(await one("select has_table_privilege($1,'private.sc011b_voice_transcripts','select') as v", [role]), false, role);
    }
    assert.equal(await one('select c.relrowsecurity as v from pg_class c where c.oid=$1::regclass', [log]), true);
  });

  await h.asAdmin();
  await db.query('insert into private.voice_plan_template_catalog(version,manifest_digest,active) values($1,$2,true)',
    ['skillcheck-voice-plan-v1', trustedVoiceTemplateDigest('skillcheck-voice-plan-v1')]);
  const a = await ready();
  const b = await ready(a);          // same company, another application
  const a2 = await ready(a), a3 = await ready(a);
  // Another company with its own owner (one company per owner account).
  const base = await credited.seed(users.otherOwner);
  await h.asAdmin();
  base.position = (await db.query('update public.positions set required_behaviors=$1 where id=$2 returning *', [[...behaviors], base.position.id])).rows[0];
  await permission.contact.register(base);
  const foreign = await ready(base);
  const pool = await grant(a, 10), foreignPool = await grant(foreign, 10);
  const [pa1, pa2, pa3, pb] = [await prepare(a, pool), await prepare(a2, pool), await prepare(a3, pool), await prepare(b, pool)];
  const pf = await prepare(foreign, foreignPool);
  const ta1 = await call(a, pa1, 'completed', 'completed');
  const ta2 = await call(a2, pa2, 'completed', 'completed');  // completed, transcript not received
  await call(a3, pa3);                                          // still running: not listed
  const tb = await call(b, pb, 'completed', 'completed');
  const tf = await call(foreign, pf, 'completed', 'completed');
  // A stored row with an extra key: only {speaker,text} may leave the database.
  await store(a, ta1, [{ speaker: 'agent', text: 'Syntetyczne pytanie A.', confidence: 0.9 }, { speaker: 'candidate', text: 'Syntetyczna odpowiedź A.' }]);
  await store(b, tb, [{ speaker: 'agent', text: 'Syntetyczne pytanie B.' }]);
  await store(foreign, tf, [{ speaker: 'agent', text: 'Syntetyczne pytanie obcej firmy.' }]);
  await member(a, users.recruiter, 'recruiter');
  await member(a, users.viewer, 'viewer');

  await t.test('owner reads completed calls of this application only, minimal columns, read logged', async () => {
    const rows = await read(a.owner, a);
    assert.deepEqual(rows.map(r => Object.keys(r).sort()), [['call_at', 'call_no', 'transcript_state', 'utterances']]);
    assert.deepEqual(rows.map(r => [r.call_no, r.transcript_state]), [[1, 'available']]);
    assert.deepEqual(rows[0].utterances, [{ speaker: 'agent', text: 'Syntetyczne pytanie A.' }, { speaker: 'candidate', text: 'Syntetyczna odpowiedź A.' }]);
    assert.ok(!JSON.stringify(rows).includes('pytanie B') && !JSON.stringify(rows).includes('obcej firmy'), 'other applications and tenants stay out');
    assert.ok(!JSON.stringify(rows).includes(ta1), 'no attempt ids');
    assert.deepEqual(await reads(a), [{ actor_id: a.owner, actor_role: 'owner', application_id: a.application.id, transcripts_shown: 1 }]);
    const pending = await read(a.owner, a2);
    assert.deepEqual(pending.map(r => [r.call_no, r.transcript_state, r.utterances]), [[1, 'not_received', null]]);
    assert.ok(!JSON.stringify(pending).includes(ta2));
    assert.deepEqual(await read(a.owner, a3), [], 'a call still running is not listed');
    const other = await read(a.owner, b);
    assert.deepEqual(other.map(r => [r.call_no, r.transcript_state, r.utterances]), [[1, 'available', [{ speaker: 'agent', text: 'Syntetyczne pytanie B.' }]]]);
  });

  await t.test('recruiter may read; viewer, non-member, foreign company and foreign application are denied alike', async () => {
    assert.equal((await read(users.recruiter, a)).length, 1);
    assert.equal((await reads(a)).at(-1).actor_role, 'recruiter');
    const before = (await reads(a)).length;
    await assert.rejects(read(users.viewer, a), code('42501'), 'viewer');
    await assert.rejects(read(users.outsider, a), code('42501'), 'outsider');
    await assert.rejects(read(users.otherOwner, a), code('42501'), 'owner of the foreign company');
    // Membership in the foreign company does not open company A's application (and vice versa).
    await assert.rejects(read(a.owner, a, { company: foreign.companyId }), code('42501'), 'application under a foreign company');
    await assert.rejects(read(a.owner, foreign, { company: a.companyId }), code('42501'), 'foreign application under own company');
    await assert.rejects(read(a.owner, a, { recruitment: foreign.recruitment.id }), code('42501'), 'foreign recruitment');
    await assert.rejects(read(a.owner, a, { application: randomUUID() }), code('42501'), 'missing application');
    await assert.rejects(read(users.recruiter, a, { company: foreign.companyId, recruitment: foreign.recruitment.id, application: foreign.application.id }),
      code('42501'), 'recruiter of A reads foreign tenant');
    assert.equal((await reads(a)).length, before, 'denied reads write nothing');
    await h.asUser(a.owner);
    await assert.rejects(db.query(`select actor_id from ${log}`), code('42501'));
    await assert.rejects(db.query('select attempt_id from private.sc011b_voice_transcripts'), code('42501'));
    await h.asUser(null, 'anon');
    await assert.rejects(db.query('select * from public.read_voice_interview_transcripts($1,$2,$3)', [a.companyId, a.recruitment.id, a.application.id]), code('42501'));
  });

  await t.test('past the 90-day retention the transcript is shown as erased, before and after the purge', async () => {
    await h.asAdmin();
    await db.query("update public.recruitments set status='closed',closed_at=clock_timestamp()-interval '89 days' where id=$1", [a.recruitment.id]);
    assert.equal((await read(a.owner, a))[0].transcript_state, 'available', '89 days: still kept');
    await h.asAdmin();
    await db.query("update public.recruitments set closed_at=clock_timestamp()-interval '91 days' where id=$1", [a.recruitment.id]);
    let rows = await read(a.owner, a);
    assert.deepEqual(rows.map(r => [r.transcript_state, r.utterances]), [['erased_retention', null]]);
    assert.equal((await reads(a)).at(-1).transcripts_shown, 0);
    await h.asAdmin();
    assert.ok(await one('select private.sc011b_purge_voice_transcripts() as v') >= 1);
    assert.equal(await one('select count(*)::int as v from private.sc011b_voice_transcripts where attempt_id=$1', [ta1]), 0);
    rows = await read(a.owner, a);
    assert.deepEqual(rows.map(r => r.transcript_state), ['erased_retention']);
    assert.ok(!JSON.stringify(rows).includes('Syntetyczne'));
  });

  await t.test('a candidate frozen for erasure is refused with 55000 and nothing is logged', async () => {
    assert.equal((await read(foreign.owner, foreign))[0].transcript_state, 'available');
    const before = (await reads(foreign)).length;
    const life = lifecycleHarness(h);
    await h.asUser(foreign.owner);
    await life.policy(foreign, 0, lifecycleRules);
    foreign.resolutionId = await life.resolve(foreign, [foreign.candidate.id]);
    await x.configure();
    await life.freeze(foreign);
    await assert.rejects(read(foreign.owner, foreign), code('55000'));
    assert.equal((await reads(foreign)).length, before);
  });

  await t.test('the access log is immutable and holds no conversation text', async () => {
    await h.asAdmin();
    await assert.rejects(db.query(`update ${log} set transcripts_shown=5`), code('42501'));
    await assert.rejects(db.query(`delete from ${log}`), code('42501'));
    await assert.rejects(db.query(`truncate ${log}`), code('42501'));
    const columns = (await db.query("select column_name as v from information_schema.columns where table_schema='report_audit' and table_name='voice_transcript_reads' order by ordinal_position")).rows.map(r => r.v);
    assert.deepEqual(columns, ['id', 'company_id', 'recruitment_id', 'application_id', 'actor_id', 'actor_role', 'transcripts_shown', 'created_at']);
  });

  await t.test('rollback refuses while reads are logged; on an empty log it removes reader and log, signature kept', async () => {
    const rollback = await readFile(new URL('../supabase/rollbacks/20261120180000_r6_voice_transcript_reader_down.sql', import.meta.url), 'utf8');
    await h.asAdmin();
    await assert.rejects(db.query(rollback), e => /r6_voice_transcript_reader_rollback_not_empty/.test(e.message));
    await db.query('rollback').catch(() => {});
    await db.query('begin');
    try {
      await db.query("select set_config('report_audit.purge_company',$1,true)", [a.companyId]);
      await db.query(`delete from ${log} where company_id=$1`, [a.companyId]);
      await db.query("select set_config('report_audit.purge_company',$1,true)", [foreign.companyId]);
      await db.query(`delete from ${log} where company_id=$1`, [foreign.companyId]);
      await db.query('commit');
    } catch (error) { await db.query('rollback'); throw error; }
    await db.query(rollback);
    assert.equal(await one('select to_regclass($1) is null as v', [log]), true);
    assert.equal(await one('select to_regprocedure($1) is null as v', [fn]), true);
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
  });
});
