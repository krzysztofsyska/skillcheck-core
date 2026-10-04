import test from 'node:test';
import assert from 'node:assert/strict';
import { SCREENING_OPENAI_MODEL, ScreeningProviderError } from '../lib/screening-ai.ts';
import { runScreeningAttempt } from '../lib/screening-worker.ts';

const claim = {
  analysis_id: 'a1111111-1111-4111-8111-111111111111',
  attempt_id: 'a2222222-2222-4222-8222-222222222222',
  lease_token: 'a'.repeat(64),
  lease_expires_at: '2026-10-04T17:00:00Z',
  input_fingerprint: 'b'.repeat(64),
  analysis_contract_hash: 'c'.repeat(64),
  payload_schema_version: 1,
  result_schema_version: 1,
  prompt_version: 'screening-v1',
  provider: 'openai',
  model: SCREENING_OPENAI_MODEL,
  model_revision: null,
  input_cv_text_snapshot: 'A😀B𝄞C SQL i raporty.',
  criteria_snapshot: [
    { id: 'task:1', kind: 'task', text: 'Analiza danych' },
    { id: 'kpi:1', kind: 'kpi', text: 'Terminowość' },
  ],
};

const successText = JSON.stringify({
  criteria: [
    { criterion_id: 'task:1', rating: 'meets', evidence_quotes: ['😀B𝄞'], explanation: 'SQL.' },
    { criterion_id: 'kpi:1', rating: 'insufficient_data', evidence_quotes: [], explanation: '' },
  ],
});

function storeMock(overrides = {}) {
  const calls = { complete: [], fail: [] };
  return {
    calls,
    store: {
      claim: async () => claim,
      complete: async input => { calls.complete.push(input); return claim.analysis_id; },
      fail: async input => { calls.fail.push(input); return claim.analysis_id; },
      ...overrides,
    },
  };
}

function runtime(store, callOpenAi, extra = {}) {
  return {
    enabled: true,
    store,
    callOpenAi,
    sleep: async () => {},
    log: () => {},
    ...extra,
  };
}

test('successful mocked OpenAI response completes with exact evidence offsets', async () => {
  const { store, calls } = storeMock();
  const result = await runScreeningAttempt(claim.attempt_id, runtime(store, async () => ({
    id: 'resp_1',
    status: 'completed',
    output_text: successText,
    usage: { input_tokens: 11, output_tokens: 7, input_tokens_details: { cached_tokens: 2 } },
  })));
  assert.equal(result.status, 'completed');
  assert.equal(calls.complete[0].findings[0].evidence[0].start, 1);
  assert.equal(calls.complete[0].providerResponseId, 'resp_1');
  assert.equal(calls.complete[0].cachedInputTokens, 2);
  assert.equal(calls.fail.length, 0);
});

test('refusal, invalid JSON, timeout, 429 and 500 map to fail without completing', async () => {
  const cases = [
    [{ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }, 'openai_refusal', false],
    [{ status: 'completed', output_text: '{bad' }, 'openai_invalid_output', false],
    [new ScreeningProviderError('openai_timeout', 'timed out'), 'openai_timeout', true],
    [new ScreeningProviderError('openai_rate_limit', 'rate'), 'openai_rate_limit', true],
    [new ScreeningProviderError('openai_server_error', 'server'), 'openai_server_error', true],
  ];
  for (const [payload, code, throws] of cases) {
    const { store, calls } = storeMock();
    const result = await runScreeningAttempt(claim.attempt_id, runtime(store, async () => {
      if (throws) throw payload;
      return payload;
    }));
    assert.equal(result.status, 'failed');
    assert.equal(result.code, code);
    assert.equal(calls.complete.length, 0);
    assert.equal(calls.fail[0].errorCode, code);
    assert.doesNotMatch(calls.fail[0].errorMessage, /resp_|prompt|SQL i raporty/);
  }
});

test('retryable 429 is retried then can succeed', async () => {
  const { store, calls } = storeMock();
  let tries = 0;
  const result = await runScreeningAttempt(claim.attempt_id, runtime(store, async () => {
    tries += 1;
    if (tries < 3) throw new ScreeningProviderError('openai_rate_limit', 'rate');
    return { id: 'resp_ok', status: 'completed', output_text: successText };
  }));
  assert.equal(tries, 3);
  assert.equal(result.status, 'completed');
  assert.equal(calls.fail.length, 0);
});

test('duplicate dispatch and late completion do not write a second AI result', async () => {
  const duplicate = storeMock({
    claim: async () => { throw Object.assign(new Error('Attempt is not claimable'), { code: '55000' }); },
  });
  const skipped = await runScreeningAttempt(claim.attempt_id, runtime(duplicate.store, async () => {
    throw new Error('should not call openai');
  }));
  assert.equal(skipped.status, 'duplicate');

  const late = storeMock({
    complete: async () => { throw new Error('Invalid or expired lease'); },
  });
  const failed = await runScreeningAttempt(claim.attempt_id, runtime(late.store, async () => ({
    id: 'resp_late', status: 'completed', output_text: successText,
  })));
  assert.equal(failed.status, 'failed');
  assert.equal(late.calls.complete.length, 0);
});
