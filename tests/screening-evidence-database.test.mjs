import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { prepareScreening, screeningAnalysisContractHash } from '../lib/screening.ts';
import { screeningEvidenceAiContract } from '../lib/screening-ai.ts';
import { runScreeningAttempt } from '../lib/screening-worker.ts';

const migrations = [
  '20260930000100_skillcheck_core.sql',
  '20261001000100_idempotent_onboarding.sql',
  '20261001000200_candidate_documents.sql',
  '20261002000100_behavior_assessments.sql',
  '20261002000200_behavior_conflict_response.sql',
  '20261002000300_exercise_definitions.sql',
  '20261004000100_exercise_observations.sql',
  '20261004000200_screening_results.sql',
  '20261005000100_screening_worker_claim_payload.sql',
  '20261007000100_screening_retry_active_conflict.sql',
  '20261009080000_screening_latest_mutations.sql',
  '20261026220100_sc_step3_evidence_extensions.sql',
  '20261026220200_sc_step3_evidence_worker.sql',
];
const ownerA = '10000000-0000-0000-0000-000000000001';
const ownerB = '10000000-0000-0000-0000-000000000002';
const viewer = '10000000-0000-0000-0000-000000000003';

test('Step 3 end-to-end with mocked OpenAI, tenant RLS and human review', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  for (const file of migrations) await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
  for (const id of [ownerA, ownerB, viewer]) await db.query('insert into auth.users values($1)', [id]);
  const asUser = async id => {
    await db.exec('reset role; set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  };
  const asWorker = async () => db.exec('reset role; set role screening_worker');
  const asAdmin = async () => {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub','',false)");
  };
  const insert = async (table, row) => {
    const fields = Object.keys(row);
    const values = Object.values(row);
    const result = await db.query(
      `insert into public.${table}(${fields.join(',')}) values(${fields.map((_,i)=>'$'+(i+1)).join(',')}) returning *`,
      values,
    );
    return result.rows[0];
  };
  const seed = async (owner, label) => {
    await asUser(owner);
    const companyId = (await db.query('select public.create_company($1) as id', ['Company '+label])).rows[0].id;
    const position = await insert('positions', {
      company_id: companyId, title: 'Analityk '+label, tasks: ['Analiza danych'],
      kpis: ['Terminowość'], required_competencies: ['SQL'], status: 'active',
    });
    const recruitment = await insert('recruitments', { company_id: companyId, position_id: position.id, name: 'Recruitment '+label, status: 'open' });
    const candidate = await insert('candidates', { company_id: companyId, first_name: 'Test', last_name: label });
    const application = await insert('applications', { company_id: companyId, recruitment_id: recruitment.id, candidate_id: candidate.id });
    const document = await insert('candidate_documents', {
      company_id: companyId, candidate_id: candidate.id,
      source_text: 'Private original', redacted_text: 'A😀B𝄞C SQL  i raporty.',
    });
    await db.query('select public.review_candidate_document($1,$2)', [document.id, document.version]);
    return { companyId, position, recruitment, candidate, application, document };
  };
  const a = await seed(ownerA, 'A');
  const b = await seed(ownerB, 'B');
  await asUser(ownerA);
  await insert('company_members', { company_id: a.companyId, user_id: viewer, role: 'viewer' });
  // Same fingerprint logic used in the application, including pg timestamp serialization.
  const latest = async (table, id) => {
    const record = (await db.query(`select * from public.${table} where id=$1`, [id])).rows[0];
    record.updated_at = (await db.query(`select to_jsonb(updated_at)#>>'{}' as value from public.${table} where id=$1`, [id])).rows[0].value;
    return record;
  };
  const reviewed = (await db.query(
    'select * from public.candidate_documents where id=$1', [a.document.id],
  )).rows[0];
  const prepared = prepareScreening({
    companyId: a.companyId, application: await latest('applications', a.application.id),
    recruitment: await latest('recruitments', a.recruitment.id),
    position: await latest('positions', a.position.id), document: reviewed,
  });
  const contract = screeningEvidenceAiContract;
  await asUser(ownerA);
  const started = (await db.query(
    'select * from public.start_screening_analysis($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [a.application.id, prepared.fingerprint, contract.payload_schema_version,
      contract.result_schema_version, contract.prompt_version, contract.provider,
      contract.model, contract.model_revision, randomUUID(), false],
  )).rows[0];
  const mocked = {
    status: 'completed', id: 'resp_mock_step3',
    output_text: JSON.stringify({ criteria: prepared.payload.criteria.map((criterion, i) => ({
      criterion_id: criterion.id, verdict: i === 0 ? 'supported' : 'partial',
      evidence_quotes: i === 0 ? ['SQL i raporty'] : ['nieprawdziwe doświadczenie'],
      missing_info: 'Potrzebny szczegół', suggested_question: 'Podaj przykład.',
      explanation: 'Źródło: sprawdzone CV.',
    })) }),
  };
  let dispatched = 0;
  const diagnostic = [];
  const result = await runScreeningAttempt(started.attempt_id, {
    enabled: true,
    store: {
      async claim(id) {
        await asWorker();
        return (await db.query('select * from public.claim_screening_attempt_v2($1)', [id])).rows[0];
      },
      async complete(input) {
        await asWorker();
        try {
          return (await db.query('select public.complete_screening_evidence($1,$2,$3,$4,$5::jsonb) as id',
            [input.attemptId, input.leaseToken, input.inputFingerprint,
              input.analysisContractHash, JSON.stringify(input.findings)])).rows[0].id;
        } catch (error) { diagnostic.push({ phase: 'complete', code: error.code, message: error.message }); throw error; }
      },
      async fail(input) {
        diagnostic.push({ phase: 'fail', code: input.errorCode, reason: input.errorMessage });
        await asWorker();
        return (await db.query('select public.fail_screening_attempt($1,$2,$3,$4,$5,$6) as id',
          [input.attemptId, input.leaseToken, input.inputFingerprint, input.analysisContractHash,
            input.errorCode, input.errorMessage])).rows[0].id;
      },
    },
    callOpenAi: async request => { dispatched++; assert.equal(request.text.format.name, 'screening_evidence_v2'); return mocked; },
    sleep: async () => {}, log: () => {},
  });
  assert.equal(result.status, 'completed', JSON.stringify({ result, diagnostic }));
  assert.equal(dispatched, 1);
  await asUser(ownerA);
  const readA = await db.query('select * from public.screening_criterion_results where company_id=$1 and analysis_id=$2 order by criterion_order',
    [a.companyId, started.analysis_id]);
  assert.equal(readA.rows.length, 3);
  assert.equal(readA.rows[0].verdict, 'supported');
  assert.equal(readA.rows[0].evidence[0].quote, 'SQL  i raporty');
  assert.equal(readA.rows[1].verdict, 'missing');
  assert.equal(readA.rows[1].evidence.length, 0);
  const rowId = readA.rows[0].id;
  await asUser(ownerB);
  assert.equal((await db.query('select * from public.screening_criterion_results where id=$1', [rowId])).rows.length, 0);
  await assert.rejects(
    db.query('select public.review_screening_evidence_row($1,$2,$3,null,$4)',
      [a.companyId, started.analysis_id, rowId, 'rejected']),
    error => error.code === '42501',
  );
  await asUser(viewer);
  assert.equal((await db.query('select * from public.screening_criterion_results where id=$1', [rowId])).rows.length, 1);
  await assert.rejects(
    db.query('select public.review_screening_evidence_row($1,$2,$3,null,$4)',
      [a.companyId, started.analysis_id, rowId, 'accepted']),
    error => error.code === '42501',
  );
  await asUser(ownerA);
  assert.equal((await db.query(
    'select public.review_screening_evidence_row($1,$2,$3,null,$4) as id',
    [a.companyId, started.analysis_id, rowId, 'accepted'],
  )).rows[0].id, rowId);
  const updated = (await db.query('select human_status,updated_by from public.screening_criterion_results where id=$1',
    [rowId])).rows[0];
  assert.equal(updated.human_status, 'accepted');
  assert.equal(updated.updated_by, ownerA);
  await asUser(ownerB);
  assert.equal((await db.query('select count(*)::int as count from public.screening_criterion_results where company_id=$1',
    [b.companyId])).rows[0].count, 0);
  await asAdmin();
});
