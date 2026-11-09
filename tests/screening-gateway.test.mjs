// SC-021-A2: CV screening through the AI gateway must behave exactly like the direct path.
// Synthetic only: fake fetch, no network, no keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { screeningAnalysisContractHash } from '../lib/screening.ts';
import {
  SCREENING_OPENAI_MAX_RETRIES, SCREENING_OPENAI_MODEL, buildScreeningOpenAiRequest,
  screeningAiContract, screeningEvidenceAiContract,
} from '../lib/screening-ai.ts';
import { callOpenAiResponses, runScreeningAttempt } from '../lib/screening-worker.ts';
import { createScreeningGatewayCall, screeningErrorFromGateway } from '../lib/screening-gateway.ts';
import { AiGatewayError } from '../lib/ai-gateway/contract.ts';
import { validatePolicy } from '../lib/ai-gateway/policy.ts';
import { defaultAiPolicy } from '../lib/ai-gateway/default-policy.ts';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const COMPANY = 'c1111111-1111-4111-8111-111111111111';
const claimV1 = {
  analysis_id: 'a1111111-1111-4111-8111-111111111111',
  // SC-021-B: bound by the worker from the database in the claim transaction.
  company_id: COMPANY,
  attempt_id: 'a2222222-2222-4222-8222-222222222222',
  lease_token: 'a'.repeat(64),
  lease_expires_at: '2026-11-09T12:10:00Z',
  input_fingerprint: 'b'.repeat(64),
  analysis_contract_hash: screeningAnalysisContractHash(screeningAiContract),
  payload_schema_version: 1, result_schema_version: 1, prompt_version: 'screening-v1',
  provider: 'openai', model: SCREENING_OPENAI_MODEL, model_revision: null,
  input_cv_text_snapshot: 'A😀B𝄞C SQL i raporty.\n"Zespół" [TELEFON / IDENTYFIKATOR]',
  criteria_snapshot: [
    { id: 'task:1', kind: 'task', text: 'Analiza danych' },
    { id: 'kpi:1', kind: 'kpi', text: 'Budżet 500 000 000 zł' },
  ],
};
const claimV2 = {
  ...claimV1,
  candidate_document_id: '5c04044b-57c5-4b66-b77d-99b95f117015',
  analysis_contract_hash: screeningAnalysisContractHash(screeningEvidenceAiContract),
  result_schema_version: 2, prompt_version: screeningEvidenceAiContract.prompt_version,
  input_cv_text_snapshot: 'Zarządzał „CRM”  i wdrożeniami.',
  criteria_snapshot: [{ id: 'task:1', kind: 'task', text: 'CRM' }],
};
const successV1 = JSON.stringify({ criteria: [
  { criterion_id: 'task:1', rating: 'meets', evidence_quotes: ['😀B𝄞'], explanation: 'SQL.' },
  { criterion_id: 'kpi:1', rating: 'insufficient_data', evidence_quotes: [], explanation: '' },
] });
const successV2 = JSON.stringify({ criteria: [{ criterion_id: 'task:1', verdict: 'supported',
  evidence_quotes: ['"CRM" i wdrożeniami'], missing_info: '', suggested_question: '', explanation: 'Wskazane w CV' }] });
const completed = text => ({
  id: 'resp_1', status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
  usage: { input_tokens: 120, output_tokens: 40, input_tokens_details: { cached_tokens: 8 } },
});

function fakeFetch(respond) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return respond(calls.length, init);
  };
  return { impl, calls };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function storeFor(claim) {
  const calls = { complete: [], fail: [] };
  return {
    calls,
    store: {
      claim: async () => claim,
      complete: async input => { calls.complete.push(input); return claim.analysis_id; },
      fail: async input => { calls.fail.push(input); return claim.analysis_id; },
    },
  };
}

/** Runs one worker attempt through either path against the same fake provider. */
async function runPath(path, claim, respond, extra = {}) {
  const { impl, calls: fetches } = fakeFetch(respond);
  const { store, calls } = storeFor(claim);
  const logs = [], gatewayLogs = [], sleeps = [], ledger = [];
  const timeoutMs = extra.timeoutMs ?? 60000;
  const policy = extra.policy ?? defaultAiPolicy;
  const viaGateway = createScreeningGatewayCall({
    apiKey: extra.apiKey ?? 'sk-synthetic', fetchImpl: impl, policy, now: () => NOW, log: e => gatewayLogs.push(e),
    recordAttempt: extra.recordAttempt ?? (async p => { ledger.push(p); }),
  });
  const result = await runScreeningAttempt(claim.attempt_id, {
    enabled: true, store,
    callOpenAi: path === 'gateway'
      ? (request, c) => viaGateway(request, c)
      : request => callOpenAiResponses(extra.apiKey ?? 'sk-synthetic', request, impl, timeoutMs),
    sleep: async ms => { sleeps.push(ms); },
    log: entry => logs.push(entry),
    now: () => NOW,
  });
  return { result, fetches, calls, logs, gatewayLogs, sleeps, ledger };
}

const comparable = run => ({
  result: run.result,
  providerCalls: run.fetches.length,
  sleeps: run.sleeps,
  complete: run.calls.complete,
  fail: run.calls.fail,
  logs: run.logs.map(({ duration_ms, ...rest }) => JSON.parse(JSON.stringify(rest))),
});

test('screening analysis contract hashes are unchanged by A2', () => {
  assert.equal(screeningAnalysisContractHash(screeningEvidenceAiContract), '18f0227fcfb301a3962cf1163cbfa3b28ae5b173e9c41bfde92a4179b51883d5');
  assert.equal(screeningAnalysisContractHash(screeningAiContract), '68cc0c54f53a328d38177313d5976b0f93e7bbc75c1997f6c95344df2d683f32');
});

test('gateway path sends the same request body, byte for byte, for v1 and v2 claims', async () => {
  for (const [claim, text] of [[claimV1, successV1], [claimV2, successV2]]) {
    const direct = await runPath('direct', claim, () => json(completed(text)));
    const gateway = await runPath('gateway', claim, () => json(completed(text)));
    const expected = JSON.stringify(buildScreeningOpenAiRequest(claim));
    assert.equal(direct.fetches[0].init.body, expected);
    assert.equal(gateway.fetches[0].init.body, expected);
    assert.equal(gateway.fetches[0].url, direct.fetches[0].url);
    assert.equal(gateway.fetches[0].init.headers.authorization, 'Bearer sk-synthetic');
    assert.equal(gateway.result.status, 'completed');
    assert.deepEqual(comparable(gateway), comparable(direct), 'same findings, usage, provider ids and logs');
  }
});

test('gateway path maps every HTTP failure to the same code, retries and logs as the direct path', async () => {
  for (const status of [400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504]) {
    const direct = await runPath('direct', claimV1, () => json({ error: { message: 'secret provider detail' } }, status));
    const gateway = await runPath('gateway', claimV1, () => json({ error: { message: 'secret provider detail' } }, status));
    assert.deepEqual(comparable(gateway), comparable(direct), `HTTP ${status}`);
    assert.ok(!JSON.stringify(gateway.logs).includes('secret provider detail'));
  }
});

test('gateway path matches the direct path for transport failures and envelope edge cases', async () => {
  const cases = {
    'network error': () => { throw new TypeError('fetch failed'); },
    'non-JSON body': () => new Response('not json', { status: 200 }),
    'refusal item': () => json({ status: 'completed', output: [{ type: 'refusal', refusal: 'no' }] }),
    'refusal part': () => json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }),
    'output_text wins over a refusal': () => json({ status: 'completed', output_text: successV1, output: [{ type: 'refusal' }] }),
    'token limit': () => json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
    'content filter': () => json({ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }),
    'other incomplete': () => json({ status: 'incomplete', incomplete_details: { reason: 'other' } }),
    'bad usage': () => json({ status: 'completed', usage: { input_tokens: 'x' }, output_text: successV1 }),
    'empty output': () => json({ status: 'completed', output: [] }),
    'output not JSON': () => json({ status: 'completed', output_text: 'nope' }),
    'quote mismatch': () => json(completed(successV1.replace('😀B𝄞', 'XYZ'))),
    'text part type': () => json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'text', text: successV1 }] }] }),
    'flaky then ok': n => n < 3 ? json({}, 503) : json(completed(successV1)),
  };
  for (const [name, respond] of Object.entries(cases)) {
    const direct = await runPath('direct', claimV1, respond);
    const gateway = await runPath('gateway', claimV1, respond);
    assert.deepEqual(comparable(gateway), comparable(direct), name);
  }
});

test('gateway path times out and retries like the direct path', async () => {
  const policy = validatePolicy({
    ...JSON.parse(JSON.stringify(defaultAiPolicy)),
    routes: { cv_screening: { ...defaultAiPolicy.routes.cv_screening, timeoutMs: 1000 } },
  });
  const hanging = (_, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  const direct = await runPath('direct', claimV1, hanging, { timeoutMs: 1000 });
  const gateway = await runPath('gateway', claimV1, hanging, { policy });
  assert.equal(gateway.result.code, 'openai_timeout');
  assert.equal(gateway.fetches.length, SCREENING_OPENAI_MAX_RETRIES + 1);
  assert.deepEqual(comparable(gateway), comparable(direct));
});

test('every physical attempt is logged without CV text, criteria, prompt or key', async () => {
  const run = await runPath('gateway', claimV1, n => n < 2 ? json({}, 500) : json(completed(successV1)));
  assert.equal(run.gatewayLogs.length, 2);
  assert.deepEqual(run.gatewayLogs.map(l => [l.attempt, l.outcome, l.billing]), [[1, 'server_error', 'maybe_billed'], [1, 'completed', 'billed']]);
  for (const l of run.gatewayLogs) {
    assert.equal(l.operation_id, claimV1.attempt_id);
    assert.equal(l.company_id, COMPANY);
    assert.equal(l.task, 'cv_screening');
  }
  assert.notEqual(run.gatewayLogs[0].attempt_id, run.gatewayLogs[1].attempt_id);
  const text = JSON.stringify(run.gatewayLogs);
  for (const secret of ['SQL i raporty', 'Analiza danych', 'Budżet', 'sk-synthetic', claimV1.lease_token, 'redacted CV']) {
    assert.equal(text.includes(secret), false, secret);
  }
});

test('the worker claim is the trusted context: an expired lease or a foreign model never reaches the provider', async () => {
  for (const [claim, code] of [
    [{ ...claimV1, lease_expires_at: '2026-11-09T11:59:59Z' }, 'worker_internal_error'],
    [{ ...claimV1, lease_expires_at: 'not a date' }, 'worker_internal_error'],
    [{ ...claimV1, lease_token: '' }, 'worker_internal_error'],
  ]) {
    const run = await runPath('gateway', claim, () => json(completed(successV1)));
    assert.equal(run.fetches.length, 0);
    assert.equal(run.result.code, code);
    assert.equal(run.calls.fail.length, 1);
    assert.equal(run.sleeps.length, 0, 'refused before provider I/O: never retried');
  }
  const viaGateway = createScreeningGatewayCall({ apiKey: 'k', now: () => NOW, log: () => {}, recordAttempt: async () => {},
    fetchImpl: async () => { throw new Error('must not be called'); } });
  await assert.rejects(viaGateway({ ...buildScreeningOpenAiRequest(claimV1), model: 'gpt-other' }, claimV1),
    e => e.code === 'contract_mismatch');
  await assert.rejects(viaGateway(buildScreeningOpenAiRequest(claimV1), { ...claimV1, model: 'gpt-other' }),
    e => e.code === 'contract_mismatch');
});

test('a policy that is not pinned to the contract model is refused before provider I/O', async () => {
  const policy = validatePolicy({
    version: 'other-1',
    models: { m: { provider: 'openai', model: 'gpt-something-else', revision: null, quality: 'standard', costRank: 1, enabled: true } },
    routes: { cv_screening: { ...defaultAiPolicy.routes.cv_screening, candidates: ['m'] } },
  });
  const run = await runPath('gateway', claimV1, () => json(completed(successV1)), { policy });
  assert.equal(run.fetches.length, 0);
  assert.equal(run.result.code, 'contract_mismatch');
});

test('a missing API key fails as an auth error, as before', async () => {
  const run = await runPath('gateway', claimV1, () => json({}, 401), { apiKey: '' });
  assert.equal(run.fetches.length, 0);
  assert.equal(run.result.code, 'openai_auth_error');
  assert.equal(run.sleeps.length, 0);
});

test('a failing attempt hook or unknown gateway error is never retried', () => {
  assert.equal(screeningErrorFromGateway(new Error('SC021_ATTEMPT_HOOK_TIMEOUT')).code, 'worker_internal_error');
  for (const code of ['unauthorized', 'invalid_context', 'route_disabled', 'no_available_model', 'payload_too_large', 'payload_not_redacted', 'invalid_request']) {
    assert.equal(screeningErrorFromGateway(new AiGatewayError(code)).code, 'worker_internal_error', code);
  }
});

test('the Edge worker uses the gateway only behind AI_GATEWAY_ENABLED and keeps the direct call otherwise', () => {
  const source = readFileSync('supabase/functions/screening-worker/index.ts', 'utf8');
  assert.match(source, /isAiGatewayEnabled\(env\("AI_GATEWAY_ENABLED"\)\)/);
  assert.match(source, /viaGateway \? viaGateway\(request, claim\) : callOpenAiResponses\(apiKey, request\)/);
});

test('a Deno-style connection error is retried as a network error; a body broken after 200 is not retried', async () => {
  const connect = await runPath('gateway', claimV1, () => { throw new TypeError('error sending request for url (https://api.openai.com/v1/responses): client error (Connect)'); });
  assert.equal(connect.result.code, 'openai_network_error');
  assert.equal(connect.fetches.length, SCREENING_OPENAI_MAX_RETRIES + 1);
  const broken = await runPath('gateway', claimV1, () => new Response(new ReadableStream({ pull(c) { c.error(new TypeError('terminated')); } })));
  assert.equal(broken.result.code, 'openai_invalid_output');
  assert.equal(broken.fetches.length, 1, 'the model already ran: never pay twice');
});

test('SC-021-B: every physical attempt is written to the ledger with the claim tenant and without the provider request id', async () => {
  const run = await runPath('gateway', claimV1, n => n < 2 ? json({}, 500) : json(completed(successV1)));
  assert.equal(run.result.status, 'completed');
  assert.deepEqual(run.ledger.map(p => [p.company_id, p.operation_id, p.task, p.outcome, p.billing, p.input_tokens, p.provider_request_id]), [
    [COMPANY, claimV1.attempt_id, 'cv_screening', 'server_error', 'maybe_billed', null, null],
    [COMPANY, claimV1.attempt_id, 'cv_screening', 'completed', 'billed', 120, null],
  ]);
  assert.equal(new Set(run.ledger.map(p => p.attempt_id)).size, 2, 'each retry has its own attempt id');
  const text = JSON.stringify(run.ledger);
  for (const secret of ['SQL i raporty', 'Analiza danych', 'sk-synthetic', claimV1.lease_token]) assert.equal(text.includes(secret), false, secret);
});

test('SC-021-B: a claim without a database-bound tenant never reaches the provider', async () => {
  for (const company_id of [undefined, null, '', 'not-a-uuid']) {
    const run = await runPath('gateway', { ...claimV1, company_id }, () => json(completed(successV1)));
    assert.equal(run.fetches.length, 0);
    assert.equal(run.result.code, 'worker_internal_error');
    assert.equal(run.sleeps.length, 0);
    assert.equal(run.ledger.length, 0);
  }
});

test('SC-021-B: an attempt that cannot be recorded fails the analysis without another provider call', async () => {
  const run = await runPath('gateway', claimV1, () => json(completed(successV1)), { recordAttempt: async () => { throw new Error('db down'); } });
  assert.equal(run.fetches.length, 1);
  assert.equal(run.result.code, 'worker_internal_error');
  assert.equal(run.calls.complete.length, 0, 'unrecorded work is never returned as a result');
  assert.equal(run.sleeps.length, 0, 'not retried: the model may already have been billed');
  assert.equal(screeningErrorFromGateway(new AiGatewayError('ledger_error', 'maybe_billed')).code, 'worker_internal_error');
});

test('SC-021-B: the Edge worker binds the tenant in the claim transaction and records attempts as screening_worker', () => {
  const source = readFileSync('supabase/functions/screening-worker/index.ts', 'utf8');
  assert.match(source, /select public\.screening_attempt_tenant\(\$\{attemptId\}::uuid\) as company_id/);
  assert.match(source, /return \{ \.\.\.claimed, company_id: tenant\[0\]\?\.company_id \?\? null \};/);
  assert.match(source, /store: gatewayEnabled \? withClaimTenant\(sql, workerStore\(sql\)\) : workerStore\(sql\)/);
  assert.match(source, /set local role screening_worker"\);\n\s*await tx`select public\.record_screening_ai_attempt\(\$\{tx\.json\(payload\)\}::jsonb\)`/);
});
