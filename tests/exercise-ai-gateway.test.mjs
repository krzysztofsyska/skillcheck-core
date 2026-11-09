// SC-021-A2: exercise generation through the AI gateway must behave exactly like the direct path.
// Synthetic only: fake fetch, no network, no keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { requestExerciseDraft, requestExerciseDraftViaGateway, exerciseErrorFromGateway } from '../lib/exercise-ai-provider.ts';
import { buildExerciseDraftRequest, exerciseDraftPayload, EXERCISE_AI_MAX_RESPONSE_CHARS } from '../lib/exercise-ai.ts';
import { AiGatewayError } from '../lib/ai-gateway/contract.ts';
import { validatePolicy } from '../lib/ai-gateway/policy.ts';
import { defaultAiPolicy } from '../lib/ai-gateway/default-policy.ts';

const COMPANY = 'aaaaaaaa-1111-4222-8333-444444444444';
const RECRUITMENT = 'bbbbbbbb-1111-4222-8333-444444444444';
const REQUEST_KEY = 'cccccccc-1111-4222-8333-444444444444';
const ledgerWrites = [];
const trust = { companyId: COMPANY, operationId: REQUEST_KEY, recruitmentId: RECRUITMENT, mayGenerate: true,
  recordAttempt: async p => { ledgerWrites.push(p); } };
const position = { id: 'position', updated_at: '2026-11-07T00:00:00Z', title: 'Planista', tasks: ['Planowanie'],
  required_competencies: ['Planowanie'], kpis: [], required_behaviors: [], autonomy_level: 2 };
// A company profile with a legitimate office phone and e-mail: drafts like this succeed today.
const company = { industry: 'Logistyka', description: 'Biuro: tel. 22 600 12 34, hr@firma.example', work_environment: null,
  company_values: ['Rzetelność'], size_band: '11-50' };
const payload = exerciseDraftPayload({ position, company });
const output = { title: 'Plan', instructions: 'Przygotuj plan działania.', expectedOutput: 'Plan.', durationMinutes: 20,
  criteria: [{ competency: 'Planowanie', below: 'Pomija terminy.', meets: 'Podaje terminy.', above: 'Uwzględnia ryzyka.' }] };

function fakeFetch(respond) {
  const calls = [];
  return { calls, impl: async (url, init) => { calls.push({ url, init }); return respond(init); } };
}
const silent = () => {};

/** Outcome of one call: the result, or the error code. */
async function outcome(promise) {
  try { return { ok: await promise }; } catch (error) { return { code: error.code, ctor: error.constructor.name }; }
}

async function bothPaths(respond) {
  const direct = fakeFetch(respond), gateway = fakeFetch(respond);
  return {
    direct: { ...(await outcome(requestExerciseDraft(payload, 'synthetic-key', direct.impl))), calls: direct.calls },
    gateway: { ...(await outcome(requestExerciseDraftViaGateway(payload, 'synthetic-key', trust, { fetcher: gateway.impl, log: silent }))), calls: gateway.calls },
  };
}

test('gateway path sends the same body, byte for byte, and parses the same draft', async () => {
  const { direct, gateway } = await bothPaths(() => Response.json({ id: 'resp_e', status: 'completed', output_text: JSON.stringify(output),
    usage: { input_tokens: 10, output_tokens: 20 } }));
  assert.equal(gateway.calls.length, 1);
  assert.equal(gateway.calls[0].init.body, JSON.stringify(buildExerciseDraftRequest(payload)));
  assert.equal(gateway.calls[0].init.body, direct.calls[0].init.body);
  assert.equal(gateway.calls[0].url, direct.calls[0].url);
  assert.equal(gateway.calls[0].init.redirect, 'error');
  assert.deepEqual(gateway.ok, direct.ok);
  assert.equal(gateway.ok.definition.kind, 'competency_test');
});

test('gateway path maps failures to the same codes as the direct path, with exactly one attempt', async () => {
  const cases = {};
  for (const status of [400, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503, 504]) cases[`HTTP ${status}`] = () => new Response('secret', { status });
  Object.assign(cases, {
    'network error': () => { throw new TypeError('fetch failed'); },
    'non-JSON body': () => new Response('nope'),
    'oversized body': () => new Response('x'.repeat(EXERCISE_AI_MAX_RESPONSE_CHARS * 4 + 1)),
    'refusal': () => Response.json({ status: 'completed', output: [{ type: 'refusal' }] }),
    'refusal next to output_text': () => Response.json({ status: 'completed', output_text: JSON.stringify(output), output: [{ type: 'message', content: [{ refusal: 'no' }] }] }),
    'content filter': () => Response.json({ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }),
    'incomplete': () => Response.json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
    'bad envelope': () => Response.json([]),
    'empty output': () => Response.json({ status: 'completed', output: [] }),
    'wrong competencies': () => Response.json({ status: 'completed', output_text: JSON.stringify({ ...output, criteria: [] }) }),
  });
  for (const [name, respond] of Object.entries(cases)) {
    const { direct, gateway } = await bothPaths(respond);
    assert.ok(direct.code, `${name}: direct path fails`);
    assert.equal(gateway.code, direct.code, name);
    assert.equal(gateway.ctor, 'ExerciseAiError', name);
    assert.equal(gateway.calls.length, direct.calls.length, `${name}: same number of provider calls`);
    assert.ok(gateway.calls.length <= 1, `${name}: never retried`);
  }
});

test('gateway path times out like the direct path', async () => {
  const policy = validatePolicy({
    ...JSON.parse(JSON.stringify(defaultAiPolicy)),
    routes: { exercise_generation: { ...defaultAiPolicy.routes.exercise_generation, timeoutMs: 1000 } },
  });
  const hanging = fakeFetch(init => new Promise((_, reject) =>
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
  await assert.rejects(requestExerciseDraftViaGateway(payload, 'k', trust, { fetcher: hanging.impl, policy, log: silent }),
    e => e.code === 'exercise_ai_timeout');
  assert.equal(hanging.calls.length, 1);
});

test('authorization uses only the trusted server context', async () => {
  for (const bad of [
    { ...trust, mayGenerate: false },
    { ...trust, mayGenerate: 'true' },
    { ...trust, companyId: 'not-a-uuid' },
    { ...trust, operationId: 'not-a-uuid' },
    { ...trust, recruitmentId: 'not-a-uuid' },
  ]) {
    const f = fakeFetch(() => Response.json({ status: 'completed', output_text: JSON.stringify(output) }));
    await assert.rejects(requestExerciseDraftViaGateway(payload, 'k', bad, { fetcher: f.impl, log: silent }),
      e => e.code === 'exercise_ai_auth_error');
    assert.equal(f.calls.length, 0);
  }
});

test('missing key and oversized requests never reach the provider', async () => {
  const f = fakeFetch(() => Response.json({}));
  await assert.rejects(requestExerciseDraftViaGateway(payload, '', trust, { fetcher: f.impl, log: silent }), e => e.code === 'exercise_ai_auth_error');
  const big = exerciseDraftPayload({ position, company: null });
  big.untrusted_position.description = 'a'.repeat(50_000);
  await assert.rejects(requestExerciseDraftViaGateway(big, 'k', trust, { fetcher: f.impl, log: silent }), e => e.code === 'exercise_ai_input_too_large');
  assert.equal(f.calls.length, 0);
});

test('the attempt log carries no profile text and no key', async () => {
  const lines = [];
  const f = fakeFetch(() => Response.json({ status: 'completed', output_text: JSON.stringify(output) }));
  await requestExerciseDraftViaGateway(payload, 'sk-secret', trust, { fetcher: f.impl, log: e => lines.push(e) });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].company_id, COMPANY);
  assert.equal(lines[0].operation_id, REQUEST_KEY);
  assert.equal(lines[0].task, 'exercise_generation');
  const text = JSON.stringify(lines);
  for (const secret of ['Planista', 'Logistyka', 'hr@firma', 'sk-secret', 'Przygotuj plan']) assert.equal(text.includes(secret), false, secret);
});

test('requestExerciseDraft uses the gateway only with trust and AI_GATEWAY_ENABLED=true', async () => {
  const previous = process.env.AI_GATEWAY_ENABLED;
  const ok = () => Response.json({ status: 'completed', output_text: JSON.stringify(output) });
  const headersOf = f => f.calls[0].init.headers;
  try {
    for (const [flag, withTrust, viaGateway] of [[undefined, true, false], ['false', true, false], ['true', false, false], ['true', true, true]]) {
      if (flag === undefined) delete process.env.AI_GATEWAY_ENABLED; else process.env.AI_GATEWAY_ENABLED = flag;
      const f = fakeFetch(ok);
      await requestExerciseDraft(payload, 'k', f.impl, withTrust ? trust : undefined);
      // The gateway adapter tags each physical attempt; the direct path never does.
      assert.equal(Object.hasOwn(headersOf(f), 'x-client-request-id'), viaGateway, `flag=${flag} trust=${withTrust}`);
    }
  } finally {
    if (previous === undefined) delete process.env.AI_GATEWAY_ENABLED; else process.env.AI_GATEWAY_ENABLED = previous;
  }
});

test('unknown gateway failures map to codes the recruiter already sees', () => {
  assert.equal(exerciseErrorFromGateway(new Error('SC021_ATTEMPT_HOOK_TIMEOUT')).code, 'exercise_ai_network_error');
  assert.equal(exerciseErrorFromGateway(new AiGatewayError('payload_too_large')).code, 'exercise_ai_input_too_large');
  for (const code of ['unauthorized', 'invalid_context', 'route_disabled', 'no_available_model', 'invalid_request', 'payload_not_redacted']) {
    assert.equal(exerciseErrorFromGateway(new AiGatewayError(code)).code, 'exercise_ai_auth_error', code);
  }
});

test('SC-021-B: each physical attempt is written to the ledger with the trusted company and no profile text', async () => {
  const writes = [];
  const f = fakeFetch(() => Response.json({ id: 'resp_ex', status: 'completed', output_text: JSON.stringify(output),
    usage: { input_tokens: 30, output_tokens: 9, input_tokens_details: { cached_tokens: 0 } } }));
  await requestExerciseDraftViaGateway(payload, 'sk-secret', { ...trust, recordAttempt: async p => { writes.push(p); } }, { fetcher: f.impl, log: silent });
  assert.equal(writes.length, 1);
  assert.deepEqual([writes[0].company_id, writes[0].operation_id, writes[0].task, writes[0].billing, writes[0].input_tokens, writes[0].provider_request_id],
    [COMPANY, REQUEST_KEY, 'exercise_generation', 'billed', 30, 'resp_ex']);
  const text = JSON.stringify(writes);
  for (const secret of ['Planista', 'Logistyka', 'hr@firma', 'sk-secret', 'Przygotuj plan']) assert.equal(text.includes(secret), false, secret);
});

test('SC-021-B: a draft whose attempt cannot be recorded is not returned, and the call is not repeated', async () => {
  const f = fakeFetch(() => Response.json({ status: 'completed', output_text: JSON.stringify(output) }));
  await assert.rejects(requestExerciseDraftViaGateway(payload, 'k', { ...trust, recordAttempt: async () => { throw new Error('PT404 Resource unavailable'); } },
    { fetcher: f.impl, log: silent }), e => e.code === 'exercise_ai_server_error' && !String(e.message).includes('PT404'));
  assert.equal(f.calls.length, 1);
  assert.equal(exerciseErrorFromGateway(new AiGatewayError('ledger_error', 'maybe_billed')).code, 'exercise_ai_server_error');
  const none = fakeFetch(() => Response.json({}));
  for (const recordAttempt of [undefined, null]) {
    await assert.rejects(requestExerciseDraftViaGateway(payload, 'k', { ...trust, recordAttempt }, { fetcher: none.impl, log: silent }),
      e => e.code === 'exercise_ai_auth_error');
  }
  assert.equal(none.calls.length, 0, 'no ledger writer, no provider call');
});

test('SC-021-B: a policy the ledger would refuse is stopped before any provider call', async () => {
  const other = validatePolicy({ ...JSON.parse(JSON.stringify(defaultAiPolicy)), version: 'sc021-unlisted' });
  const f = fakeFetch(() => Response.json({ status: 'completed', output_text: JSON.stringify(output) }));
  await assert.rejects(requestExerciseDraftViaGateway(payload, 'k', trust, { fetcher: f.impl, policy: other, log: silent }),
    e => e.code === 'exercise_ai_auth_error');
  assert.equal(f.calls.length, 0);
});
