import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { dispatchScreeningWorker } from '../lib/screening-dispatch.ts';
import { verifyScreeningDispatch } from '../lib/screening-hmac.ts';

const secret = randomBytes(32).toString('hex');
const attemptId = '33333333-3333-4333-8333-333333333333';

test('dispatcher stays silent when the AI flag is off and signs a raw body when enabled', async () => {
  const disabled = await dispatchScreeningWorker(attemptId, { SCREENING_AI_ENABLED: 'false' }, async () => {
    throw new Error('must not fetch');
  });
  assert.deepEqual(disabled, { accepted: false, reason: 'disabled' });

  let seen;
  const enabled = await dispatchScreeningWorker(attemptId, {
    SCREENING_AI_ENABLED: 'true',
    SCREENING_WORKER_DISPATCH_SECRET: secret,
    SCREENING_WORKER_URL: 'https://example.invalid/functions/v1/screening-worker',
  }, async (url, init) => {
    seen = { url, init };
    return { status: 202 };
  });
  assert.deepEqual(enabled, { accepted: true, attempt_id: attemptId });
  assert.ok(seen.url.endsWith('/screening-worker'));
  const verified = verifyScreeningDispatch({
    secret,
    timestamp: seen.init.headers['x-skillcheck-timestamp'],
    signature: seen.init.headers['x-skillcheck-signature'],
    body: seen.init.body,
  });
  assert.equal(verified.ok, true);
  assert.equal(seen.init.body.toString('utf8'), JSON.stringify({ attempt_id: attemptId }));
});
