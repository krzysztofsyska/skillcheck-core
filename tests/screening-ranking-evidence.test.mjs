import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { applyMigration, bootMigrationDatabase, installSource, paymentUsers, seedSyntheticPolicy } from './helpers/sc19-migration-fixture.mjs';

// Real checked-in migrations on disposable native PostgreSQL (CI: PG 16/17).
const chain = [
  '20261026220100_sc_step3_evidence_extensions.sql', '20261026220200_sc_step3_evidence_worker.sql',
  '20261028120000_sc_step3_erasure_inventory_r7.sql', '20261029100000_sc019_operator_fulfillment.sql',
  '20261030120000_sc_step3_matrix_change_invalidates_approval.sql', '20261030160000_sc_step4_interview_decision.sql',
  '20261030160100_sc_step4_erasure_inventory_r8.sql', '20261101120000_company_creation_limit.sql',
  '20261101130000_cv_bulk_intake.sql', '20261101130100_cv_bulk_erasure_inventory_r9.sql',
];
const fix = '20261101140000_screening_ranking_evidence_verdicts.sql';
const migration = name => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const rollback = name => readFile(new URL(`../supabase/rollbacks/${name}`, import.meta.url), 'utf8');
async function run(db, sql) { try { await db.query(sql); } catch (error) { await db.query('rollback'); throw error; } }

test('report ranking ranks recruiter-reviewed evidence-matrix (v2) analyses', async t => {
  const env = await installSource(await bootMigrationDatabase(t), 'r4_legacy');
  await applyMigration(env.db);
  for (const name of [...chain, fix]) await run(env.db, await migration(name));
  await seedSyntheticPolicy(env.db);
  const { db, h } = env;

  // Five-criterion position; one application per verdict plan.
  const first = await h.seed(paymentUsers.owner);
  await h.asAdmin();
  await db.query('select private.sc19_grant_paid($1,$2)', [first.companyId, `synthetic-rank-${first.companyId}`]);
  const plans = {
    strong: ['supported', 'supported', 'supported', 'partial', 'missing'],   // 100+100+100+50+0 = 70
    weak: ['missing', 'missing', 'partial', 'contradicted', 'missing'],       // 10
    edited: ['supported', 'missing', 'missing', 'missing', 'missing'],        // reviewer edits row 2 to supported, rejects row 5
  };
  const apps = {};
  for (const [key, plan] of Object.entries(plans)) {
    const f = key === 'strong' ? first : await h.candidate(first, key);
    await h.asAdmin();
    const fingerprint = (await db.query("select private.screening_material($1,false)->>'input_fingerprint' v", [f.application.id])).rows[0].v;
    await h.asUser(f.owner);
    const started = (await db.query("select * from public.start_screening_analysis($1,$2,1,2,'screening-evidence-v2','openai','m',null,$3,false)",
      [f.application.id, fingerprint, randomUUID()])).rows[0];
    await h.asWorker();
    const claimed = (await db.query('select * from public.claim_screening_attempt_v2($1)', [started.attempt_id])).rows[0];
    const rows = claimed.criteria_snapshot.map((c, i) => {
      const cited = plan[i] !== 'missing';
      return { criterion_id: c.id, verdict: plan[i], evidence: cited ? [{ start: 0, end: 3, quote: 'SQL', document_id: claimed.candidate_document_id }] : [],
        missing_info: cited ? '' : 'Brak', suggested_question: '', explanation: 'Synthetic.' };
    });
    await db.query('select public.complete_screening_evidence($1,$2,$3,$4,$5::jsonb)', [started.attempt_id, claimed.lease_token, claimed.input_fingerprint, claimed.analysis_contract_hash, JSON.stringify(rows)]);
    apps[key] = { f, analysis: started.analysis_id };
  }
  const ranking = async () => { await h.asUser(first.owner); return (await db.query('select * from public.get_screening_ranking($1)', [first.recruitment.id])).rows; };
  const reviewAll = async (key, edits = {}) => {
    const { f, analysis } = apps[key];
    await h.asAdmin();
    const criteria = (await db.query('select id, criterion_order, updated_at from public.screening_criterion_results where analysis_id=$1 order by criterion_order', [analysis])).rows;
    await h.asUser(f.owner);
    for (const [i, c] of criteria.entries()) {
      const edit = edits[i];
      const status = edit?.status ?? 'accepted';
      const evidence = edit?.verdict && edit.verdict !== 'missing' ? JSON.stringify([{ start: 0, end: 3, quote: 'SQL' }]) : (edit?.verdict === 'missing' ? '[]' : null);
      await db.query('select public.review_screening_evidence_row($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)', [f.companyId, analysis, c.id, c.updated_at,
        status, null, status === 'edited' ? edit.verdict : null, status === 'edited' ? '' : null, status === 'edited' ? '' : null, status === 'edited' ? evidence : null]);
    }
    const version = (await db.query('select latest_review_version v from public.screening_analysis_versions where id=$1', [analysis])).rows[0].v;
    await db.query("select public.review_screening_result($1,$2,'approved',null,'[]'::jsonb)", [analysis, version]);
  };

  await t.test('before human review nothing is ranked (unchanged rule)', async () => {
    for (const row of await ranking()) assert.equal(row.eligibility_reason, 'no_human_review');
  });

  await t.test('after review: verdict points, coverage and order', async () => {
    await reviewAll('strong');
    await reviewAll('weak');
    // Reviewer edits row 2 (index 1) to supported and rejects row 5 (index 4).
    await reviewAll('edited', { 1: { status: 'edited', verdict: 'supported' }, 4: { status: 'rejected' } });
    const rows = await ranking();
    const by = Object.fromEntries(Object.entries(apps).map(([k, v]) => [k, rows.find(r => r.application_id === v.f.application.id)]));
    assert.deepEqual([by.strong.eligibility_reason, Number(by.strong.raw_score), Number(by.strong.coverage), by.strong.rank], ['eligible', 70, 1, 1]);
    assert.deepEqual([by.weak.eligibility_reason, Number(by.weak.raw_score), Number(by.weak.coverage), by.weak.rank], ['eligible', 10, 1, 3]);
    // edited: supported, supported (edited), missing, missing, rejected -> (100+100+0+0)/4 = 50, coverage 4/5
    assert.deepEqual([by.edited.eligibility_reason, Number(by.edited.raw_score), Number(by.edited.coverage)], ['eligible', 50, 0.8]);
    assert.equal(by.edited.insufficient_data_count, 1, 'a rejected row is unknown, not zero');
    // Order by score: strong 70 > edited 50 > weak 10.
    assert.deepEqual(rows.filter(r => r.rankable).sort((a, b) => a.rank - b.rank).map(r => r.application_id),
      [apps.strong.f.application.id, apps.edited.f.application.id, apps.weak.f.application.id]);
    assert.equal(rows.filter(r => r.suggested_shortlist).length, 3);
  });

  await t.test('a suggested candidate can be shortlisted with the snapshot', async () => {
    const row = (await ranking()).find(r => r.application_id === apps.strong.f.application.id);
    await h.asUser(first.owner);
    const id = (await db.query('select public.add_recruitment_shortlist_entry($1,$2,$3,$4,$5,null,null) id',
      [row.application_id, 'suggested', row.analysis_id, row.review_id, row.ranking_policy_version])).rows[0].id;
    const entry = (await db.query('select * from public.get_recruitment_shortlist($1)', [first.recruitment.id])).rows.find(e => e.entry_id === id);
    assert.deepEqual([Number(entry.raw_score_snapshot), entry.snapshot_current], [70, true]);
  });

  await t.test('rollback restores the rating-only body; forward again', async () => {
    await h.asAdmin();
    await run(db, await rollback('20261101140000_screening_ranking_evidence_verdicts_down.sql'));
    const after = (await ranking()).find(r => r.application_id === apps.weak.f.application.id);
    assert.equal(after.eligibility_reason, 'insufficient_evidence');
    await h.asAdmin();
    await run(db, await migration(fix));
  });
});
