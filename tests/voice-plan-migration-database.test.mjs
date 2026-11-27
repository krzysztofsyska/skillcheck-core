// R6-1c part 1: the SC-012-B voice plan tables and review/release RPCs as a real
// migration (20261119100000_r6_voice_plan_r18.sql) on the full checked-in chain.
// Native disposable PostgreSQL only; synthetic data; no provider, no API grant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { activeBoot, users } from './helpers/competency-active-fixture.mjs';
import { seedSyntheticPolicy } from './helpers/sc19-migration-fixture.mjs';
import { lifecycleHarness, lifecycleRules } from './helpers/erasure-lifecycle-fixture.mjs';
import { behaviorGuideDefinitions } from '../lib/behavior-guide.ts';
import { canonicalVoiceSourceSnapshot } from '../lib/voice/plan-persistence-contract.ts';
import { trustedVoiceTemplateDigest } from '../lib/voice/template-registry.ts';
import { reconstructTrustedVoiceSource } from '../lib/voice/trusted-source-verifier.ts';

// Full current chain: R24 (SC-003a criterion review history) on top of R23 (R6-1c part 7 voice transcripts), which builds on R22 (voice dispatch resolution), R21, R20, R19 and R18.
const signature = 'bc5fe11ba2c0cd33015c00b2283403532f338630f3e9661b91847d6979726235';
const planTables = ['public.voice_plan_versions', 'private.voice_plan_review_entries', 'private.voice_plan_release_entries',
  'private.voice_plan_current_releases', 'private.voice_plan_request_keys'];
const newTables = [...planTables, 'private.voice_plan_template_catalog'];
const rpcs = ['private.sc012b_review_plan(uuid,bigint,text,text,text,uuid)',
  'private.sc012b_release_plan(uuid,uuid,text,bigint,uuid,uuid)', 'private.sc012b_current_release(uuid)'];
const behaviors = behaviorGuideDefinitions.map((x, i) => x.label + ': ' + (i < 4 ? 'Wysoki' : 'Standardowy'));
const otherHash = 'f'.repeat(64);

test('R6-1c: voice plan migration is closed, works on the full chain and is erased with the candidate', async t => {
  const { db, h, x } = await activeBoot(t, { fullChain: true });
  let policySeeded = false;
  const asServer = async actor => { await h.asAdmin(); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [actor]); };
  const one = async (sql, args) => (await db.query(sql, args)).rows[0].v;

  // Synthetic shortlisted application with an approved screening review.
  const prepared = async owner => {
    const f = await h.seed(owner);
    await h.asAdmin();
    if (!policySeeded) { await seedSyntheticPolicy(db); policySeeded = true; }
    await db.query('select private.sc19_grant_paid($1,$2)', [f.companyId, `synthetic-voice-${randomUUID()}`]);
    await h.asUser(owner);
    await db.query('update public.positions set required_behaviors=$1 where id=$2', [behaviors, f.position.id]);
    const c = await h.completedApplication(f, ['insufficient_data', 'meets', 'below', 'meets', 'above']);
    await h.asUser(owner);
    const shortlist = await h.add(c);
    await asServer(owner);
    const source = await reconstructTrustedVoiceSource(db, { companyId: c.companyId, applicationId: c.application.id,
      analysisId: c.analysis_id, reviewId: c.reviewId, shortlistEntryId: shortlist });
    return { ...c, shortlist, source };
  };
  const persistPlan = async (f, { version = 1, supersedes = null, corrects = null, envelopeHash = f.source.planContractHash } = {}) => {
    await asServer(f.owner);
    return one(`insert into public.voice_plan_versions
      (company_id,recruitment_id,application_id,position_id,analysis_id,screening_review_id,shortlist_entry_id,
       supersedes_plan_id,corrects_review_id,plan_version,source_hash,envelope_hash,source_snapshot,plan_envelope,
       template_version,created_by,retention_policy_version,retention_deadline)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,'skillcheck-voice-plan-v1',$15,'synthetic-v1',
       clock_timestamp()+interval '30 days') returning id as v`,
    [f.companyId, f.recruitment.id, f.application.id, f.position.id, f.analysis_id, f.reviewId, f.shortlist,
      supersedes, corrects, version, f.source.sourceHash, envelopeHash,
      JSON.stringify(canonicalVoiceSourceSnapshot(f.source.sourceBinding, f.source.planSourceFingerprint)),
      JSON.stringify(f.source), f.owner]);
  };
  const reviewPlan = async (f, plan, expected, decision, reason = null, key = randomUUID()) => {
    await asServer(f.owner);
    return one('select private.sc012b_review_plan($1,$2,$3,$4,$5,$6) as v', [plan, expected, f.source.sourceHash, decision, reason, key]);
  };
  const releasePlan = async (f, plan, reviewId, key = randomUUID()) => {
    await asServer(f.owner);
    return one('select private.sc012b_release_plan($1,$2,$3,null,null,$4) as v', [plan, reviewId, f.source.sourceHash, key]);
  };
  const counts = async f => {
    await h.asAdmin();
    const result = {};
    for (const table of planTables) result[table] = await one(`select count(*)::int as v from ${table} where company_id=$1`, [f.companyId]);
    return result;
  };

  await t.test('installs inventory R18 and grants nothing to API roles', async () => {
    await h.asAdmin();
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
    const known = await one('select known_tables as v from private.erasure_inventory_baseline_r18 where singleton');
    for (const table of [...newTables, 'private.erasure_inventory_baseline_r18']) assert.ok(known.includes(table), table);
    assert.equal(await one('select count(*)::int as v from private.voice_plan_template_catalog'), 0, 'no template version is seeded');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      if (!await one('select to_regrole($1) is not null as v', [role])) continue;
      for (const table of newTables) {
        assert.equal(await one('select has_table_privilege($1,$2,$3) as v', [role, table, 'select,insert,update,delete,truncate,references,trigger']), false, `${role} ${table}`);
        assert.equal(await one('select c.relrowsecurity and c.relforcerowsecurity as v from pg_class c where c.oid=$1::regclass', [table]), true, table);
      }
      for (const fn of rpcs) assert.equal(await one('select has_function_privilege($1,$2,$3) as v', [role, fn, 'execute']), false, `${role} ${fn}`);
    }
    for (const fn of rpcs) {
      assert.deepEqual(await one('select proconfig as v from pg_proc where oid=$1::regprocedure', [fn]), ['search_path=""'], fn);
      assert.equal(await one('select prosecdef as v from pg_proc where oid=$1::regprocedure', [fn]), true, fn);
    }
    await h.asUser(users.owner);
    await assert.rejects(db.query('select * from public.voice_plan_versions'), e => e.code === '42501');
    await assert.rejects(db.query('select private.sc012b_current_release($1)', [randomUUID()]), e => e.code === '42501');
    await h.asUser(null, 'anon');
    await assert.rejects(db.query('select * from public.voice_plan_versions'), e => e.code === '42501');
    await h.asAdmin();
  });

  await h.asAdmin();
  await db.query('insert into private.voice_plan_template_catalog(version,manifest_digest,active) values($1,$2,true)',
    ['skillcheck-voice-plan-v1', trustedVoiceTemplateDigest('skillcheck-voice-plan-v1')]);
  const a = await prepared(users.owner);
  const b = await prepared(users.otherOwner);
  let releaseA;

  await t.test('review/release RPCs work on the current schema: correction lineage, replay, pointer', async () => {
    const first = await persistPlan(a);
    const rejectKey = randomUUID();
    const rejected = await reviewPlan(a, first, 0, 'requires_changes', 'Synthetic correction request', rejectKey);
    assert.equal(await reviewPlan(a, first, 0, 'requires_changes', 'Synthetic correction request', rejectKey), rejected, 'exact replay');
    await assert.rejects(reviewPlan(a, first, 1, 'approved'), e => e.code === 'PT409');
    const second = await persistPlan(a, { version: 2, supersedes: first, corrects: rejected, envelopeHash: otherHash });
    const approved = await reviewPlan(a, second, 0, 'approved');
    releaseA = await releasePlan(a, second, approved);
    await asServer(a.owner);
    assert.equal(await one('select private.sc012b_current_release($1) as v', [a.application.id]), releaseA);
    const planB = await persistPlan(b);
    await releasePlan(b, planB, await reviewPlan(b, planB, 0, 'approved'));
    assert.deepEqual(await counts(a), { 'public.voice_plan_versions': 2, 'private.voice_plan_review_entries': 2,
      'private.voice_plan_release_entries': 1, 'private.voice_plan_current_releases': 1, 'private.voice_plan_request_keys': 3 });
  });

  await t.test('foreign tenant cannot use the RPCs; history is immutable outside the purge', async () => {
    const plan = await one('select id as v from public.voice_plan_versions where company_id=$1 and plan_version=2', [a.companyId]);
    await asServer(users.otherOwner);
    await assert.rejects(db.query('select private.sc012b_review_plan($1,1,$2,$3,null,$4)', [plan, a.source.sourceHash, 'approved', randomUUID()]),
      e => e.code === '42501');
    await assert.rejects(db.query('select private.sc012b_current_release($1)', [a.application.id]), e => e.code === '42501');
    await h.asAdmin();
    await assert.rejects(db.query('delete from public.voice_plan_versions where id=$1', [plan]), e => e.code === '42501');
    await assert.rejects(db.query("update private.voice_plan_review_entries set reason='x' where plan_id=$1", [plan]), e => e.code === '42501');
    await assert.rejects(db.query('delete from private.voice_plan_request_keys where company_id=$1', [a.companyId]), e => e.code === '42501');
  });

  await t.test('candidate erasure inventories, freezes and purges only that candidate\'s voice plan rows', async () => {
    await h.asAdmin();
    const rows = (await db.query('select adapter,row_key from private.erasure_inventory_rows($1,$2)', [a.companyId, [a.candidate.id]])).rows;
    for (const table of planTables) assert.ok(rows.some(r => r.adapter === table), table);
    assert.equal(rows.filter(r => r.adapter.includes('voice_plan')).length, 9);
    assert.ok(!(await db.query('select 1 from private.erasure_inventory_rows($1,$2) where adapter like $3', [a.companyId, [b.candidate.id], '%voice_plan%'])).rows.length,
      'another tenant\'s candidate is not inventoried under this company');
    const life = lifecycleHarness(h);
    await h.asUser(a.owner);
    await life.policy(a, 0, lifecycleRules);
    a.resolutionId = await life.resolve(a, [a.candidate.id]);
    await x.configure();
    const frozen = await life.freeze(a);
    await h.asAdmin();
    const plan = await one('select id as v from public.voice_plan_versions where company_id=$1 and plan_version=2', [a.companyId]);
    await asServer(a.owner);
    await assert.rejects(db.query('select private.sc012b_review_plan($1,1,$2,$3,null,$4)', [plan, a.source.sourceHash, 'approved', randomUUID()]),
      e => e.code === 'PT409');
    assert.equal(await one('select private.sc012b_current_release($1) as v', [a.application.id]), null, 'frozen candidate releases nothing');
    await x.transition(frozen.request_id, 0, 'authorized');
    await x.transition(frozen.request_id, 1, 'erasing');
    await x.purge(frozen.request_id, 2);
    assert.deepEqual(Object.values(await counts(a)), [0, 0, 0, 0, 0]);
    assert.deepEqual(Object.values(await counts(b)), [1, 1, 1, 1, 2], 'other tenant untouched');
    await h.asAdmin();
    assert.equal(await one('select count(*)::int as v from private.voice_plan_template_catalog'), 1, 'catalog is not candidate data');
  });

  await t.test('operational rollback keeps rows, adapters and signature', async () => {
    await h.asAdmin();
    await db.query(await readFile(new URL('../supabase/rollbacks/20261119100000_r6_voice_plan_r18_down.sql', import.meta.url), 'utf8'));
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
    assert.deepEqual(Object.values(await counts(b)), [1, 1, 1, 1, 2]);
  });
});
