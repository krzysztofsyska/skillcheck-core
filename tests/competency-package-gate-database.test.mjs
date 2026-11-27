import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { activeBoot, users, hash } from './helpers/competency-active-fixture.mjs';

// R7 SC-019b (issue #638, 20261127170000_r7_competency_test_package_gate.sql): a NEW
// competency test access, issued by hand (create_competency_test_grant) or in the
// automatic mode (issue_exercise_ai_auto_access), needs a paid WERYFIKACJA or ASSESSMENT
// CENTER package (sc19_commerce.entitlements 'package:…', available > 0). Native PG16/17,
// the whole checked-in migration chain.
const migration = '20261127170000_r7_competency_test_package_gate.sql';
const sql = path => readFile(new URL(`../supabase/${path}`, import.meta.url), 'utf8');
const packageRequired = e => e.code === 'PT402' && e.message === 'Competency test package required';
const denied = (...codes) => e => codes.includes(e.code);

test('R7 SC-019b: only WERYFIKACJA / ASSESSMENT CENTER companies issue a new competency test; issued tests keep working', async t => {
  const e = await activeBoot(t, { fullChain: true }), { db, h, call } = e;
  await h.asAdmin();
  // Same signature, owner, security definer, search_path and owner-only grant as before.
  assert.deepEqual((await db.query(`select proacl::text acl, prosecdef, pg_get_userbyid(proowner) owner, proconfig
    from pg_proc where oid='sc19_commerce.consume_skill_test(uuid)'::regprocedure`)).rows[0],
  { acl: '{postgres=X/postgres}', prosecdef: true, owner: 'postgres', proconfig: ['search_path=""'] });
  const signature = (await db.query('select private.erasure_schema_signature() s')).rows[0].s;

  // Four fictional companies: FREE (no package row at all), PRESELEKCJA only,
  // WERYFIKACJA and ASSESSMENT CENTER. Each has a shortlisted application (R1).
  const free = await e.seed({ owner: users.recruiter, package: null });
  const pre = await e.seed({ owner: users.viewer, package: 'PRESELEKCJA' });
  const wer = await e.seed({ owner: users.owner, package: 'WERYFIKACJA' });
  const ac = await e.seed({ owner: users.otherOwner, package: 'ASSESSMENT_CENTER' });
  const grants = async f => { await h.asAdmin();
    return (await db.query('select count(*)::int n from private.competency_test_grants where company_id=$1', [f.companyId])).rows[0].n; };
  const issue = (f, key = randomUUID()) => e.issue(f, { key });
  const provenance = x => JSON.stringify({ provider: 'synthetic', model: 'fixture', prompt_version: 'v1', payload_schema_version: 1,
    result_schema_version: 1, input_fingerprint: 'a'.repeat(64), position_id: x.position.id, position_updated_at: x.position.updated_at });
  // Automatic mode: the AI test version is recorded, approved and the mode switched on.
  const automatic = async f => {
    await h.asUser(f.owner);
    await db.query('select exercise_ai.record_proposal($1,$2,$3::jsonb,20)', [f.recruitment.id, f.definitionId, provenance(f)]);
    await db.query('select exercise_ai.approve_proposal($1)', [f.definitionId]);
    assert.equal(await call('public.set_exercise_ai_auto_release', [f.companyId, f.recruitment.id, true]), true);
  };
  const auto = async f => { await h.asUser(f.owner); return call('public.issue_exercise_ai_auto_access', [f.companyId, f.recruitment.id]); };

  await t.test('FREE and PRESELEKCJA-only: manual and automatic issuance refused (PT402), nothing written', async () => {
    for (const f of [free, pre]) {
      await assert.rejects(issue(f), packageRequired);
      assert.equal(await grants(f), 0);
      await automatic(f);
      await assert.rejects(auto(f), packageRequired);
      assert.equal(await grants(f), 0);
    }
  });

  await t.test('an outsider still gets 42501 first and learns nothing about the package', async () => {
    await h.asUser(users.outsider);
    await assert.rejects(call('public.create_competency_test_grant',
      [free.application.id, free.definitionId, new Date(Date.now() + 3600000).toISOString(), randomUUID()]), denied('42501', 'PT404'));
    await assert.rejects(call('public.issue_exercise_ai_auto_access', [free.companyId, free.recruitment.id]), denied('42501'));
    assert.equal(await grants(free), 0);
  });

  await t.test('WERYFIKACJA (manual) and ASSESSMENT CENTER (automatic) are allowed; the package is not used up', async () => {
    const g = await issue(wer);
    assert.match(g.token, /^[0-9a-f]{64}$/);
    assert.equal(await grants(wer), 1);
    await automatic(ac);
    const result = await auto(ac);
    assert.equal(result.issued, 1);
    assert.equal(await grants(ac), 1);
    await h.asAdmin();
    assert.deepEqual((await db.query(`select code, available, used from sc19_commerce.entitlements
      where company_id = any($1) and code like 'package:%' order by code`, [[wer.companyId, ac.companyId]])).rows,
    [{ code: 'package:ASSESSMENT_CENTER', available: 1, used: 0 }, { code: 'package:WERYFIKACJA', available: 1, used: 0 }]);
    wer.issued = g;
  });

  await t.test('another company\'s package or a package with available 0 does not open the test', async () => {
    // FREE company: two other companies hold packages, still refused.
    await assert.rejects(issue(free), packageRequired);
    // WERYFIKACJA company whose package row reads available 0: a new application is refused.
    const second = await e.seed({ tenant: wer });
    await h.asAdmin();
    await db.query("update sc19_commerce.entitlements set available=0 where company_id=$1 and code='package:WERYFIKACJA'", [wer.companyId]);
    await assert.rejects(issue(second), packageRequired);
    assert.equal(await grants(wer), 1);
  });

  await t.test('a test issued before the package went away still works: replay, rotation, exchange, start, submit', async () => {
    const g = wer.issued;
    // Idempotent replay of the same request returns the existing grant, no PT402.
    await h.asUser(wer.owner);
    assert.equal((await call('public.create_competency_test_grant', [wer.application.id, wer.definitionId, g.startBy, g.key])).state,
      'secret_unavailable_rotate_required');
    const rotated = await call('public.rotate_competency_test_grant', [g.grantId, 1, randomUUID()]);
    assert.match(rotated.token, /^[0-9a-f]{64}$/);
    const s = await e.exchange(rotated);
    const a = await call('private.start_candidate_competency_test', [hash(s.session), randomUUID()]);
    assert.ok(a.attemptId);
    const receipt = await call('private.submit_candidate_competency_test',
      [hash(s.session), JSON.stringify({ workSample: 'Plan wdrożenia obejmuje terminy i komunikację.' }), randomUUID()]);
    assert.ok(receipt);
    await h.asAdmin();
    assert.equal((await db.query('select count(*)::int n from public.competency_test_attempts where grant_id=$1 and submitted_at is not null',
      [g.grantId])).rows[0].n, 1);
  });

  await t.test('nothing else changed: erasure signature and grants', async () => {
    await h.asAdmin();
    assert.equal((await db.query('select private.erasure_schema_signature() s')).rows[0].s, signature);
  });

  await t.test('negative proof: without the gate a FREE company issues; the migration refuses a re-run and an unknown issuer', async () => {
    await h.asAdmin();
    await assert.rejects(db.query(await sql(`migrations/${migration}`)), /r7_competency_package_gate_source_unreviewed/);
    await db.query('rollback').catch(() => {});
    await db.query(await sql(`rollbacks/${migration.replace('.sql', '_down.sql')}`));
    await db.query(await sql(`rollbacks/${migration.replace('.sql', '_down.sql')}`)); // idempotent
    const g = await issue(free);
    assert.match(g.token, /^[0-9a-f]{64}$/, 'the gate test would fail if the gate were missing');
    assert.equal(await grants(free), 1);
    await h.asAdmin();
    // A third function creating competency test access blocks the migration.
    await db.query(`create function private.sc019b_rogue_issuer() returns void language sql as
      $$ insert into private.competency_test_grants select * from private.competency_test_grants where false $$`);
    await assert.rejects(db.query(await sql(`migrations/${migration}`)), /r7_competency_package_gate_unknown_issuer/);
    await db.query('rollback').catch(() => {});
    await db.query('drop function private.sc019b_rogue_issuer()');
    await db.query(await sql(`migrations/${migration}`));
    const third = await e.seed({ tenant: free });
    await assert.rejects(issue(third), packageRequired);
    await h.asAdmin();
    assert.equal(await grants(free), 1);
    assert.equal((await db.query('select private.erasure_schema_signature() s')).rows[0].s, signature);
  });
});
