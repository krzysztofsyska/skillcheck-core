// R0 SC-003a (#621): immutable history of human corrections per criterion
// (20261127120000_sc003a_criterion_review_history.sql) on the full checked-in
// chain. Native disposable PostgreSQL 16/17, two synthetic companies, the
// `authenticated` role with RLS as in Supabase, fictitious candidates only.
// Covers: two corrections give two history rows with previous and new values;
// the AI result is untouched; another company sees nothing; a read-only member
// reads but cannot correct or write; no direct insert, update or delete; the
// candidate erasure (SC-010 inventory R24) removes the history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { activeBoot, users } from './helpers/competency-active-fixture.mjs';
import { seedSyntheticPolicy } from './helpers/sc19-migration-fixture.mjs';
import { lifecycleHarness, lifecycleRules } from './helpers/erasure-lifecycle-fixture.mjs';

const migration = '20261127120000_sc003a_criterion_review_history.sql';
const signature = 'bc5fe11ba2c0cd33015c00b2283403532f338630f3e9661b91847d6979726235';
const table = 'public.screening_criterion_review_history';
const code = (...codes) => e => codes.includes(e.code);
const quote = [{ start: 4, end: 13, quote: 'expertise' }];

test('SC-003a: every human correction of an evidence row is kept as an immutable, tenant-scoped history', async t => {
  const { db, h, x } = await activeBoot(t, { fullChain: true });
  const one = async (sql, args) => (await db.query(sql, args)).rows[0].v;
  let policySeeded = false;
  // Company with an owner, a recruiter and a read-only member; one completed analysis
  // turned into an evidence matrix (verdicts set, AI evidence quoting the redacted CV).
  const tenant = async (owner, members = []) => {
    const f = await h.seed(owner);
    await h.asAdmin();
    if (!policySeeded) { await seedSyntheticPolicy(db); policySeeded = true; }
    await db.query('select private.sc19_grant_paid($1,$2)', [f.companyId, `synthetic-sc003a-${f.companyId}`]);
    for (const [user, role] of members) await db.query(
      'insert into public.company_members(company_id,user_id,role) values($1,$2,$3) on conflict(company_id,user_id) do nothing',
      [f.companyId, user, role]);
    const done = await h.completedApplication(f, ['meets', 'meets', 'meets', 'meets', 'meets'], null);
    await h.asAdmin();
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
    await db.query("update public.screening_criterion_results set verdict='supported' where analysis_id=$1", [done.analysis_id]);
    await h.asAdmin();
    const rows = (await db.query('select id,updated_at from public.screening_criterion_results where analysis_id=$1 order by criterion_order', [done.analysis_id])).rows;
    return { ...done, criteria: rows };
  };
  const review = async (f, actor, criterion, status, extra = {}) => {
    await h.asAdmin();
    const expected = await one('select updated_at::text as v from public.screening_criterion_results where id=$1', [criterion]);
    await h.asUser(actor);
    return one('select public.review_screening_evidence_row($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) as v',
      [f.companyId, f.analysis_id, criterion, expected, status, extra.note ?? null, extra.verdict ?? null,
        extra.missing ?? null, extra.question ?? null, extra.evidence ? JSON.stringify(extra.evidence) : null]);
  };
  const history = async (actor, criterion) => {
    if (actor) await h.asUser(actor); else await h.asAdmin();
    return (await db.query(`select * from ${table} where criterion_result_id=$1 order by created_at,id`, [criterion])).rows;
  };
  const aiResult = async criterion => {
    await h.asAdmin();
    return (await db.query('select rating,verdict,evidence,explanation,missing_info,suggested_question from public.screening_criterion_results where id=$1', [criterion])).rows[0];
  };
  const versionOf = async f => { await h.asAdmin(); return one('select latest_review_version as v from public.screening_analysis_versions where id=$1', [f.analysis_id]); };

  const a = await tenant(users.owner, [[users.recruiter, 'recruiter'], [users.viewer, 'viewer']]);
  const b = await tenant(users.otherOwner);
  const [first, second] = a.criteria.map(row => row.id);

  await t.test('installs inventory R24 with the history table, RLS on, select only for authenticated', async () => {
    await h.asAdmin();
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
    const known = await one('select known_tables as v from private.erasure_inventory_baseline_r24 where singleton');
    for (const name of [table, 'private.erasure_inventory_baseline_r24', 'public.screening_criterion_results']) assert.ok(known.includes(name), name);
    assert.equal(await one(`select count(*)::int as v from ${table}`), 0, 'no data migration: history starts empty');
    assert.equal(await one('select relrowsecurity as v from pg_class where oid=$1::regclass', [table]), true);
    assert.equal(await one('select has_table_privilege($1,$2,$3) as v', ['authenticated', table, 'select']), true);
    for (const privilege of ['insert', 'update', 'delete', 'truncate'])
      assert.equal(await one('select has_table_privilege($1,$2,$3) as v', ['authenticated', table, privilege]), false, privilege);
    for (const role of ['anon', 'screening_worker'])
      assert.equal(await one("select has_table_privilege($1,$2,'select,insert,update,delete') as v", [role, table]), false, role);
    const fn = await one(`select jsonb_build_object('definer',prosecdef,'config',proconfig) as v from pg_proc
      where oid='public.review_screening_evidence_row(uuid,uuid,uuid,timestamptz,text,text,text,text,text,jsonb)'::regprocedure`);
    assert.deepEqual(fn, { definer: true, config: ['search_path=""'] });
  });

  await t.test('two consecutive corrections give two history rows with previous and new values; AI result untouched', async () => {
    const before = await aiResult(first);
    const v0 = await versionOf(a);
    await review(a, users.owner, first, 'accepted', { note: 'Pierwsza ocena' });
    await review(a, users.recruiter, first, 'edited', {
      note: 'Poprawka rekrutera', verdict: 'partial', missing: 'Brak dat', question: 'Od kiedy?', evidence: quote });
    const rows = await history(users.owner, first);
    assert.equal(rows.length, 2);
    const [r1, r2] = rows;
    assert.deepEqual([r1.company_id, r1.analysis_id, r1.criterion_result_id], [a.companyId, a.analysis_id, first]);
    assert.equal(r1.actor_id, users.owner);
    assert.equal(r1.previous_status, 'unreviewed');
    assert.equal(r1.new_status, 'accepted');
    assert.equal(r1.new_note, 'Pierwsza ocena');
    assert.equal(r1.review_version, v0 + 1);
    assert.equal(r2.actor_id, users.recruiter);
    assert.equal(r2.previous_status, 'accepted');
    assert.equal(r2.previous_note, 'Pierwsza ocena');
    assert.deepEqual([r2.new_status, r2.new_note, r2.new_verdict, r2.new_missing_info, r2.new_question],
      ['edited', 'Poprawka rekrutera', 'partial', 'Brak dat', 'Od kiedy?']);
    assert.deepEqual(r2.new_evidence, quote);
    assert.equal(r2.previous_evidence, null);
    assert.equal(r2.review_version, v0 + 2);
    assert.ok(r2.created_at >= r1.created_at);
    assert.deepEqual(await aiResult(first), before, 'verdict, evidence and rating of the AI stay as produced');
    // The current row shows the latest correction, the history keeps the earlier one.
    await h.asAdmin();
    assert.equal(await one('select human_note as v from public.screening_criterion_results where id=$1', [first]), 'Poprawka rekrutera');
  });

  await t.test('a note-only change is logged without a new review number; an unchanged call logs nothing', async () => {
    const v = await versionOf(a);
    await review(a, users.owner, second, 'unreviewed', { note: 'Tylko notatka' });
    let rows = await history(null, second);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].review_version, v);
    assert.equal(await versionOf(a), v);
    await review(a, users.owner, second, 'unreviewed', { note: 'Tylko notatka' });
    rows = await history(null, second);
    assert.equal(rows.length, 1, 'repeating the same values is not a change');
  });

  await t.test('another company sees no history and cannot correct this company\'s rows', async () => {
    assert.deepEqual(await history(users.otherOwner, first), []);
    assert.deepEqual(await history(users.outsider, first), []);
    await h.asUser(users.otherOwner);
    assert.equal(await one(`select count(*)::int as v from ${table}`), 0);
    await assert.rejects(review(a, users.otherOwner, first, 'rejected'), code('42501'));
    assert.equal((await history(null, first)).length, 2);
    // And the other company's own corrections stay its own.
    await review(b, users.otherOwner, b.criteria[0].id, 'rejected');
    await h.asUser(users.owner);
    assert.equal(await one(`select count(*)::int as v from ${table} where company_id=$1`, [b.companyId]), 0);
    await h.asUser(users.otherOwner);
    assert.equal(await one(`select count(*)::int as v from ${table}`), 1);
  });

  await t.test('a read-only member reads the history but its correction is refused and writes nothing', async () => {
    assert.equal((await history(users.viewer, first)).length, 2);
    await assert.rejects(review(a, users.viewer, first, 'rejected'), code('42501'));
    assert.equal((await history(null, first)).length, 2);
  });

  await t.test('no direct insert, update or delete for API roles; the guard refuses changes even for the owner role', async () => {
    const row = (await history(null, first))[0];
    for (const actor of [users.owner, users.recruiter, users.viewer]) {
      await h.asUser(actor);
      await assert.rejects(db.query(`insert into ${table}(company_id,analysis_id,criterion_result_id,review_version,actor_id,previous_status,new_status)
        values($1,$2,$3,1,$4,'unreviewed','accepted')`, [a.companyId, a.analysis_id, first, actor]), code('42501'), actor);
      await assert.rejects(db.query(`update ${table} set new_note='x' where id=$1`, [row.id]), code('42501'), actor);
      await assert.rejects(db.query(`delete from ${table} where id=$1`, [row.id]), code('42501'), actor);
    }
    await h.asUser(null, 'anon');
    await assert.rejects(db.query(`select * from ${table}`), code('42501'));
    // Even the table owner cannot rewrite or remove history outside the erasure purge.
    await h.asAdmin();
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [users.owner]);
    await assert.rejects(db.query(`update ${table} set new_note='x' where id=$1`, [row.id]), code('42501'));
    await assert.rejects(db.query(`delete from ${table} where id=$1`, [row.id]), code('42501'));
    await h.asAdmin();
    await assert.rejects(db.query(`truncate ${table}`), code('42501'));
    assert.equal((await history(null, first)).length, 2);
  });

  await t.test('the candidate erasure lists and removes the history; the other company keeps its own', async () => {
    await h.asAdmin();
    const listed = (await db.query('select adapter,row_key from private.erasure_inventory_rows($1,$2)', [a.companyId, [a.candidate.id]])).rows
      .filter(r => r.adapter === table).map(r => r.row_key).sort();
    const ids = (await db.query(`select id::text from ${table} where company_id=$1 order by id`, [a.companyId])).rows.map(r => r.id).sort();
    assert.equal(ids.length, 3);
    assert.deepEqual(listed, ids);
    const life = lifecycleHarness(h);
    await h.asUser(a.owner);
    await life.policy(a, 0, lifecycleRules);
    a.resolutionId = await life.resolve(a, [a.candidate.id]);
    await x.configure();
    await h.asUser(a.owner);
    const preview = (await db.query("select public.preview_candidate_erasure($1,'confirmed_subject',$2) as v", [a.candidate.id, a.resolutionId])).rows[0].v;
    assert.equal(preview.counts[table], 3);
    assert.ok(!preview.blockers.includes('schema_dependency_unknown'));
    const frozen = await life.freeze(a);
    // Frozen: the history is hidden from members like the rest of the candidate's data.
    assert.equal((await history(users.owner, first)).length, 0);
    await h.asUser(a.owner);
    await x.transition(frozen.request_id, 0, 'authorized');
    await x.transition(frozen.request_id, 1, 'erasing');
    await x.purge(frozen.request_id, 2);
    await h.asAdmin();
    assert.equal(await one(`select count(*)::int as v from ${table} where company_id=$1`, [a.companyId]), 0);
    assert.equal(await one('select count(*)::int as v from public.screening_criterion_results where analysis_id=$1', [a.analysis_id]), 0);
    assert.equal(await one('select count(*)::int as v from public.candidates where id=$1', [a.candidate.id]), 0);
    assert.equal(await one(`select count(*)::int as v from ${table} where company_id=$1`, [b.companyId]), 1);
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
  });

  await t.test('operational rollback stops new history rows and keeps table, rows and inventory', async () => {
    await h.asAdmin();
    await db.query(await readFile(new URL(`../supabase/rollbacks/${migration.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8'));
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
    assert.equal(await one(`select count(*)::int as v from ${table}`), 1);
    assert.equal(await one('select has_table_privilege($1,$2,$3) as v', ['authenticated', table, 'select']), false);
    await review(b, users.otherOwner, b.criteria[1].id, 'accepted');
    await h.asAdmin();
    assert.equal(await one(`select count(*)::int as v from ${table}`), 1, 'the restored RPC writes no history');
    assert.equal(await one('select human_status as v from public.screening_criterion_results where id=$1', [b.criteria[1].id]), 'accepted');
  });
});
