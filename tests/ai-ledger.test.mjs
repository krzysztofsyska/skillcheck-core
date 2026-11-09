// SC-021-B: the `onAttempt` ledger hook (unit tests, no network, no database).
import test from 'node:test';
import assert from 'node:assert/strict';
import { AiGatewayError, AI_GATEWAY_ERROR_CODES } from '../lib/ai-gateway/contract.ts';
import { validatePolicy } from '../lib/ai-gateway/policy.ts';
import { createAiGateway, ATTEMPT_HOOK_TIMEOUT_MS } from '../lib/ai-gateway/gateway.ts';
import { createLedgerHook, ledgerPayload } from '../lib/ai-gateway/ledger.ts';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const OP = '33333333-3333-4333-8333-333333333333';
const request = { system: 'Evaluate.', user: '{"cv_text":"SQL i raporty."}', maxOutputTokens: 100 };
const allow = async () => true;
const policy = validatePolicy({
  version: 'test-ledger-1',
  models: { m: { provider: 'openai', model: 'm-1', revision: null, quality: 'standard', costRank: 1, enabled: true } },
  routes: Object.fromEntries(['cv_screening', 'exercise_generation'].map(task => [task, {
    strategy: 'pinned', candidates: ['m'], minQuality: 'standard', timeoutMs: 1000, maxAttempts: 2,
    retryMaybeBilled: true, blockContactData: false, maxInputBytes: 10_000,
  }])),
});
const completed = { status: 'completed', outputText: '{"ok":true}', providerRequestId: 'resp_1',
  usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 } };
const adapter = replies => ({ provider: 'openai', async invoke() {
  const next = replies.shift(); if (next instanceof Error) throw next; return next;
} });
const gateway = (replies, onAttempt) => createAiGateway({ policy, adapters: [adapter(replies)], authorize: allow, onAttempt, sleep: async () => {} });
const ctx = task => ({ companyId: COMPANY, operationId: OP, task, processId: '44444444-4444-4444-8444-444444444444' });

test('ledger_error is a gateway error code', () => {
  assert.ok(AI_GATEWAY_ERROR_CODES.includes('ledger_error'));
});

test('payload carries ids, model, outcome, billing, tokens and latency only; never the request or reply text', async () => {
  const written = [];
  const gw = gateway([completed], createLedgerHook(async p => { written.push(p); }));
  const result = await gw.run(ctx('exercise_generation'), request);
  assert.equal(written.length, 1);
  const [p] = written;
  assert.deepEqual(Object.keys(p).sort(), ['attempt', 'attempt_id', 'billing', 'cached_input_tokens', 'company_id', 'input_tokens',
    'latency_ms', 'model', 'model_key', 'model_revision', 'operation_id', 'outcome', 'policy_version', 'provider',
    'provider_request_id', 'output_tokens', 'task'].sort());
  assert.deepEqual({ ...p, latency_ms: 0 }, {
    attempt_id: result.attemptId, operation_id: OP, company_id: COMPANY, task: 'exercise_generation', attempt: 1,
    provider: 'openai', model: 'm-1', model_revision: null, model_key: 'm', policy_version: 'test-ledger-1',
    outcome: 'completed', billing: 'billed', input_tokens: 10, cached_input_tokens: 2, output_tokens: 5,
    provider_request_id: 'resp_1', latency_ms: 0,
  });
  const text = JSON.stringify(p);
  assert.ok(!text.includes('SQL i raporty') && !text.includes('Evaluate') && !text.includes('"ok"'));
});

test('screening never sends the provider request id; malformed ids are dropped', () => {
  const base = { attemptId: 'a', operationId: OP, companyId: COMPANY, policyVersion: 'v', modelKey: 'm', provider: 'openai',
    model: 'm-1', revision: null, attempt: 1, outcome: 'completed', billing: 'billed', usage: null, latencyMs: 12.6 };
  assert.equal(ledgerPayload({ ...base, task: 'cv_screening', providerRequestId: 'resp_1' }).provider_request_id, null);
  assert.equal(ledgerPayload({ ...base, task: 'exercise_generation', providerRequestId: 'resp 1<script>' }).provider_request_id, null);
  assert.equal(ledgerPayload({ ...base, task: 'exercise_generation', providerRequestId: 'resp_1' }).provider_request_id, 'resp_1');
  assert.equal(ledgerPayload({ ...base, task: 'exercise_generation', providerRequestId: null, latencyMs: -5 }).latency_ms, 0);
  assert.equal(ledgerPayload({ ...base, task: 'exercise_generation', providerRequestId: null }).latency_ms, 13);
});

test('retries are visible: two physical attempts, two payloads with distinct attempt ids and one operation id', async () => {
  const written = [];
  const gw = gateway([new AiGatewayError('server_error', 'maybe_billed'), completed], createLedgerHook(async p => { written.push(p); }));
  await gw.run(ctx('cv_screening'), request);
  assert.deepEqual(written.map(p => [p.attempt, p.outcome, p.billing, p.input_tokens]),
    [[1, 'server_error', 'maybe_billed', null], [2, 'completed', 'billed', 10]]);
  assert.equal(new Set(written.map(p => p.operation_id)).size, 1);
  assert.equal(new Set(written.map(p => p.attempt_id)).size, 2);
});

test('a writer failure becomes ledger_error with the billing flag of the attempt that failed to record', async () => {
  const secret = 'duplicate key value violates unique constraint "attempts_attempt_id_key" DETAIL: company 1111';
  const failing = createLedgerHook(async () => { throw new Error(secret); });
  // Completed answer that could not be recorded: still billed (the code says recording failed), and
  // the draft/analysis is not returned.
  await assert.rejects(gateway([completed], failing).run(ctx('exercise_generation'), request),
    e => e instanceof AiGatewayError && e.code === 'ledger_error' && e.billing === 'billed' && !e.message.includes('duplicate'));
  // A provider refusal before running (not billed) that could not be recorded stays not_billed.
  await assert.rejects(gateway([new AiGatewayError('auth_error', 'not_billed', 401)], failing).run(ctx('exercise_generation'), request),
    e => e.code === 'ledger_error' && e.billing === 'not_billed');
  // A possibly billed transport failure stays maybe_billed.
  await assert.rejects(gateway([new AiGatewayError('timeout', 'maybe_billed')], failing).run(ctx('exercise_generation'), request),
    e => e.code === 'ledger_error' && e.billing === 'maybe_billed');
});

test('a ledger failure stops the retry loop: no further physical attempt after an unrecorded one', async () => {
  let calls = 0;
  const replies = [new AiGatewayError('server_error', 'maybe_billed'), completed];
  const gw = createAiGateway({ policy, authorize: allow, sleep: async () => {},
    adapters: [{ provider: 'openai', async invoke() { calls++; const n = replies.shift(); if (n instanceof Error) throw n; return n; } }],
    onAttempt: createLedgerHook(async () => { throw new Error('down'); }) });
  await assert.rejects(gw.run(ctx('cv_screening'), request), e => e.code === 'ledger_error' && e.billing === 'maybe_billed');
  assert.equal(calls, 1);
});

test('the gateway hook timeout (SC021_ATTEMPT_HOOK_TIMEOUT) is mapped to ledger_error, keeping the billing flag', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hanging = createLedgerHook(() => new Promise(() => {}));
  const pending = gateway([completed], hanging).run(ctx('exercise_generation'), request);
  const outcome = pending.then(() => 'resolved', error => error);
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(ATTEMPT_HOOK_TIMEOUT_MS);
  const error = await outcome;
  assert.ok(error instanceof AiGatewayError, String(error));
  assert.equal(error.code, 'ledger_error'); assert.equal(error.billing, 'billed');
});

test('any other hook error (not from createLedgerHook) is also ledger_error at the gateway', async () => {
  await assert.rejects(gateway([completed], async () => { throw new TypeError('boom'); }).run(ctx('cv_screening'), request),
    e => e instanceof AiGatewayError && e.code === 'ledger_error' && e.billing === 'billed');
});

test('a ledger writer is required', () => {
  assert.throws(() => createLedgerHook(undefined), /SC021_LEDGER_WRITER_REQUIRED/);
});

test('server-only ledger DSN: ai_ledger_* login with a password, no loopback, otherwise null (fail closed)', async () => {
  const { aiLedgerDatabaseUrl } = await import('../lib/ai-ledger-writer.ts');
  assert.ok(aiLedgerDatabaseUrl('postgresql://ai_ledger_app:pw@db.example.supabase.co:5432/postgres'));
  for (const bad of [undefined, '', 'not a url', 'mysql://ai_ledger_app:pw@db.example.com/x',
    'postgresql://postgres:pw@db.example.com/postgres', 'postgresql://authenticated:pw@db.example.com/postgres',
    'postgresql://ai_ledger_app@db.example.com/postgres', 'postgresql://ai_ledger_app:pw@localhost/postgres',
    'postgresql://ai_ledger_app:pw@127.0.0.1/postgres', 'postgresql://ai_ledger_app:pw@db.example.com/postgres?sslmode=disable']) {
    assert.equal(aiLedgerDatabaseUrl(bad), null, String(bad));
  }
});

test('ledger writer: one transaction as ai_ledger_writer, committed before resolving; errors masked and rolled back', async () => {
  const { createExerciseLedgerWriter, exerciseLedgerWriterFromEnv } = await import('../lib/ai-ledger-writer.ts');
  const log = []; let released = 0;
  const client = fail => ({ async query(sql, values) { log.push([sql, values]); if (fail && sql.startsWith('select')) throw new Error('PT409 AI attempt conflict detail'); return { rows: [] }; },
    release() { released++; } });
  const payload = { attempt_id: 'x', operation_id: OP };
  await createExerciseLedgerWriter(async () => client(false), COMPANY, '44444444-4444-4444-8444-444444444444')(payload);
  assert.deepEqual(log.map(l => l[0]), ['begin isolation level read committed', 'set local role ai_ledger_writer',
    'select ai_ledger.record_exercise_attempt($1::uuid,$2::uuid,$3::jsonb) as result', 'commit']);
  assert.deepEqual(log[2][1], [COMPANY, '44444444-4444-4444-8444-444444444444', JSON.stringify(payload)]);
  log.length = 0;
  await assert.rejects(createExerciseLedgerWriter(async () => client(true), COMPANY, OP)(payload), e => e.message === 'SC021_LEDGER_WRITE_FAILED');
  assert.equal(log.at(-1)[0], 'rollback');
  assert.equal(released, 2);
  const saved = process.env.AI_LEDGER_DATABASE_URL;
  try {
    delete process.env.AI_LEDGER_DATABASE_URL;
    assert.equal(exerciseLedgerWriterFromEnv(COMPANY, OP), null);
    process.env.AI_LEDGER_DATABASE_URL = 'postgresql://postgres:pw@db.example.com/postgres';
    assert.equal(exerciseLedgerWriterFromEnv(COMPANY, OP), null);
  } finally { if (saved === undefined) delete process.env.AI_LEDGER_DATABASE_URL; else process.env.AI_LEDGER_DATABASE_URL = saved; }
});

test('exercise ledger route is pinned: migration allowlist row = EXERCISE_LEDGER_ROUTE = default policy and request limits', async () => {
  const { readFileSync } = await import('node:fs');
  const { EXERCISE_LEDGER_ROUTE } = await import('../lib/ai-gateway/ledger.ts');
  const { defaultAiPolicy, DEFAULT_AI_POLICY_VERSION } = await import('../lib/ai-gateway/default-policy.ts');
  const { resolveRoute } = await import('../lib/ai-gateway/policy.ts');
  const { EXERCISE_AI_MAX_OUTPUT_TOKENS, EXERCISE_AI_MAX_REQUEST_BYTES } = await import('../lib/exercise-ai.ts');
  const { exerciseRouteMatchesLedger } = await import('../lib/exercise-ai-provider.ts');
  const sql = readFileSync(new URL('../supabase/migrations/20261109210000_sc021_ai_ledger.sql', import.meta.url), 'utf8');
  const m = sql.match(/insert into ai_ledger\.route_allowlist \(task, provider, model, model_revision, model_key, policy_version,\s*max_attempts, max_input_tokens, max_output_tokens\)\s*values \('exercise_generation', '([^']+)', '([^']+)', null, '([^']+)', '([^']+)', (\d+), (\d+), (\d+)\);/);
  assert.ok(m, 'allowlist insert found');
  assert.equal((sql.match(/insert into ai_ledger\.route_allowlist/g) ?? []).length, 1);
  assert.deepEqual({ provider: m[1], model: m[2], model_revision: null, model_key: m[3], policy_version: m[4],
    max_attempts: Number(m[5]), max_input_tokens: Number(m[6]), max_output_tokens: Number(m[7]) }, { ...EXERCISE_LEDGER_ROUTE });
  const { route, models: [model] } = resolveRoute(defaultAiPolicy, 'exercise_generation');
  assert.deepEqual([model.provider, model.model, model.revision, model.key, DEFAULT_AI_POLICY_VERSION, route.maxAttempts],
    [EXERCISE_LEDGER_ROUTE.provider, EXERCISE_LEDGER_ROUTE.model, EXERCISE_LEDGER_ROUTE.model_revision, EXERCISE_LEDGER_ROUTE.model_key,
      EXERCISE_LEDGER_ROUTE.policy_version, EXERCISE_LEDGER_ROUTE.max_attempts]);
  assert.equal(EXERCISE_LEDGER_ROUTE.max_output_tokens, EXERCISE_AI_MAX_OUTPUT_TOKENS);
  assert.equal(EXERCISE_LEDGER_ROUTE.max_input_tokens, EXERCISE_AI_MAX_REQUEST_BYTES);
  assert.equal(exerciseRouteMatchesLedger(defaultAiPolicy), true);
  const other = validatePolicy({ ...JSON.parse(JSON.stringify(defaultAiPolicy)), version: 'sc021-next' });
  assert.equal(exerciseRouteMatchesLedger(other), false);
});
