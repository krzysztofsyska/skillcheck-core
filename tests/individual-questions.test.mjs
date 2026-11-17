// ROADMAP R1 / SC-014-C6 — pytania indywidualne z luk w CV, widok tylko do odczytu.
// Dane są fikcyjne; żadnego prawdziwego CV ani nazwiska.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  individualQuestionsForCandidate, loadShortlistIndividualQuestions, loadCandidateIndividualQuestions,
  INDIVIDUAL_QUESTIONS_MAX_CANDIDATES,
} from '../lib/individual-questions.ts';
import { EXERCISE_AI_MAX_INDIVIDUAL_QUESTIONS } from '../lib/exercise-ai.ts';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FP = 'a'.repeat(64);
const entry = (extra = {}) => ({ application_id: uuid(3), analysis_id: uuid(10), review_id: uuid(20), removed_at: null, ...extra });
const analysis = (extra = {}) => ({
  id: uuid(10), application_id: uuid(3), execution_status: 'completed', input_fingerprint: FP, stale_at: null,
  latest_review_version: 1, ...extra,
});
const review = (extra = {}) => ({ id: uuid(20), analysis_id: uuid(10), review_version: 1, disposition: 'approved', ...extra });
const row = (n, extra = {}) => ({
  id: uuid(100 + n), analysis_id: uuid(10), criterion_id: `task:${n}`, criterion_kind: 'task',
  criterion_text_snapshot: `Wymaganie ${n}`, criterion_order: n, verdict: 'missing', missing_info: `Brak ${n}`,
  suggested_question: `Pytanie ${n}?`, human_status: 'accepted', human_verdict: null, human_missing_info: null,
  human_suggested_question: null, ...extra,
});
const input = (extra = {}) => ({
  entry: entry(), analysis: analysis(), latestReview: review(), rows: [row(1), row(2, { verdict: 'supported' })],
  fingerprint: FP, ...extra,
});

test('ready: questions come from approved gaps only, without any score', () => {
  const result = individualQuestionsForCandidate(input());
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.questions.map(q => q.question), ['Pytanie 1?']);
  assert.equal(result.questions[0].requirement, 'Wymaganie 1');
  assert.equal(result.questions[0].missingInfo, 'Brak 1');
  // Separation: nothing that could be folded into the comparable result.
  for (const question of result.questions) {
    assert.deepEqual(Object.keys(question).sort(), ['missingInfo', 'question', 'requirement', 'source', 'sourceResultId']);
  }
  assert.ok(!('score' in result) && !('rating' in result));
});

test('shortlist-only: no entry or a removed entry builds nothing', () => {
  assert.deepEqual(individualQuestionsForCandidate(input({ entry: null })), { status: 'not_shortlisted', questions: [] });
  assert.equal(individualQuestionsForCandidate(input({ entry: entry({ removed_at: '2026-11-17T10:00:00Z' }) })).status, 'not_shortlisted');
});

test('gate: human approval of the current analysis revision is required (individualQuestionsAllowed)', () => {
  assert.equal(individualQuestionsForCandidate(input({ latestReview: null })).status, 'awaiting_review');
  assert.equal(individualQuestionsForCandidate(input({ analysis: analysis({ latest_review_version: 2 }) })).status, 'awaiting_review');
  assert.equal(individualQuestionsForCandidate(input({ latestReview: review({ disposition: 'needs_reanalysis' }) })).status, 'outdated');
  assert.equal(individualQuestionsForCandidate(input({ latestReview: review({ disposition: 'approved_with_changes' }) })).status, 'ready');
});

test('gate: stale analysis or changed CV/requirements hides questions', () => {
  assert.equal(individualQuestionsForCandidate(input({ fingerprint: 'b'.repeat(64) })).status, 'outdated');
  assert.equal(individualQuestionsForCandidate(input({ fingerprint: undefined })).status, 'outdated');
  assert.equal(individualQuestionsForCandidate(input({ analysis: analysis({ stale_at: '2026-11-17T10:00:00Z' }) })).status, 'outdated');
});

test('gate: no completed analysis', () => {
  assert.equal(individualQuestionsForCandidate(input({ analysis: null })).status, 'no_analysis');
  assert.equal(individualQuestionsForCandidate(input({ analysis: analysis({ execution_status: 'processing' }) })).status, 'no_analysis');
});

test('shortlist must point at the very analysis and review shown', () => {
  assert.equal(individualQuestionsForCandidate(input({ entry: entry({ analysis_id: uuid(11) }) })).status, 'outdated');
  assert.equal(individualQuestionsForCandidate(input({ entry: entry({ review_id: uuid(21) }) })).status, 'outdated');
});

test('fail closed on mismatched identities', () => {
  assert.equal(individualQuestionsForCandidate(input({ analysis: analysis({ application_id: uuid(4) }) })).status, 'unavailable');
  assert.equal(individualQuestionsForCandidate(input({ latestReview: review({ analysis_id: uuid(11) }) })).status, 'unavailable');
  assert.equal(individualQuestionsForCandidate(input({ rows: [row(1, { analysis_id: uuid(11) })] })).status, 'unavailable');
});

test('dedupe and limit are passed through to buildIndividualQuestions', () => {
  const many = Array.from({ length: 9 }, (_, n) => row(n));
  assert.equal(individualQuestionsForCandidate(input({ rows: many })).questions.length, EXERCISE_AI_MAX_INDIVIDUAL_QUESTIONS);
  assert.equal(individualQuestionsForCandidate(input({ rows: many, limit: 2 })).questions.length, 2);
  const dup = [row(1, { suggested_question: 'Ile  osób?' }), row(2, { suggested_question: 'ile osób?' })];
  assert.equal(individualQuestionsForCandidate(input({ rows: dup })).questions.length, 1);
  // A row rejected by a human carries no question; all rows rejected → no_questions.
  assert.equal(individualQuestionsForCandidate(input({ rows: [row(1, { human_status: 'rejected' })] })).status, 'no_questions');
  // Human-edited question wins over the AI one.
  const edited = individualQuestionsForCandidate(input({ rows: [row(1, { human_status: 'edited', human_suggested_question: 'Poprawione?' })] }));
  assert.deepEqual(edited.questions.map(q => [q.question, q.source]), [['Poprawione?', 'edited']]);
});

// --- loader with a fake RLS client ---------------------------------------
function fakeClient(tables) {
  const calls = [];
  const client = {
    calls,
    from(table) {
      const call = { table, filters: [] };
      calls.push(call);
      const builder = {
        select(cols) { call.select = cols; return builder; },
        eq(col, val) { call.filters.push(['eq', col, val]); return builder; },
        is(col, val) { call.filters.push(['is', col, val]); return builder; },
        in(col, val) { call.filters.push(['in', col, val]); return builder; },
        order() { return builder; },
        limit() { return builder; },
        maybeSingle() { return Promise.resolve(tables[table](call, true)); },
        then(resolve, reject) { return Promise.resolve(tables[table](call, false)).then(resolve, reject); },
      };
      return builder;
    },
  };
  return client;
}
const filter = (call, col) => call.filters.find(([, c]) => c === col)?.[2];
const baseTables = (overrides = {}) => ({
  recruitment_shortlist_entries: () => ({ data: [entry()], error: null }),
  applications: () => ({ data: [{ id: uuid(3), candidate_id: uuid(30) }], error: null }),
  candidates: () => ({ data: [{ id: uuid(30), first_name: 'Testowa', last_name: 'Osoba' }], error: null }),
  screening_analysis_versions: () => ({ data: analysis(), error: null }),
  screening_result_reviews: () => ({ data: [review()], error: null }),
  screening_criterion_results: () => ({ data: [row(1)], error: null }),
  ...overrides,
});
const args = { companyId: uuid(1), recruitmentId: uuid(2), canEdit: true, flag: 'true' };
const deps = { fingerprint: async () => FP };

test('loader: flag off or no edit rights → null and no database reads', async () => {
  for (const extra of [{ flag: undefined }, { flag: 'false' }, { flag: 'TRUE' }, { canEdit: false }]) {
    const client = fakeClient(baseTables());
    assert.equal(await loadShortlistIndividualQuestions(client, { ...args, ...extra }, deps), null);
    assert.equal(client.calls.length, 0);
  }
});

test('loader: reads only active shortlist entries of this company and recruitment', async () => {
  const client = fakeClient(baseTables());
  const result = await loadShortlistIndividualQuestions(client, args, deps);
  const shortlistCall = client.calls.find(call => call.table === 'recruitment_shortlist_entries');
  assert.equal(filter(shortlistCall, 'company_id'), uuid(1));
  assert.equal(filter(shortlistCall, 'recruitment_id'), uuid(2));
  assert.deepEqual(shortlistCall.filters.find(([op]) => op === 'is'), ['is', 'removed_at', null]);
  for (const call of client.calls) assert.equal(filter(call, 'company_id'), uuid(1), `${call.table} scoped to company`);
  assert.equal(result.truncated, false);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].status, 'ready');
  assert.equal(result.candidates[0].label, 'Testowa Osoba');
  assert.deepEqual(result.candidates[0].questions.map(q => q.question), ['Pytanie 1?']);
  // No secret or CV text columns are selected by this helper.
  for (const call of client.calls) assert.doesNotMatch(call.select ?? '', /\*|redacted_text|input_cv_text_snapshot|secret/);
});

test('loader: empty shortlist → no candidates and no per-candidate reads', async () => {
  const client = fakeClient(baseTables({ recruitment_shortlist_entries: () => ({ data: [], error: null }) }));
  assert.deepEqual(await loadShortlistIndividualQuestions(client, args, deps), { candidates: [], truncated: false });
  assert.deepEqual(client.calls.map(call => call.table), ['recruitment_shortlist_entries']);
});

test('loader: caps the number of candidates', async () => {
  const many = Array.from({ length: INDIVIDUAL_QUESTIONS_MAX_CANDIDATES + 1 }, (_, n) => entry({ application_id: uuid(500 + n) }));
  const client = fakeClient(baseTables({
    recruitment_shortlist_entries: () => ({ data: many, error: null }),
    applications: () => ({ data: [], error: null }),
  }));
  const result = await loadShortlistIndividualQuestions(client, args, deps);
  assert.equal(result.truncated, true);
  assert.equal(result.candidates.length, INDIVIDUAL_QUESTIONS_MAX_CANDIDATES);
  assert.ok(result.candidates.every(candidate => candidate.status === 'unavailable'));
});

test('loader: analysis that changes between reads fails closed', async () => {
  let reads = 0;
  const client = fakeClient(baseTables({
    screening_analysis_versions: () => ({ data: analysis({ latest_review_version: reads++ === 0 ? 1 : 2 }), error: null }),
  }));
  const result = await loadShortlistIndividualQuestions(client, args, deps);
  assert.equal(result.candidates[0].status, 'unavailable');
  assert.deepEqual(result.candidates[0].questions, []);
});

test('loader: shortlist read error is not hidden', async () => {
  const client = fakeClient(baseTables({ recruitment_shortlist_entries: () => ({ data: null, error: { code: '42501' } }) }));
  await assert.rejects(loadShortlistIndividualQuestions(client, args, deps), /shortlisty/);
});

test('UI: page is gated by the same flag and edit rights; copy states separation and no sending', () => {
  const page = readFileSync(new URL('../app/dashboard/[companyId]/recruitments/[recruitmentId]/exercises/individual-questions/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /isExerciseAiEnabled\(process\.env\.EXERCISE_AI_ENABLED\)\) notFound\(\)/);
  assert.match(page, /if \(!canEdit\) notFound\(\)/);
  const section = readFileSync(new URL('../app/dashboard/[companyId]/recruitments/[recruitmentId]/individual-questions-section.tsx', import.meta.url), 'utf8');
  assert.match(section, /Ocenia się je osobno/);
  assert.match(section, /Nie wchodzą do wspólnego wyniku testu kompetencji/);
  assert.match(section, /nic nie zostało wysłane kandydatowi/);
  assert.match(section, /wyłącznie kandydatów z shortlisty/);
  assert.doesNotMatch(section, /'use client'|<form|action=/);
  const list = readFileSync(new URL('../app/dashboard/[companyId]/recruitments/[recruitmentId]/exercises/page.tsx', import.meta.url), 'utf8');
  assert.match(list, /canEdit && process\.env\.EXERCISE_AI_ENABLED==='true' && <p><Link href=\{`\$\{base\}\/individual-questions`\}>/);
});

// --- one candidate, on that candidate's task page ------------------------
const one = { ...args, applicationId: uuid(3) };

test('single: flag off or no edit rights → null and no database reads', async () => {
  for (const extra of [{ flag: undefined }, { flag: 'false' }, { canEdit: false }]) {
    const client = fakeClient(baseTables());
    assert.equal(await loadCandidateIndividualQuestions(client, { ...one, ...extra }, deps), null);
    assert.equal(client.calls.length, 0);
  }
});

test('single: reads the active shortlist entry of exactly this application, scoped to company', async () => {
  const client = fakeClient(baseTables());
  const result = await loadCandidateIndividualQuestions(client, one, deps);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.questions.map(q => q.question), ['Pytanie 1?']);
  const shortlistCall = client.calls.find(call => call.table === 'recruitment_shortlist_entries');
  assert.equal(filter(shortlistCall, 'recruitment_id'), uuid(2));
  assert.equal(filter(shortlistCall, 'application_id'), uuid(3));
  assert.deepEqual(shortlistCall.filters.find(([op]) => op === 'is'), ['is', 'removed_at', null]);
  for (const call of client.calls) assert.equal(filter(call, 'company_id'), uuid(1), `${call.table} scoped to company`);
  // Neither candidate names nor CV text are read here.
  assert.ok(!client.calls.some(call => call.table === 'candidates' || call.table === 'applications'));
  for (const call of client.calls) assert.doesNotMatch(call.select ?? '', /\*|redacted_text|input_cv_text_snapshot|secret/);
});

test('single: not on the shortlist → not_shortlisted and no analysis reads', async () => {
  const client = fakeClient(baseTables({ recruitment_shortlist_entries: () => ({ data: [], error: null }) }));
  assert.deepEqual(await loadCandidateIndividualQuestions(client, one, deps), { status: 'not_shortlisted', questions: [] });
  assert.deepEqual(client.calls.map(call => call.table), ['recruitment_shortlist_entries']);
});

test('single: read error, duplicate or foreign entry fails closed', async () => {
  for (const data of [null, [entry(), entry()], [entry({ application_id: uuid(4) })]]) {
    const client = fakeClient(baseTables({ recruitment_shortlist_entries: () => ({ data, error: data ? null : { code: '42501' } }) }));
    assert.deepEqual(await loadCandidateIndividualQuestions(client, one, deps), { status: 'unavailable', questions: [] });
  }
});

test('single: same human-approval gate as the list', async () => {
  const client = fakeClient(baseTables({ screening_result_reviews: () => ({ data: [], error: null }) }));
  assert.equal((await loadCandidateIndividualQuestions(client, one, deps)).status, 'awaiting_review');
  const stale = fakeClient(baseTables());
  assert.equal((await loadCandidateIndividualQuestions(stale, one, { fingerprint: async () => 'b'.repeat(64) })).status, 'outdated');
});

test('UI: candidate task page shows the questions read-only, behind flag and edit rights', () => {
  const page = readFileSync(new URL('../app/dashboard/[companyId]/recruitments/[recruitmentId]/applications/[applicationId]/exercises/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /loadCandidateIndividualQuestions\(client,\{\.\.\.route,canEdit,flag:process\.env\.EXERCISE_AI_ENABLED\}\)/);
  assert.match(page, /\{individual&&<CandidateIndividualQuestions result=\{individual\}\/>\}/);
  const section = readFileSync(new URL('../app/dashboard/[companyId]/recruitments/[recruitmentId]/candidate-individual-questions.tsx', import.meta.url), 'utf8');
  assert.match(section, /Ocenia się je osobno/);
  assert.match(section, /nie wchodzą do wspólnego wyniku testu kompetencji/);
  assert.match(section, /nic nie zostało wysłane kandydatowi/);
  assert.doesNotMatch(section, /'use client'|<form|action=/);
});
