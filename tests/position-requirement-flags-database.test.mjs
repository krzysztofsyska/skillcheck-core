// SC-015 / #268 — oznaczenia wymagań w bazie.
// Sprawdza to, co w tej zmianie jest najłatwiejsze do zepsucia:
//  1. firma B nie widzi i nie zapisze oznaczeń firmy A;
//  2. samo oznaczenie NIE unieważnia analizy CV i nie kasuje korekt rekrutera;
//  3. oznaczenie nie przykleja się do innego wymagania po zmianie treści profilu.
// Dane kandydatów są fikcyjne; żadnego prawdziwego CV ani nazwiska.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { prepareScreening } from '../lib/screening.ts';
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
  '20261104120000_position_requirement_flags.sql',
];
const ownerA = '20000000-0000-0000-0000-000000000001';
const ownerB = '20000000-0000-0000-0000-000000000002';
const viewer = '20000000-0000-0000-0000-000000000003';

test('oznaczenia wymagań: izolacja firm, brak unieważnienia analizy, brak przeklejenia etykiety', async t => {
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
    const result = await db.query(
      `insert into public.${table}(${fields.join(',')}) values(${fields.map((_, i) => '$' + (i + 1)).join(',')}) returning *`,
      Object.values(row),
    );
    return result.rows[0];
  };
  const seed = async (owner, label) => {
    await asUser(owner);
    const companyId = (await db.query('select public.create_company($1) as id', ['Firma ' + label])).rows[0].id;
    const position = await insert('positions', {
      company_id: companyId, title: 'Kurier ' + label,
      tasks: ['Dostarczanie przesyłek'], kpis: ['Terminowość dostaw'],
      required_competencies: ['Prawo jazdy kategorii B'], status: 'active',
    });
    const recruitment = await insert('recruitments', { company_id: companyId, position_id: position.id, name: 'Rekrutacja ' + label, status: 'open' });
    const candidate = await insert('candidates', { company_id: companyId, first_name: 'Kandydat', last_name: label });
    const application = await insert('applications', { company_id: companyId, recruitment_id: recruitment.id, candidate_id: candidate.id });
    const document = await insert('candidate_documents', {
      company_id: companyId, candidate_id: candidate.id,
      source_text: 'Oryginał fikcyjny', redacted_text: 'Dostarczanie przesyłek i terminowość dostaw.',
    });
    await db.query('select public.review_candidate_document($1,$2)', [document.id, document.version]);
    return { companyId, position, recruitment, candidate, application, document };
  };
  const a = await seed(ownerA, 'A');
  const b = await seed(ownerB, 'B');
  await asUser(ownerA);
  await insert('company_members', { company_id: a.companyId, user_id: viewer, role: 'viewer' });

  // --- pełna analiza z macierzą dowodów, żeby było co unieważnić i co korygować ---
  const latest = async (table, id) => {
    const record = (await db.query(`select * from public.${table} where id=$1`, [id])).rows[0];
    record.updated_at = (await db.query(`select to_jsonb(updated_at)#>>'{}' as value from public.${table} where id=$1`, [id])).rows[0].value;
    return record;
  };
  const reviewedDocument = (await db.query('select * from public.candidate_documents where id=$1', [a.document.id])).rows[0];
  const prepared = prepareScreening({
    companyId: a.companyId, application: await latest('applications', a.application.id),
    recruitment: await latest('recruitments', a.recruitment.id),
    position: await latest('positions', a.position.id), document: reviewedDocument,
  });
  const contract = screeningEvidenceAiContract;
  const started = (await db.query(
    'select * from public.start_screening_analysis($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [a.application.id, prepared.fingerprint, contract.payload_schema_version,
      contract.result_schema_version, contract.prompt_version, contract.provider,
      contract.model, contract.model_revision, randomUUID(), false],
  )).rows[0];
  // Wymagane prawo jazdy (competency:1) nie jest wspomniane w CV: verdict 'missing'.
  const mocked = {
    status: 'completed', id: 'resp_mock_flags',
    output_text: JSON.stringify({
      criteria: prepared.payload.criteria.map(criterion => criterion.id === 'competency:1'
        ? { criterion_id: criterion.id, verdict: 'missing', evidence_quotes: [],
            missing_info: 'CV nie wspomina o prawie jazdy.',
            suggested_question: 'Czy posiadasz prawo jazdy kategorii B?',
            explanation: 'Źródło: sprawdzone CV.' }
        : { criterion_id: criterion.id, verdict: 'supported',
            evidence_quotes: [criterion.id === 'task:1' ? 'Dostarczanie przesyłek' : 'terminowość dostaw'],
            missing_info: 'Brak szczegółów.', suggested_question: 'Podaj przykład.',
            explanation: 'Źródło: sprawdzone CV.' }),
    }),
  };
  const result = await runScreeningAttempt(started.attempt_id, {
    enabled: true,
    store: {
      async claim(id) { await asWorker(); return (await db.query('select * from public.claim_screening_attempt_v2($1)', [id])).rows[0]; },
      async complete(input) {
        await asWorker();
        return (await db.query('select public.complete_screening_evidence($1,$2,$3,$4,$5::jsonb) as id',
          [input.attemptId, input.leaseToken, input.inputFingerprint, input.analysisContractHash,
            JSON.stringify(input.findings)])).rows[0].id;
      },
      async fail(input) {
        await asWorker();
        return (await db.query('select public.fail_screening_attempt($1,$2,$3,$4,$5,$6) as id',
          [input.attemptId, input.leaseToken, input.inputFingerprint, input.analysisContractHash,
            input.errorCode, input.errorMessage])).rows[0].id;
      },
    },
    callOpenAi: async () => mocked, sleep: async () => {}, log: () => {},
  });
  assert.equal(result.status, 'completed');

  await asUser(ownerA);
  const rows = (await db.query(
    'select * from public.screening_criterion_results where company_id=$1 and analysis_id=$2 order by criterion_order',
    [a.companyId, started.analysis_id])).rows;
  const licence = rows.find(row => row.criterion_id === 'competency:1');
  assert.equal(licence.verdict, 'missing', 'wymagane prawo jazdy bez wzmianki w CV to brak informacji');
  assert.equal(licence.evidence.length, 0);

  // Korekta rekrutera na jednym wierszu — ma przeżyć późniejsze oznaczanie wymagań.
  await db.query('select public.review_screening_evidence_row($1,$2,$3,$4,$5,$6)',
    [a.companyId, started.analysis_id, licence.id, licence.updated_at, 'edited', 'Kandydat potwierdził w rozmowie telefonicznej.']);
  const corrected = (await db.query('select * from public.screening_criterion_results where id=$1', [licence.id])).rows[0];
  assert.equal(corrected.human_status, 'edited');

  const positionState = async () => (await db.query(
    "select to_jsonb(updated_at)#>>'{}' as updated_at from public.positions where id=$1", [a.position.id])).rows[0].updated_at;
  const analysisState = async () => (await db.query(
    'select stale_at, stale_reason, input_fingerprint from public.screening_analysis_versions where id=$1',
    [started.analysis_id])).rows[0];
  const positionBefore = await positionState();
  const analysisBefore = await analysisState();
  assert.equal(analysisBefore.stale_at, null, 'analiza przed oznaczaniem jest aktualna');

  // --- 1. oznaczanie ---
  assert.equal((await db.query('select public.set_position_requirement_flag($1,$2,$3,$4,$5) as flag',
    [a.companyId, a.position.id, 'competency:1', 'Prawo jazdy kategorii B', 'required'])).rows[0].flag, 'required');
  assert.equal((await db.query('select public.set_position_requirement_flag($1,$2,$3,$4,$5) as flag',
    [a.companyId, a.position.id, 'kpi:1', 'Terminowość dostaw', 'additional'])).rows[0].flag, 'additional');

  const flags = (await db.query('select * from public.position_requirement_flags($1,$2)', [a.companyId, a.position.id])).rows;
  assert.deepEqual(flags.map(row => [row.criterion_id, row.flag]).sort(),
    [['competency:1', 'required'], ['kpi:1', 'additional']].sort());
  // task:1 nie ma wiersza — to jest trzeci stan „nieoznaczone", a nie „konieczne".
  assert.equal(flags.some(row => row.criterion_id === 'task:1'), false);

  // --- 2. oznaczenie nie unieważnia analizy i nie kasuje korekty ---
  assert.equal(await positionState(), positionBefore, 'oznaczenie nie dotyka profilu stanowiska');
  const analysisAfter = await analysisState();
  assert.equal(analysisAfter.stale_at, null, 'oznaczenie nie unieważnia analizy');
  assert.equal(analysisAfter.stale_reason, null);
  assert.equal(analysisAfter.input_fingerprint, analysisBefore.input_fingerprint, 'oznaczenie nie zmienia materiału analizy');
  const afterFlagging = (await db.query('select human_status,human_note from public.screening_criterion_results where id=$1', [licence.id])).rows[0];
  assert.equal(afterFlagging.human_status, 'edited', 'korekta rekrutera przeżywa oznaczanie');
  assert.equal(afterFlagging.human_note, 'Kandydat potwierdził w rozmowie telefonicznej.');

  // Kontrola negatywna: prawdziwa zmiana profilu NADAL unieważnia analizę.
  // Bez tego asercje powyżej nie dowodziłyby niczego.
  await db.query("update public.positions set description='Zmiana profilu' where id=$1", [a.position.id]);
  const invalidated = await analysisState();
  assert.notEqual(invalidated.stale_at, null, 'zmiana profilu stanowiska unieważnia analizę');
  assert.equal(invalidated.stale_reason, 'position_changed');

  // --- 3. brak przeklejenia etykiety po zmianie treści wymagania ---
  await db.query("update public.positions set required_competencies=array['Prawo jazdy kategorii C'] where id=$1", [a.position.id]);
  await assert.rejects(
    db.query('select public.set_position_requirement_flag($1,$2,$3,$4,$5)',
      [a.companyId, a.position.id, 'competency:1', 'Prawo jazdy kategorii B', 'required']),
    error => error.code === 'PT409',
    'zapis ze starym tekstem wymagania jest odrzucany');
  await assert.rejects(
    db.query('select public.set_position_requirement_flag($1,$2,$3,$4,$5)',
      [a.companyId, a.position.id, 'competency:9', 'Cokolwiek', 'required']),
    error => error.code === 'PT409',
    'wymaganie poza listą jest odrzucane');
  await assert.rejects(
    db.query('select public.set_position_requirement_flag($1,$2,$3,$4,$5)',
      [a.companyId, a.position.id, 'task:1', 'Dostarczanie przesyłek', 'byle co']),
    error => error.code === '22023');

  // Kasowanie oznaczenia wraca do „nieoznaczone".
  assert.equal((await db.query('select public.set_position_requirement_flag($1,$2,$3,$4,$5) as flag',
    [a.companyId, a.position.id, 'kpi:1', 'Terminowość dostaw', null])).rows[0].flag, 'unmarked');
  assert.equal((await db.query('select * from public.position_requirement_flags($1,$2)', [a.companyId, a.position.id]))
    .rows.some(row => row.criterion_id === 'kpi:1'), false);

  // --- izolacja firm ---
  await asUser(ownerB);
  await assert.rejects(
    db.query('select * from public.position_requirement_flags($1,$2)', [a.companyId, a.position.id]),
    error => error.code === '42501', 'firma B nie czyta oznaczeń firmy A');
  await assert.rejects(
    db.query('select public.set_position_requirement_flag($1,$2,$3,$4,$5)',
      [a.companyId, a.position.id, 'task:1', 'Dostarczanie przesyłek', 'required']),
    error => error.code === '42501', 'firma B nie zapisze oznaczeń firmy A');
  // Identyfikator stanowiska firmy A pod własnym company_id też nie przechodzi.
  await assert.rejects(
    db.query('select * from public.position_requirement_flags($1,$2)', [b.companyId, a.position.id]),
    error => error.code === '42501');
  assert.equal((await db.query('select * from public.position_requirement_flags($1,$2)', [b.companyId, b.position.id])).rows.length, 0);

  // Czytelnik bez prawa zapisu: widzi oznaczenia, nie zmienia ich.
  await asUser(viewer);
  assert.equal((await db.query('select * from public.position_requirement_flags($1,$2)', [a.companyId, a.position.id])).rows.length, 1);
  await assert.rejects(
    db.query('select public.set_position_requirement_flag($1,$2,$3,$4,$5)',
      [a.companyId, a.position.id, 'task:1', 'Dostarczanie przesyłek', 'required']),
    error => error.code === '42501');

  // Tabela nie jest dostępna bezpośrednio dla ról aplikacji — tylko przez funkcje.
  await asUser(ownerA);
  await assert.rejects(db.query('select * from requirements.position_flags'), error => error.code === '42501' || error.code === '3F000');
  await asAdmin();
});
