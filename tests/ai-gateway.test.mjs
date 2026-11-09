// SC-021-A: AI gateway — synthetic tests only. No network, no real provider, no keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVE_AI_PROVIDERS, AiGatewayError } from '../lib/ai-gateway/contract.ts';
import { validatePolicy, resolveRoute } from '../lib/ai-gateway/policy.ts';
import { defaultAiPolicy } from '../lib/ai-gateway/default-policy.ts';
import { createAiGateway as createRaw, containsContactData } from '../lib/ai-gateway/gateway.ts';
const createAiGateway = opts => createRaw({ onAttempt: async () => {}, ...opts });
import { buildOpenAiResponsesBody, createOpenAiAdapter, parseOpenAiResponse, OPENAI_RESPONSES_URL } from '../lib/ai-gateway/openai.ts';
import { createAnthropicAdapter } from '../lib/ai-gateway/anthropic.ts';
import { isAiGatewayEnabled } from '../lib/ai-gateway/contract.ts';
import { attemptLogEntry, gatewayRequestFromResponsesBody, pinnedRouteModel } from '../lib/ai-gateway/responses-bridge.ts';
import { suggestRedaction } from '../lib/cv-text.ts';
import { screeningAllowlistPayload } from '../lib/screening-ai.ts';
import { buildExerciseDraftRequest, exerciseDraftPayload, EXERCISE_AI_MODEL } from '../lib/exercise-ai.ts';
import { MAX_PROVIDER_RESPONSE_BYTES } from '../lib/ai-gateway/http.ts';
import { screeningAnalysisContractHash } from '../lib/screening.ts';
import {
  SCREENING_OPENAI_MODEL, SCREENING_OPENAI_MAX_OUTPUT_TOKENS,
  buildScreeningOpenAiRequest, screeningEvidenceAiContract,
} from '../lib/screening-ai.ts';

const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const COMPANY_B = '22222222-2222-4222-8222-222222222222';
const OP = '33333333-3333-4333-8333-333333333333';
const ctx = { companyId: COMPANY_A, operationId: OP, task: 'cv_screening', candidatePseudonym: 'cand_7f3a' };
const request = { system: 'Evaluate.', user: '{"cv_text":"SQL i raporty."}', maxOutputTokens: 100 };
const allow = async () => true;

const completed = (text = '{"ok":true}') => ({
  status: 'completed', outputText: text, providerRequestId: 'resp_1',
  usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
});

function policyWith(routes, models) {
  return validatePolicy({
    version: 'test-1',
    models: models ?? {
      cheap: { provider: 'openai', model: 'm-cheap', revision: null, quality: 'standard', costRank: 1, enabled: true },
      good: { provider: 'openai', model: 'm-good', revision: 'r1', quality: 'high', costRank: 9, enabled: true },
      other: { provider: 'anthropic', model: 'a-1', revision: null, quality: 'high', costRank: 0, enabled: true },
    },
    routes,
  });
}
const route = (over = {}) => ({
  strategy: 'cheapest', candidates: ['cheap', 'good'], minQuality: 'standard', timeoutMs: 1000,
  maxAttempts: 3, retryMaybeBilled: false, blockContactData: true, maxInputBytes: 10_000, ...over,
});
function fakeAdapter(replies, calls = []) {
  return {
    provider: 'openai',
    async invoke(call) {
      calls.push(call);
      const next = replies.shift();
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next(call);
      return next;
    },
  };
}
const noSleep = async () => {};

test('only OpenAI is an active provider', () => {
  assert.deepEqual([...ACTIVE_AI_PROVIDERS], ['openai']);
  assert.ok(Object.isFrozen(ACTIVE_AI_PROVIDERS));
});

test('default policy validates and routes every task to an active provider only', () => {
  for (const task of Object.keys(defaultAiPolicy.routes)) {
    const { models } = resolveRoute(defaultAiPolicy, task);
    assert.ok(models.length > 0, task);
    assert.ok(models.every(m => m.provider === 'openai'), task);
  }
  assert.equal(resolveRoute(defaultAiPolicy, 'cv_screening').models[0].model, SCREENING_OPENAI_MODEL);
  assert.equal(defaultAiPolicy.routes.cv_screening.strategy, 'pinned');
  assert.equal(defaultAiPolicy.routes.cv_screening.retryMaybeBilled, false);
});

test('policy validation fails closed on malformed configuration', () => {
  const ok = { strategy: 'pinned', candidates: ['cheap'], minQuality: 'standard', timeoutMs: 1000, maxAttempts: 1,
    retryMaybeBilled: false, blockContactData: true, maxInputBytes: 10 };
  assert.doesNotThrow(() => policyWith({ cv_screening: ok }));
  for (const bad of [
    { cv_screening: { ...ok, extra: 1 } },
    { cv_screening: { ...ok, candidates: ['cheap', 'good'] } },
    { cv_screening: { ...ok, candidates: ['missing'] } },
    { cv_screening: { ...ok, timeoutMs: 999_999 } },
    { cv_screening: { ...ok, maxAttempts: 0 } },
    { not_a_task: ok },
  ]) assert.throws(() => policyWith(bad), /SC021_INVALID_POLICY/);
  assert.throws(() => policyWith({}, { x: { provider: 'gemini', model: 'g', revision: null, quality: 'standard', costRank: 1, enabled: true } }), /SC021_INVALID_POLICY/);
  assert.throws(() => validatePolicy({ version: 'v', models: {}, routes: {} }), /SC021_INVALID_POLICY/);
});

test('routing: cheapest, best_quality, quality floor, inactive provider excluded', () => {
  const policy = policyWith({
    cv_screening: route({ candidates: ['good', 'cheap', 'other'] }),
    report_summary: route({ strategy: 'best_quality', candidates: ['cheap', 'good', 'other'] }),
    interview_plan: route({ candidates: ['cheap', 'good', 'other'], minQuality: 'high' }),
  });
  assert.deepEqual(resolveRoute(policy, 'cv_screening').models.map(m => m.key), ['cheap', 'good']);
  assert.deepEqual(resolveRoute(policy, 'report_summary').models.map(m => m.key), ['good', 'cheap']);
  assert.deepEqual(resolveRoute(policy, 'interview_plan').models.map(m => m.key), ['good']);
  assert.throws(() => resolveRoute(policy, 'exercise_generation'), /SC021_ROUTE_DISABLED/);
});

test('routing rollback: switching to a previous policy version restores the previous model', () => {
  const v1 = policyWith({ cv_screening: route({ strategy: 'pinned', candidates: ['cheap'] }) });
  const v2 = policyWith({ cv_screening: route({ strategy: 'pinned', candidates: ['good'] }) });
  assert.equal(resolveRoute(v2, 'cv_screening').models[0].model, 'm-good');
  assert.equal(resolveRoute(v1, 'cv_screening').models[0].model, 'm-cheap');
});

test('an adapter for an inactive provider cannot be registered', () => {
  const adapter = createAnthropicAdapter({ apiKey: 'synthetic', fetchImpl: async () => { throw new Error('no'); } });
  assert.throws(() => createAiGateway({ policy: defaultAiPolicy, adapters: [adapter], authorize: allow }),
    e => e instanceof AiGatewayError && e.code === 'provider_inactive');
});

test('authorization is mandatory and fails closed', async () => {
  assert.throws(() => createAiGateway({ policy: defaultAiPolicy, adapters: [] }), /SC021_AUTHORIZE_REQUIRED/);
  assert.throws(() => createRaw({ policy: defaultAiPolicy, adapters: [], authorize: allow }), /SC021_ATTEMPT_HOOK_REQUIRED/);
  for (const authorize of [async () => false, async () => { throw new Error('db'); }, async () => 'yes']) {
    const calls = [];
    const gw = createAiGateway({ policy: defaultAiPolicy, adapters: [fakeAdapter([completed()], calls)], authorize });
    await assert.rejects(gw.run(ctx, request), e => e.code === 'unauthorized');
    assert.equal(calls.length, 0);
  }
});

test('authorization sees the exact company — company A cannot act as company B', async () => {
  const seen = [];
  const gw = createAiGateway({
    policy: defaultAiPolicy, adapters: [fakeAdapter([completed()])],
    authorize: async c => { seen.push(c.companyId); return c.companyId === COMPANY_A; },
  });
  await assert.rejects(gw.run({ ...ctx, companyId: COMPANY_B }, request), e => e.code === 'unauthorized');
  assert.deepEqual(seen, [COMPANY_B]);
});

test('invalid context is rejected before authorization', async () => {
  let authorized = 0;
  const gw = createAiGateway({ policy: defaultAiPolicy, adapters: [fakeAdapter([])], authorize: async () => { authorized++; return true; } });
  for (const bad of [{ ...ctx, companyId: 'x' }, { ...ctx, operationId: '' }, { ...ctx, task: 'free_chat' },
    { ...ctx, candidatePseudonym: 'Jan Kowalski <jan@x.pl>' }]) {
    await assert.rejects(gw.run(bad, request), e => e.code === 'invalid_context');
  }
  assert.equal(authorized, 0);
});

test('payload with contact data or over the size limit never reaches the provider', async () => {
  assert.equal(containsContactData('kontakt: jan.kowalski@example.com'), true);
  assert.equal(containsContactData('tel. 500 123 456'), true);
  assert.equal(containsContactData('SQL, raporty 2019-2024'), false);
  const calls = [];
  // A route with the guard on (the default policy turns it off per route in A2, see the guard parity test).
  const guarded = policyWith({ cv_screening: route({ strategy: 'pinned', candidates: ['cheap'], maxAttempts: 1, maxInputBytes: 200_000 }) });
  const gw = createAiGateway({ policy: guarded, adapters: [fakeAdapter([], calls)], authorize: allow });
  await assert.rejects(gw.run(ctx, { ...request, user: 'mail: a.b@example.com' }), e => e.code === 'payload_not_redacted');
  await assert.rejects(gw.run(ctx, { ...request, system: 'Firma: kontakt 500 123 456' }), e => e.code === 'payload_not_redacted');
  await assert.rejects(gw.run(ctx, { ...request, jsonSchema: { name: 's', schema: { description: 'hr@example.com' } } }), e => e.code === 'payload_not_redacted');
  await assert.rejects(gw.run(ctx, { ...request, user: 'x'.repeat(300_000) }), e => e.code === 'payload_too_large');
  await assert.rejects(gw.run(ctx, { ...request, maxOutputTokens: 0 }), e => e.code === 'invalid_request');
  await assert.rejects(gw.run(ctx, { ...request, jsonSchema: { name: 's', schema: { description: 'x'.repeat(300_000) } } }),
    e => e.code === 'payload_too_large', 'output schema counts toward the input limit');
  assert.equal(calls.length, 0);
});

test('screening parity: gateway OpenAI body equals the current screening request', () => {
  const claim = {
    analysis_id: 'a1111111-1111-4111-8111-111111111111', attempt_id: 'a2222222-2222-4222-8222-222222222222',
    lease_token: 'a'.repeat(64), lease_expires_at: '2026-10-04T17:00:00Z', input_fingerprint: 'b'.repeat(64),
    analysis_contract_hash: screeningAnalysisContractHash(screeningEvidenceAiContract),
    payload_schema_version: 1, result_schema_version: 2, prompt_version: screeningEvidenceAiContract.prompt_version,
    provider: 'openai', model: SCREENING_OPENAI_MODEL, model_revision: null,
    input_cv_text_snapshot: 'SQL i raporty.',
    criteria_snapshot: [{ id: 'task:1', kind: 'task', text: 'Analiza danych' }],
  };
  const current = buildScreeningOpenAiRequest(claim);
  const viaGateway = buildOpenAiResponsesBody(resolveRoute(defaultAiPolicy, 'cv_screening').models[0].model, {
    system: current.input[0].content, user: current.input[1].content,
    jsonSchema: { name: current.text.format.name, schema: current.text.format.schema },
    maxOutputTokens: SCREENING_OPENAI_MAX_OUTPUT_TOKENS, reasoningEffort: 'low',
  });
  assert.equal(JSON.stringify(viaGateway), JSON.stringify(current));

  // Legacy v1 claims (role 'developer', v1 schema) are reproduced too.
  const legacy = { ...claim, result_schema_version: 1, prompt_version: 'screening-v1' };
  const currentV1 = buildScreeningOpenAiRequest(legacy);
  const viaGatewayV1 = buildOpenAiResponsesBody(SCREENING_OPENAI_MODEL, {
    system: currentV1.input[0].content, user: currentV1.input[1].content, instructionRole: 'developer',
    jsonSchema: { name: currentV1.text.format.name, schema: currentV1.text.format.schema },
    maxOutputTokens: SCREENING_OPENAI_MAX_OUTPUT_TOKENS, reasoningEffort: 'low',
  });
  assert.equal(currentV1.input[0].role, 'developer');
  assert.equal(JSON.stringify(viaGatewayV1), JSON.stringify(currentV1));
});

test('policy is frozen all the way down', () => {
  assert.ok(Object.isFrozen(defaultAiPolicy.models) && Object.isFrozen(defaultAiPolicy.routes));
  assert.ok(Object.isFrozen(defaultAiPolicy.models['openai-screening']));
  assert.ok(Object.isFrozen(defaultAiPolicy.routes.cv_screening.candidates));
  assert.throws(() => { 'use strict'; defaultAiPolicy.models['openai-screening'].provider = 'anthropic'; }, TypeError);
});

test('success returns output, model and policy version; attempt is recorded as billed', async () => {
  const records = [];
  const gw = createAiGateway({ policy: defaultAiPolicy, adapters: [fakeAdapter([completed('{"a":1}')])], authorize: allow,
    onAttempt: async r => { records.push(r); } });
  const result = await gw.run(ctx, request);
  assert.equal(result.outputText, '{"a":1}');
  assert.equal(result.model, SCREENING_OPENAI_MODEL);
  assert.equal(result.policyVersion, defaultAiPolicy.version);
  assert.equal(result.operationId, OP);
  assert.equal(records.length, 1);
  assert.equal(records[0].billing, 'billed');
  assert.equal(records[0].attemptId, result.attemptId);
  assert.equal(JSON.stringify(records).includes('SQL i raporty'), false, 'ledger record carries no payload');
});

test('rate limit is retried; every physical attempt is recorded with its own attemptId', async () => {
  const records = [];
  const sleeps = [];
  const gw = createAiGateway({
    policy: policyWith({ cv_screening: route() }),
    adapters: [fakeAdapter([new AiGatewayError('rate_limit'), completed()])], authorize: allow,
    onAttempt: async r => { records.push(r); }, sleep: async ms => { sleeps.push(ms); },
  });
  const result = await gw.run(ctx, request);
  assert.equal(result.attempts, 2);
  assert.deepEqual(records.map(r => [r.outcome, r.billing]), [['rate_limit', 'not_billed'], ['completed', 'billed']]);
  assert.notEqual(records[0].attemptId, records[1].attemptId);
  assert.ok(records.every(r => r.operationId === OP));
  assert.deepEqual(sleeps, [500]);
});

test('a possibly billed failure is not retried unless the route allows it, and is recorded', async () => {
  const records = [];
  const gw = createAiGateway({
    policy: policyWith({ cv_screening: route() }),
    adapters: [fakeAdapter([new AiGatewayError('server_error', 'maybe_billed'), completed()])], authorize: allow,
    onAttempt: async r => { records.push(r); }, sleep: noSleep,
  });
  await assert.rejects(gw.run(ctx, request), e => e.code === 'server_error' && e.billing === 'maybe_billed');
  assert.deepEqual(records.map(r => r.billing), ['maybe_billed']);

  const records2 = [];
  const gw2 = createAiGateway({
    policy: policyWith({ cv_screening: route({ retryMaybeBilled: true }) }),
    adapters: [fakeAdapter([new AiGatewayError('timeout', 'maybe_billed'), completed()])], authorize: allow,
    onAttempt: async r => { records2.push(r); }, sleep: noSleep,
  });
  assert.equal((await gw2.run(ctx, request)).attempts, 2);
  assert.deepEqual(records2.map(r => r.billing), ['maybe_billed', 'billed']);
});

test('non-transient errors and refusals are not retried', async () => {
  for (const [reply, code] of [[new AiGatewayError('auth_error'), 'auth_error'], [new AiGatewayError('bad_request'), 'bad_request'],
    [{ ...completed(), status: 'refused', outputText: null }, 'refusal'], [{ ...completed(), status: 'incomplete' }, 'incomplete']]) {
    const calls = [];
    const gw = createAiGateway({ policy: policyWith({ cv_screening: route() }), adapters: [fakeAdapter([reply, completed()], calls)], authorize: allow, sleep: noSleep });
    await assert.rejects(gw.run(ctx, request), e => e.code === code);
    assert.equal(calls.length, 1);
  }
});

test('unavailable model falls back to the next eligible model, never to an inactive provider', async () => {
  const calls = [];
  const gw = createAiGateway({
    policy: policyWith({ cv_screening: route({ candidates: ['cheap', 'other', 'good'] }) }),
    adapters: [fakeAdapter([new AiGatewayError('model_unavailable'), completed()], calls)], authorize: allow, sleep: noSleep,
  });
  const result = await gw.run(ctx, request);
  assert.deepEqual(calls.map(c => c.model), ['m-cheap', 'm-good']);
  assert.equal(result.modelKey, 'good');
});

test('pinned route never falls back to another model', async () => {
  const calls = [];
  const gw = createAiGateway({
    policy: policyWith({ cv_screening: route({ strategy: 'pinned', candidates: ['cheap'] }) }),
    adapters: [fakeAdapter([new AiGatewayError('model_unavailable'), new AiGatewayError('model_unavailable'), new AiGatewayError('model_unavailable')], calls)],
    authorize: allow, sleep: noSleep,
  });
  await assert.rejects(gw.run(ctx, request), e => e.code === 'model_unavailable');
  assert.equal(calls.length, 1, 'missing pinned model is not resent');
});

test('circuit breaker takes a failing model out of rotation until the cooldown ends', async () => {
  let clock = 0;
  const calls = [];
  const replies = [];
  const gw = createAiGateway({
    policy: policyWith({ cv_screening: route({ maxAttempts: 1, retryMaybeBilled: true }) }),
    adapters: [fakeAdapter(replies, calls)], authorize: allow, sleep: noSleep, now: () => clock,
    breaker: { failureThreshold: 2, cooldownMs: 1000 },
  });
  for (let i = 0; i < 2; i++) {
    replies.push(new AiGatewayError('server_error', 'maybe_billed'));
    await assert.rejects(gw.run(ctx, request));
  }
  replies.push(completed());
  assert.equal((await gw.run(ctx, request)).modelKey, 'good');
  clock = 1000;
  replies.push(completed());
  assert.equal((await gw.run(ctx, request)).modelKey, 'cheap');
});

test('pinned route stops retrying once the breaker opens', async () => {
  const calls = [];
  const gw = createAiGateway({
    policy: policyWith({ cv_screening: route({ strategy: 'pinned', candidates: ['cheap'], maxAttempts: 4, retryMaybeBilled: true }) }),
    adapters: [fakeAdapter(Array.from({ length: 4 }, () => new AiGatewayError('server_error', 'maybe_billed')), calls)],
    authorize: allow, sleep: noSleep, now: () => 0,
  });
  await assert.rejects(gw.run(ctx, request), e => e.code === 'server_error');
  assert.equal(calls.length, 3, 'default threshold 3 opens the breaker; the 4th call is not made');
});

test('timeout aborts the provider call', async () => {
  const gw = createAiGateway({
    policy: policyWith({ cv_screening: route({ maxAttempts: 1 }) }),
    adapters: [fakeAdapter([call => new Promise((_, reject) => call.signal.addEventListener('abort', () => reject(new Error('aborted'))))])],
    authorize: allow,
  });
  await assert.rejects(gw.run(ctx, request), e => e.code === 'timeout' && e.billing === 'maybe_billed');
});

test('gateway stops waiting even when an adapter ignores the abort signal', async () => {
  const gw = createAiGateway({
    policy: policyWith({ cv_screening: route({ maxAttempts: 1 }) }),
    adapters: [fakeAdapter([() => new Promise(() => {})])], authorize: allow,
  });
  await assert.rejects(gw.run(ctx, request), e => e.code === 'timeout' && e.billing === 'maybe_billed');
});

test('a failing ledger hook fails the call instead of returning unrecorded work', async () => {
  const gw = createAiGateway({ policy: defaultAiPolicy, adapters: [fakeAdapter([completed()])], authorize: allow,
    onAttempt: async () => { throw new Error('ledger down'); } });
  await assert.rejects(gw.run(ctx, request), /ledger down/);
});

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  return { impl, calls };
}
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('OpenAI adapter: request shape, key only in header, usage and refusal parsing', async () => {
  const { impl, calls } = fakeFetch(() => jsonResponse({
    id: 'resp_9', status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: '{"x":' }, { type: 'output_text', text: '1}' }] }],
    usage: { input_tokens: 20, input_tokens_details: { cached_tokens: 4 }, output_tokens: 7 },
  }));
  const adapter = createOpenAiAdapter({ apiKey: 'sk-synthetic', fetchImpl: impl });
  const reply = await adapter.invoke({ model: 'm', revision: null, request, attemptId: 'att-1', signal: new AbortController().signal });
  const { body, ...neutral } = reply;
  assert.deepEqual(neutral, { status: 'completed', outputText: '{"x":1}', providerRequestId: 'resp_9',
    usage: { inputTokens: 20, cachedInputTokens: 4, outputTokens: 7 } });
  assert.equal(body.id, 'resp_9', 'the parsed envelope is kept for runRaw callers');
  assert.equal(calls[0].url, OPENAI_RESPONSES_URL);
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-synthetic');
  assert.equal(calls[0].init.headers['x-client-request-id'], 'att-1');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.body.includes('sk-synthetic'), false);
  assert.equal(JSON.parse(calls[0].init.body).store, false);

  assert.equal(parseOpenAiResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }).status, 'refused');
  assert.equal(parseOpenAiResponse({ status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } }).usage, null,
    'missing cache breakdown is unknown, not zero');
});

test('OpenAI adapter: HTTP and transport errors carry billing certainty', async () => {
  const cases = [[401, 'auth_error', 'not_billed'], [429, 'rate_limit', 'not_billed'], [404, 'model_unavailable', 'not_billed'],
    [500, 'server_error', 'maybe_billed'], [408, 'timeout', 'maybe_billed'],
    [413, 'bad_request', 'not_billed'], [409, 'bad_request', 'not_billed'], [415, 'bad_request', 'not_billed']];
  for (const [status, code, billing] of cases) {
    const adapter = createOpenAiAdapter({ apiKey: 'k', fetchImpl: fakeFetch(() => jsonResponse({ error: { message: 'secret detail' } }, status)).impl });
    await assert.rejects(adapter.invoke({ model: 'm', revision: null, request, attemptId: 'a', signal: new AbortController().signal }),
      e => e.code === code && e.billing === billing && !e.message.includes('secret detail'));
  }
  const broken = createOpenAiAdapter({ apiKey: 'k', fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(broken.invoke({ model: 'm', revision: null, request, attemptId: 'a', signal: new AbortController().signal }),
    e => e.code === 'network_error' && e.billing === 'maybe_billed');
  const huge = createOpenAiAdapter({ apiKey: 'k', fetchImpl: async () => new Response('x'.repeat(MAX_PROVIDER_RESPONSE_BYTES + 1)) });
  await assert.rejects(huge.invoke({ model: 'm', revision: null, request, attemptId: 'a', signal: new AbortController().signal }),
    e => e.code === 'invalid_response');
  assert.throws(() => createOpenAiAdapter({ apiKey: '' }), e => e.code === 'auth_error');
});

test('Anthropic adapter (inactive) works against a synthetic endpoint only', async () => {
  const { impl, calls } = fakeFetch(() => jsonResponse({
    id: 'msg_1', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }],
    usage: { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 5, output_tokens: 3 },
  }));
  const adapter = createAnthropicAdapter({ apiKey: 'synthetic', fetchImpl: impl });
  const reply = await adapter.invoke({ model: 'a-1', revision: null, request, attemptId: 'a', signal: new AbortController().signal });
  assert.equal(reply.status, 'completed');
  assert.deepEqual(reply.usage, { inputTokens: 17, cachedInputTokens: 2, outputTokens: 3 });
  assert.equal(calls[0].init.headers['x-api-key'], 'synthetic');
});

// ---------------------------------------------------------------- SC-021-A2

test('A2 flag: the gateway is used only when AI_GATEWAY_ENABLED is exactly "true"', () => {
  assert.equal(isAiGatewayEnabled('true'), true);
  for (const value of [undefined, '', 'false', 'TRUE', '1', 'yes', ' true']) assert.equal(isAiGatewayEnabled(value), false, String(value));
});

test('A2: a circular or unserialisable output schema is invalid_request and never reaches the provider', async () => {
  const calls = [];
  const gw = createAiGateway({ policy: policyWith({ cv_screening: route() }), adapters: [fakeAdapter([], calls)], authorize: allow });
  const circular = { type: 'object' }; circular.self = circular;
  await assert.rejects(gw.run(ctx, { ...request, jsonSchema: { name: 's', schema: circular } }),
    e => e instanceof AiGatewayError && e.code === 'invalid_request');
  await assert.rejects(gw.run(ctx, { ...request, jsonSchema: { name: 's', schema: { max: 10n } } }),
    e => e instanceof AiGatewayError && e.code === 'invalid_request');
  await assert.rejects(gw.runRaw(ctx, { ...request, jsonSchema: { name: 's', schema: circular } }), e => e.code === 'invalid_request');
  assert.equal(calls.length, 0);
});

test('A2: runRaw returns refused and incomplete answers with the provider envelope; run still throws', async () => {
  const records = [];
  const envelope = { id: 'resp_r', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
  const gw = createRaw({
    policy: policyWith({ cv_screening: route({ maxAttempts: 1 }) }), authorize: allow,
    adapters: [fakeAdapter([
      { status: 'incomplete', outputText: null, usage: null, providerRequestId: 'resp_r', body: envelope },
      { status: 'refused', outputText: null, usage: null, providerRequestId: 'resp_s', body: { id: 'resp_s' } },
      { status: 'incomplete', outputText: null, usage: null, providerRequestId: 'resp_t', body: envelope },
    ])],
    onAttempt: async r => { records.push(r); },
  });
  const raw = await gw.runRaw(ctx, request);
  assert.equal(raw.status, 'incomplete');
  assert.equal(raw.providerBody, envelope);
  assert.equal(raw.outputText, null);
  assert.equal(raw.attempts, 1);
  const refused = await gw.runRaw(ctx, request);
  assert.equal(refused.status, 'refused');
  await assert.rejects(gw.run(ctx, request), e => e.code === 'incomplete');
  assert.deepEqual(records.map(r => r.outcome), ['incomplete', 'refused', 'incomplete']);
  for (const r of records) assert.equal(Object.hasOwn(r, 'body') || Object.hasOwn(r, 'providerBody'), false, 'envelope never reaches the attempt hook');
});

test('A2: provider rejections carry the HTTP status, so callers keep their own status mapping', async () => {
  for (const [status, code] of [[401, 'auth_error'], [404, 'model_unavailable'], [418, 'bad_request'], [504, 'server_error'], [408, 'timeout']]) {
    const adapter = createOpenAiAdapter({ apiKey: 'k', fetchImpl: fakeFetch(() => jsonResponse({}, status)).impl });
    await assert.rejects(adapter.invoke({ model: 'm', revision: null, request, attemptId: 'a', signal: new AbortController().signal }),
      e => e.code === code && e.httpStatus === status);
  }
  assert.equal(new AiGatewayError('timeout', 'maybe_billed').httpStatus, undefined);
  assert.equal(new AiGatewayError('timeout', 'maybe_billed', 99).httpStatus, undefined);
});

test('A2: the adapter response cap can be lowered for a caller, never raised', async () => {
  const small = createOpenAiAdapter({ apiKey: 'k', maxResponseBytes: 100, fetchImpl: async () => new Response('x'.repeat(101)) });
  await assert.rejects(small.invoke({ model: 'm', revision: null, request, attemptId: 'a', signal: new AbortController().signal }),
    e => e.code === 'invalid_response');
  assert.throws(() => createOpenAiAdapter({ apiKey: 'k', maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES + 1 }));
  assert.throws(() => createOpenAiAdapter({ apiKey: 'k', maxResponseBytes: 0 }));
});

test('A2: a null tenant is accepted only explicitly (worker claim); missing stays invalid', async () => {
  const seen = [];
  const gw = createAiGateway({ policy: policyWith({ cv_screening: route() }), adapters: [fakeAdapter([completed()])],
    authorize: async c => { seen.push(c.companyId); return true; } });
  const records = [];
  const gw2 = createRaw({ policy: policyWith({ cv_screening: route() }), adapters: [fakeAdapter([completed()])], authorize: allow,
    onAttempt: async r => { records.push(r); } });
  await gw.run({ ...ctx, companyId: null }, request);
  assert.deepEqual(seen, [null]);
  await gw2.run({ ...ctx, companyId: null }, request);
  assert.equal(records[0].companyId, null);
  const { companyId, ...withoutCompany } = ctx;
  await assert.rejects(gw.run(withoutCompany, request), e => e.code === 'invalid_context');
  await assert.rejects(gw.run({ ...ctx, companyId: '' }, request), e => e.code === 'invalid_context');
});

// Review condition from SC-021-A: measure the contact-data guard on realistic single-CV payloads
// and recruiter-typed criteria before routing screening through the gateway with it on.
const realisticCvs = [
  ['Anna Kowalska\nTel. +48 600 123 456 | anna.kowalska@example.com\nDoświadczenie\n2019-03 – 2024-06 Specjalistka ds. sprzedaży, Firma X Sp. z o.o.\n'
    + 'Zwiększyłam sprzedaż o 35% (z 1 200 000 zł do 1 620 000 zł).\nNIP firmy: 123-456-32-18, KRS 0000123456\nKontakt: tel. 22 123 45 67, www.example.com\n'
    + 'Wykształcenie: 2014–2019 SGH, ekonomia', ['Anna', 'Kowalska']],
  ['Jan Nowak  | 500-123-456 | jan@nowak.pl\n2015 - 2018 Księgowy, 2018 - 2024 Główny księgowy\nBudżet działu 2 500 000 zł; obsługa 150 klientów; faktury 3000/mies.\n'
    + 'PESEL 90010112345\nKod pocztowy 00-950 Warszawa, ul. Prosta 12/4\nUmiejętności: SAP FI, Excel (VBA), Power BI; certyfikat ACCA F3 (2020)', ['Jan', 'Nowak']],
  ['Piotr Wiśniewski\n+44 7700 900123 · piotr.w@mail.co.uk\nSenior Java Developer 01.2020 – obecnie\n- migracja 40 mikroserwisów, SLA 99,95%\n'
    + '- zespół 8 osób, budżet projektu 3,2 mln zł\nJava 17, Spring Boot 3, Kafka, PostgreSQL 15, AWS (EKS, RDS)', ['Piotr', 'Wiśniewski']],
];
const typicalCriteria = [
  { id: 'task:1', kind: 'task', text: 'Przygotowanie raportów sprzedaży w Excelu i Power BI' },
  { id: 'kpi:1', kind: 'kpi', text: 'Sprzedaż 2 500 000 zł rocznie, marża min. 18%' },
  { id: 'kpi:2', kind: 'kpi', text: 'Obsługa min. 150 klientów, NPS > 40' },
  { id: 'competency:1', kind: 'competency', text: 'Kontakt z klientem przez telefon i e-mail' },
  { id: 'task:2', kind: 'task', text: 'Raporty dla 3 regionów w latach 2019-2024, zespół 12 osób' },
];

test('A2 guard parity: redacted single CVs with typical criteria pass the contact-data detector', () => {
  for (const [source, names] of realisticCvs) {
    const redacted = suggestRedaction(source, names);
    const user = JSON.stringify(screeningAllowlistPayload({ payload_schema_version: 1, input_cv_text_snapshot: redacted, criteria_snapshot: typicalCriteria }));
    assert.equal(containsContactData(user), false, redacted);
    // The unredacted CV is caught, so the detector is not simply blind to this text.
    assert.equal(containsContactData(source), true);
  }
});

test('A2 guard parity: recruiter-typed 9-digit figures read as phone numbers, so the guard is off per route', () => {
  // Analyses with such criteria succeed today; with the guard on they would end as payload_not_redacted,
  // which screening has no error code for. Hence the deliberate per-route choice in default-policy.ts.
  for (const text of ['Zarządzanie budżetem 500 000 000 zł', 'Wolumen 600 000 000 transakcji rocznie']) {
    assert.equal(containsContactData(JSON.stringify({ criteria: [{ id: 'kpi:9', kind: 'kpi', text }] })), true, text);
  }
  assert.equal(defaultAiPolicy.routes.cv_screening.blockContactData, false);
  assert.equal(defaultAiPolicy.routes.exercise_generation.blockContactData, false);
  // Backstop only: a 100 000-character CV of two-byte Polish letters plus JSON escaping must still fit.
  assert.ok(defaultAiPolicy.routes.cv_screening.maxInputBytes >= 2 * 100_000 * 3);
});

test('A2 bridge: existing request bodies round-trip byte for byte, tampered bodies are refused', () => {
  const claim = {
    payload_schema_version: 1, result_schema_version: 2, input_cv_text_snapshot: 'SQL i raporty.\n"cytat"',
    criteria_snapshot: [{ id: 'task:1', kind: 'task', text: 'Analiza danych' }],
  };
  const bodies = [
    buildScreeningOpenAiRequest(claim),
    buildScreeningOpenAiRequest({ ...claim, result_schema_version: 1 }),
    buildExerciseDraftRequest(exerciseDraftPayload({
      position: { title: 'Planista', description: null, tasks: ['Plan produkcji'], kpis: [], autonomy_level: 2,
        required_competencies: ['Planowanie'], required_behaviors: [] },
      company: null,
    })),
  ];
  for (const body of bodies) {
    const { model, request: bridged } = gatewayRequestFromResponsesBody(body);
    assert.equal(JSON.stringify(buildOpenAiResponsesBody(model, bridged)), JSON.stringify(body));
  }
  const good = bodies[0];
  for (const bad of [
    { ...good, temperature: 0 },
    { ...good, store: true },
    { ...good, input: [good.input[0]] },
    { ...good, input: [good.input[0], { role: 'assistant', content: 'x' }] },
    { ...good, text: { format: { ...good.text.format, strict: false } } },
    { ...good, reasoning: { effort: 'max' } },
    null, 'body',
  ]) {
    assert.throws(() => gatewayRequestFromResponsesBody(bad), e => e instanceof AiGatewayError && e.code === 'invalid_request');
  }
});

test('A2: both wired routes are pinned to the models their result contracts name', () => {
  assert.equal(pinnedRouteModel(defaultAiPolicy, 'cv_screening'), SCREENING_OPENAI_MODEL);
  assert.equal(pinnedRouteModel(defaultAiPolicy, 'exercise_generation'), EXERCISE_AI_MODEL);
  assert.equal(pinnedRouteModel(defaultAiPolicy, 'report_summary'), null, 'no route');
  assert.equal(pinnedRouteModel(policyWith({ cv_screening: route() }), 'cv_screening'), null, 'not pinned');
});

test('A2: the attempt log line carries no prompt, payload or provider body', async () => {
  const lines = [];
  const gw = createRaw({ policy: policyWith({ cv_screening: route() }), authorize: allow,
    adapters: [fakeAdapter([{ ...completed('{"secret":"CV text"}'), body: { output_text: 'CV text' } }])],
    onAttempt: async r => { lines.push(JSON.stringify(attemptLogEntry(r))); } });
  await gw.runRaw(ctx, { ...request, user: '{"cv_text":"Unikalny tekst CV 4711"}' });
  assert.equal(lines.length, 1);
  for (const marker of ['Unikalny', '4711', 'CV text', 'Evaluate.', 'secret']) assert.equal(lines[0].includes(marker), false, marker);
  assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(), ['attempt', 'attempt_id', 'billing', 'cached_input_tokens', 'company_id', 'event',
    'input_tokens', 'latency_ms', 'model', 'model_key', 'operation_id', 'outcome', 'output_tokens', 'policy_version', 'provider',
    'provider_request_id', 'task'].sort());
});
