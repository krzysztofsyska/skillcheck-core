import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootMigrationDatabase, seedSyntheticPolicy } from './helpers/sc19-migration-fixture.mjs';
import { setupRankingDatabase } from './helpers/screening-ranking-fixture.mjs';

// Step 3 v2 worker RPCs on the complete checked-in chain (M13 -> Step 3 -> R7), real PostgreSQL.
const v2 = { promptVersion: 'screening-evidence-v2', resultSchema: 2 };

async function startedV2(t) {
  const env = await bootMigrationDatabase(t);
  await setupRankingDatabase(env.db, { throughMigration: null });
  await seedSyntheticPolicy(env.db);
  const { db, h } = env;
  const f = await h.seed(); await h.asAdmin();
  await db.query('select private.sc19_grant_paid($1,$2)', [f.companyId, `synthetic-step3-${f.companyId}`]);
  const fingerprint = (await db.query("select private.screening_material($1,false)->>'input_fingerprint' as value", [f.application.id])).rows[0].value;
  await h.asUser(f.owner);
  const started = (await db.query(
    "select * from public.start_screening_analysis($1,$2,1,$3,$4,'openai','ranking-test-model',null,$5,false)",
    [f.application.id, fingerprint, v2.resultSchema, v2.promptVersion, randomUUID()])).rows[0];
  return { env, db, h, f, started };
}

const claimV2 = async (h, db, started) => {
  await h.asWorker();
  return (await db.query('select * from public.claim_screening_attempt_v2($1)', [started.attempt_id])).rows[0];
};

const findings = (claimed, overrides = {}) => claimed.criteria_snapshot.map((criterion, i) => ({
  criterion_id: criterion.id,
  verdict: i === 0 ? 'supported' : 'missing',
  evidence: i === 0 ? [{ start: 0, end: 3, quote: 'SQL', document_id: claimed.candidate_document_id }] : [],
  missing_info: i === 0 ? '' : 'Synthetic missing detail',
  suggested_question: i === 0 ? '' : 'Synthetic question?',
  explanation: 'Synthetic fixture.',
  ...(overrides[i] ?? {}),
}));

const completeV2 = async (h, db, started, claimed, rows) => {
  await h.asWorker();
  return (await db.query('select public.complete_screening_evidence($1,$2,$3,$4,$5::jsonb) as id',
    [started.attempt_id, claimed.lease_token, claimed.input_fingerprint, claimed.analysis_contract_hash, JSON.stringify(rows)])).rows[0].id;
};

const storedRows = async (h, db, analysisId) => {
  await h.asAdmin();
  return (await db.query(`select criterion_id, verdict, missing_info, suggested_question, human_status, updated_at
    from public.screening_criterion_results where analysis_id=$1 order by criterion_id`, [analysisId])).rows;
};

test('Step 3 v2: a missing or null verdict is rejected before completion', async t => {
  const { db, h, started } = await startedV2(t);
  const claimed = await claimV2(h, db, started);
  assert.ok(claimed.candidate_document_id, 'v2 claim returns the source document');
  for (const verdict of [undefined, null]) {
    const rows = findings(claimed, { 0: { verdict } });
    if (verdict === undefined) delete rows[0].verdict;
    await assert.rejects(completeV2(h, db, started, claimed, rows), error => error.code === '22023');
  }
  await h.asAdmin();
  const attempt = (await db.query('select status from public.screening_analysis_attempts where id=$1', [started.attempt_id])).rows[0];
  assert.equal(attempt.status, 'processing', 'A malformed result never completes the attempt');
});

test('Step 3 v2: an identical replay rewrites nothing and a different replay is a conflict', async t => {
  const { db, h, f, started } = await startedV2(t);
  const claimed = await claimV2(h, db, started);
  const rows = findings(claimed);
  const analysisId = await completeV2(h, db, started, claimed, rows);
  const first = await storedRows(h, db, analysisId);
  assert.deepEqual(first.map(r => r.verdict).sort(), rows.map(r => r.verdict).sort());

  // A reviewer accepts the first row; an identical worker replay must not touch it.
  await h.asUser(f.owner);
  const target = (await db.query(`select id, updated_at from public.screening_criterion_results
    where analysis_id=$1 and criterion_id=$2`, [analysisId, rows[0].criterion_id])).rows[0];
  await db.query('select public.review_screening_evidence_row($1,$2,$3,$4,$5)',
    [f.companyId, analysisId, target.id, target.updated_at, 'accepted']);
  const reviewed = await storedRows(h, db, analysisId);

  assert.equal(await completeV2(h, db, started, claimed, rows), analysisId);
  assert.deepEqual(await storedRows(h, db, analysisId), reviewed, 'Identical replay is a no-op');

  for (const change of [{ 0: { verdict: 'partial' } }, { 1: { missing_info: 'Different detail' } }, { 1: { suggested_question: 'Different question?' } }]) {
    await assert.rejects(completeV2(h, db, started, claimed, findings(claimed, change)), error => error.code === 'PT409');
    assert.deepEqual(await storedRows(h, db, analysisId), reviewed, 'Conflicting replay keeps the stored result');
  }
});

test('Step 3 v2: claim waits behind an analysis lock instead of deadlocking with stale cancellation', async t => {
  const { env, db, h, started } = await startedV2(t);
  const other = await env.connect();
  // Same order as sc19_reconcile_analysis: the analysis row first, then its attempts.
  await other.query('begin');
  await other.query('select 1 from public.screening_analysis_versions where id=$1 for update', [started.analysis_id]);
  const claimPid = (await db.query('select pg_backend_pid() pid')).rows[0].pid;
  const claim = claimV2(h, db, started);
  for (let i = 0; i < 100; i++) {
    const waiting = (await other.query("select wait_event_type from pg_stat_activity where pid=$1", [claimPid])).rows[0]?.wait_event_type;
    if (waiting === 'Lock') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await other.query('select 1 from public.screening_analysis_attempts where id=$1 for update', [started.attempt_id]);
  await other.query('commit');
  const claimed = await claim;
  assert.equal(claimed.attempt_id, started.attempt_id, 'Claim succeeds after the concurrent transaction commits');
});
