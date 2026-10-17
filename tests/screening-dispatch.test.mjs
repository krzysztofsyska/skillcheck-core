import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  assert.equal(seen.init.redirect, 'error');
  assert.ok(seen.init.signal instanceof AbortSignal);
  const verified = verifyScreeningDispatch({
    secret,
    timestamp: seen.init.headers['x-skillcheck-timestamp'],
    signature: seen.init.headers['x-skillcheck-signature'],
    body: seen.init.body,
  });
  assert.equal(verified.ok, true);
  assert.equal(seen.init.body.toString('utf8'), JSON.stringify({ attempt_id: attemptId }));
});

test('SC-006 exposes only authenticated orchestration, never an arbitrary attempt dispatcher', () => {
  const screeningActions = new URL(
    '../app/dashboard/[companyId]/recruitments/[recruitmentId]/applications/[applicationId]/screening/actions.ts',
    import.meta.url,
  );
  const actions = readFileSync(screeningActions, 'utf8');
  assert.deepEqual([...actions.matchAll(/export async function (\w+)/g)].map(m => m[1]), ['startAnalysis', 'retryAnalysis', 'reviewAnalysis']);
  assert.doesNotMatch(actions, /form\.get\(['"]attempt/i);
  assert.doesNotMatch(actions, /dispatchScreeningWorker\s*\(/);
  assert.equal((actions.match(/await companyAccess\(route.companyId\)/g) ?? []).length, 3);

  const dispatchSource = readFileSync(new URL('../lib/screening-dispatch.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(dispatchSource, /^['"]use server['"]/m);
  assert.doesNotMatch(dispatchSource, /dispatchPreparedScreening/);

  const offenders = [];
  const stack = [new URL('../app', import.meta.url).pathname];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
      const source = readFileSync(path, 'utf8');
      if (/^['"]use server['"]/m.test(source) && /dispatch(PreparedScreening|ScreeningWorker)/.test(source)) {
        offenders.push(path);
      }
    }
  }
  assert.deepEqual(offenders, [screeningActions.pathname]);
});
