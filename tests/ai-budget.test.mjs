// SC-021-C: budget hook of the AI gateway and its wiring into screening and exercise generation.
// Unit tests: no network, no database, no keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AiGatewayError, AI_GATEWAY_ERROR_CODES } from '../lib/ai-gateway/contract.ts';
import { validatePolicy } from '../lib/ai-gateway/policy.ts';
import { createAiGateway } from '../lib/ai-gateway/gateway.ts';
import { BUDGET_ESTIMATES, createBudgetGuard, parseBudgetDecision } from '../lib/ai-gateway/budget.ts';
import { createScreeningGatewayCall } from '../lib/screening-gateway.ts';
import {
  buildScreeningOpenAiRequest, isRetryableScreeningError, sanitizeScreeningError,
  SCREENING_OPENAI_MAX_OUTPUT_TOKENS, SCREENING_OPENAI_MAX_RETRIES, SCREENING_OPENAI_MODEL,
} from '../lib/screening-ai.ts';
import { requestExerciseDraftViaGateway } from '../lib/exercise-ai-provider.ts';
import { exerciseDraftPayload, sanitizeExerciseAiError, EXERCISE_AI_MAX_OUTPUT_TOKENS, EXERCISE_AI_MAX_REQUEST_BYTES } from '../lib/exercise-ai.ts';
import { EXERCISE_AI_MODEL } from '../lib/exercise-ai-model.ts';
import { withExerciseBudget } from '../lib/exercise-ai-budget.ts';
import { EXERCISE_LEDGER_ROUTE } from '../lib/ai-gateway/ledger.ts';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const OP = '33333333-3333-4333-8333-333333333333';
const request = { system: 'Evaluate.', user: '{"cv_text":"SQL i raporty."}', maxOutputTokens: 100 };
const policy = validatePolicy({
  version: 'test-budget-1',
  models: { m: { provider: 'openai', model: 'm-1', revision: null, quality: 'standard', costRank: 1, enabled: true } },
  routes: { cv_screening: { strategy: 'pinned', candidates: ['m'], minQuality: 'standard', timeoutMs: 1000, maxAttempts: 2,
    retryMaybeBilled: true, blockContactData: false, maxInputBytes: 10_000 } },
});
const completed = { status: 'completed', outputText: '{"ok":true}', providerRequestId: 'resp_1',
  usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 } };
const ctx = { companyId: COMPANY, operationId: OP, task: 'cv_screening' };

function harness({ beforeOperation, authorize = async () => true, replies = [completed] } = {}) {
  const invoked = [], attempts = [], order = [];
  const gw = createAiGateway({
    policy, authorize: async c => { order.push('authorize'); return authorize(c); },
    adapters: [{ provider: 'openai', async invoke() { order.push('provider'); invoked.push(1); const r = replies.shift(); if (r instanceof Error) throw r; return r; } }],
    onAttempt: async r => { attempts.push(r); }, beforeOperation, sleep: async () => {},
  });
  return { gw, invoked, attempts, order };
}

test('budget codes are gateway codes', () => {
  for (const code of ['budget_exceeded', 'budget_unconfigured', 'budget_unavailable']) assert.ok(AI_GATEWAY_ERROR_CODES.includes(code));
});

test('the budget hook runs once, after authorization and payload checks, before the first provider call', async () => {
  const seen = [];
  const h = harness({ beforeOperation: async c => { h.order.push('budget'); seen.push(c.operationId); },
    replies: [new AiGatewayError('server_error', 'maybe_billed'), completed] });
  await h.gw.run(ctx, request);
  assert.deepEqual(h.order, ['authorize', 'budget', 'provider', 'provider']);
  assert.deepEqual(seen, [OP], 'retries inside one call do not reserve again');
  // Unauthorized or invalid payloads never reserve budget.
  let called = 0;
  const denied = harness({ beforeOperation: async () => { called++; }, authorize: async () => false });
  await assert.rejects(denied.gw.run(ctx, request), e => e.code === 'unauthorized');
  const tooBig = harness({ beforeOperation: async () => { called++; } });
  await assert.rejects(tooBig.gw.run(ctx, { ...request, user: 'x'.repeat(20_000) }), e => e.code === 'payload_too_large');
  assert.equal(called, 0);
});

test('a refused budget stops the call before any provider I/O or ledger row, not billed', async () => {
  for (const code of ['budget_exceeded', 'budget_unconfigured', 'budget_unavailable']) {
    const h = harness({ beforeOperation: async () => { throw new AiGatewayError(code); } });
    await assert.rejects(h.gw.runRaw(ctx, request), e => e instanceof AiGatewayError && e.code === code && e.billing === 'not_billed');
    assert.equal(h.invoked.length, 0); assert.equal(h.attempts.length, 0);
  }
  // Any other failure of the hook (database text included) is budget_unavailable, code only.
  for (const thrown of [new Error('PT409 secret detail'), new AiGatewayError('ledger_error', 'billed'), 'x']) {
    const h = harness({ beforeOperation: async () => { throw thrown; } });
    await assert.rejects(h.gw.run(ctx, request), e => e.code === 'budget_unavailable' && e.message === 'budget_unavailable' && e.billing === 'not_billed');
    assert.equal(h.invoked.length, 0);
  }
  assert.throws(() => createAiGateway({ policy, adapters: [], authorize: async () => true, onAttempt: async () => {}, beforeOperation: 'yes' }),
    /SC021_BUDGET_HOOK_INVALID/);
});

test('parseBudgetDecision accepts only the database contract and fails closed', async () => {
  assert.deepEqual(parseBudgetDecision({ allowed: true, created: true, reservation_id: 1 }), { allowed: true, created: true });
  assert.deepEqual(parseBudgetDecision({ allowed: true, created: false }), { allowed: true, created: false });
  assert.deepEqual(parseBudgetDecision({ allowed: false, code: 'budget_exceeded' }), { allowed: false, code: 'budget_exceeded' });
  assert.deepEqual(parseBudgetDecision({ allowed: false, code: 'budget_unconfigured', reason: 'no_budget' }), { allowed: false, code: 'budget_unconfigured' });
  for (const bad of [null, undefined, 'ok', [], {}, { allowed: 'true', created: true }, { allowed: true }, { allowed: false },
    { allowed: false, code: 'other' }, { allowed: 1, created: true }]) {
    assert.throws(() => parseBudgetDecision(bad), e => e.code === 'budget_unavailable', JSON.stringify(bad));
  }
  await assert.rejects(createBudgetGuard(null)(ctx), e => e.code === 'budget_unavailable');
  await assert.rejects(createBudgetGuard(async () => { throw new Error('connection string postgres://secret'); })(ctx),
    e => e.code === 'budget_unavailable' && !/secret/.test(e.message));
  await assert.rejects(createBudgetGuard(async () => ({ allowed: false, code: 'budget_exceeded' }))(ctx), e => e.code === 'budget_exceeded');
  const keys = [];
  await createBudgetGuard(async key => { keys.push(key); return { allowed: true, created: true }; })(ctx);
  assert.deepEqual(keys, [OP]);
});

const claim = {
  analysis_id: '22222222-2222-4222-8222-222222222222', company_id: COMPANY, attempt_id: OP, lease_token: 'lease',
  lease_expires_at: '2099-01-01T00:00:00Z', input_fingerprint: 'f'.repeat(64), analysis_contract_hash: 'h'.repeat(64),
  payload_schema_version: 1, result_schema_version: 1, prompt_version: 'screening-v1', provider: 'openai', model: SCREENING_OPENAI_MODEL,
  model_revision: null, input_cv_text_snapshot: 'SQL i raporty.', criteria_snapshot: [{ id: 'c1', kind: 'task', text: 'SQL' }],
};

test('screening: over budget fails the analysis with a clear, non-retryable status and no provider call', async () => {
  for (const [answer, code] of [[{ allowed: false, code: 'budget_exceeded' }, 'ai_budget_exceeded'],
    [{ allowed: false, code: 'budget_unconfigured' }, 'ai_budget_unavailable'], [new Error('db down'), 'ai_budget_unavailable'],
    [{ weird: true }, 'ai_budget_unavailable']]) {
    let fetched = 0; const ledger = [];
    const call = createScreeningGatewayCall({ apiKey: 'k', log: () => {}, recordAttempt: async p => { ledger.push(p); },
      reserveBudget: async () => { if (answer instanceof Error) throw answer; return answer; },
      fetchImpl: async () => { fetched++; throw new Error('must not be called'); } });
    await assert.rejects(call(buildScreeningOpenAiRequest(claim), claim), e => e.code === code);
    assert.equal(fetched, 0); assert.equal(ledger.length, 0);
    assert.equal(isRetryableScreeningError(code), false);
    assert.match(sanitizeScreeningError(code), /limit kosztów AI/i);
  }
  // No reserver wired: refused before provider I/O (fail closed).
  const none = createScreeningGatewayCall({ apiKey: 'k', log: () => {}, recordAttempt: async () => {},
    fetchImpl: async () => { throw new Error('must not be called'); } });
  await assert.rejects(none(buildScreeningOpenAiRequest(claim), claim), e => e.code === 'ai_budget_unavailable');
});

test('screening: every worker retry asks again with the same operation id (the database answers "existing")', async () => {
  const keys = [];
  const call = createScreeningGatewayCall({ apiKey: 'k', log: () => {}, recordAttempt: async () => {},
    reserveBudget: async key => { keys.push(key); return { allowed: true, created: keys.length === 1 }; },
    fetchImpl: async () => new Response('{}', { status: 500 }) });
  for (let i = 0; i < 2; i++) await assert.rejects(call(buildScreeningOpenAiRequest(claim), claim), e => e.code === 'openai_server_error');
  assert.deepEqual(keys, [OP, OP]);
});

const position = { id: 'position', updated_at: '2026-11-07T00:00:00Z', title: 'Planista', tasks: ['Planowanie'],
  required_competencies: ['Planowanie'], kpis: [], required_behaviors: [], autonomy_level: 2 };
const payload = exerciseDraftPayload({ position, company: null });
const trust = { companyId: COMPANY, operationId: OP, recruitmentId: '44444444-4444-4444-8444-444444444444', mayGenerate: true,
  recordAttempt: async () => {} };

test('exercise: the gateway path needs a budget reserver and never calls the provider over budget', async () => {
  let fetched = 0;
  const fetcher = async () => { fetched++; throw new Error('must not be called'); };
  for (const reserveBudget of [undefined, null]) {
    await assert.rejects(requestExerciseDraftViaGateway(payload, 'k', { ...trust, reserveBudget }, { fetcher, log: () => {} }),
      e => e.code === 'exercise_ai_auth_error');
  }
  // Inside an already reserved generation slot only finish-compatible codes are used.
  for (const answer of [{ allowed: false, code: 'budget_exceeded' }, { allowed: false, code: 'budget_unconfigured' }]) {
    await assert.rejects(requestExerciseDraftViaGateway(payload, 'k', { ...trust, reserveBudget: async () => answer }, { fetcher, log: () => {} }),
      e => e.code === 'exercise_ai_server_error');
  }
  assert.equal(fetched, 0);
});

test('exercise: withExerciseBudget refuses with a Polish message before the slot, and frees only its own reservation', async () => {
  const client = (answer, log) => ({
    reserve: async key => { log.push(['reserve', key]); if (answer instanceof Error) throw answer; return answer; },
    release: async key => { log.push(['release', key]); },
  });
  for (const [answer, code] of [[{ allowed: false, code: 'budget_exceeded' }, 'exercise_ai_budget_exceeded'],
    [{ allowed: false, code: 'budget_unconfigured' }, 'exercise_ai_budget_unavailable'],
    [new Error('SC021_BUDGET_CALL_FAILED'), 'exercise_ai_budget_unavailable'], [{ nope: 1 }, 'exercise_ai_budget_unavailable']]) {
    const log = []; let generated = 0;
    const r = await withExerciseBudget(client(answer, log), OP, async () => { generated++; return {}; });
    assert.deepEqual(r, { error: sanitizeExerciseAiError(code) });
    assert.equal(generated, 0); assert.deepEqual(log, [['reserve', OP]]);
    assert.match(r.error, /Nie zużyto próby AI/);
  }
  const log = [];
  assert.deepEqual(await withExerciseBudget(client({ allowed: true, created: true }, log), OP, async () => ({ exerciseId: 'x' })), { exerciseId: 'x' });
  assert.deepEqual(log, [['reserve', OP], ['release', OP]]);
  const thrown = [];
  await assert.rejects(withExerciseBudget(client({ allowed: true, created: true }, thrown), OP, async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(thrown.at(-1), ['release', OP]);
  // A concurrent duplicate of the same request key never frees the running call's reservation.
  const dup = [];
  await withExerciseBudget(client({ allowed: true, created: false }, dup), OP, async () => ({}));
  assert.deepEqual(dup, [['reserve', OP]]);
  // A failed release never fails the generation (the reservation expires instead).
  const failing = { reserve: async () => ({ allowed: true, created: true }), release: async () => { throw new Error('x'); } };
  assert.deepEqual(await withExerciseBudget(failing, OP, async () => ({ exerciseId: 'y' })), { exerciseId: 'y' });
});

test('budget estimates are pinned to the code limits and to the migration seed', async () => {
  assert.deepEqual(BUDGET_ESTIMATES.cv_screening, { max_input_tokens: 120_000, max_output_tokens: SCREENING_OPENAI_MAX_OUTPUT_TOKENS,
    attempts_per_operation: 1 + SCREENING_OPENAI_MAX_RETRIES });
  // CV text is capped at 100 000 characters at intake; the estimate leaves room for criteria and instructions.
  assert.ok(BUDGET_ESTIMATES.cv_screening.max_input_tokens >= 100_000);
  assert.deepEqual(BUDGET_ESTIMATES.exercise_generation, { max_input_tokens: EXERCISE_LEDGER_ROUTE.max_input_tokens,
    max_output_tokens: EXERCISE_AI_MAX_OUTPUT_TOKENS, attempts_per_operation: EXERCISE_LEDGER_ROUTE.max_attempts });
  assert.ok(EXERCISE_AI_MAX_REQUEST_BYTES <= BUDGET_ESTIMATES.exercise_generation.max_input_tokens);
  const sql = await readFile(new URL('../supabase/migrations/20261109230000_sc021_ai_budgets.sql', import.meta.url), 'utf8');
  for (const [task, model] of [['cv_screening', SCREENING_OPENAI_MODEL], ['exercise_generation', EXERCISE_AI_MODEL]]) {
    const e = BUDGET_ESTIMATES[task];
    assert.ok(sql.includes(`('${task}', 'openai', '${model}', null, ${e.max_input_tokens}, ${e.max_output_tokens}, ${e.attempts_per_operation},`), task);
  }
});
