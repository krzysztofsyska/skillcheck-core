import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import {
  hashScreeningBody,
  parseScreeningDispatchAttempt,
  screeningDispatchBody,
  signScreeningDispatch,
  verifyScreeningDispatch,
} from '../lib/screening-hmac.ts';

const secret = randomBytes(32).toString('hex');

test('HMAC signs raw body bytes and rejects tampering or stale timestamps', () => {
  const body = screeningDispatchBody('11111111-1111-4111-8111-111111111111');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signScreeningDispatch(secret, timestamp, body);
  assert.equal(
    verifyScreeningDispatch({ secret, timestamp, signature, body }).ok,
    true,
  );
  assert.equal(hashScreeningBody(body).length, 64);
  assert.equal(
    verifyScreeningDispatch({
      secret, timestamp, signature, body: Buffer.from(`${body.toString()} `),
    }).ok,
    false,
  );
  assert.equal(
    verifyScreeningDispatch({ secret, timestamp, signature: 'aa'.repeat(32), body }).ok,
    false,
  );
  assert.equal(
    verifyScreeningDispatch({
      secret, timestamp: String(Number(timestamp) - 61), signature, body,
    }).code,
    'timestamp',
  );
  assert.equal(
    verifyScreeningDispatch({
      secret: 'short', timestamp, signature, body,
    }).code,
    'secret',
  );
});

test('hmac module imports Buffer so Deno does not depend on a global', async () => {
  const source = await readFile(new URL('../lib/screening-hmac.ts', import.meta.url), 'utf8');
  assert.match(source, /import \{ Buffer \} from 'node:buffer';/);
});

test('deno verifies a signed body when Buffer is not a global', (t) => {
  const deno = spawnSync('deno', ['--version'], { encoding: 'utf8' });
  if (deno.error) {
    t.skip('deno is not installed');
    return;
  }
  const check = spawnSync('deno', ['run', '--allow-read', 'scripts/check-screening-hmac-deno.ts'], {
    encoding: 'utf8',
    cwd: new URL('..', import.meta.url).pathname,
  });
  assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
  assert.match(check.stdout, /deno-hmac-ok/);
});

test('dispatch body is hashed before JSON parse and accepts only a UUID attempt', () => {
  const attemptId = '22222222-2222-4222-8222-222222222222';
  const body = screeningDispatchBody(attemptId);
  assert.equal(body.toString('utf8'), JSON.stringify({ attempt_id: attemptId }));
  assert.equal(parseScreeningDispatchAttempt(body), attemptId);
  assert.throws(() => parseScreeningDispatchAttempt(Buffer.from('{"attempt_id":"nope"}')));
  assert.throws(() => screeningDispatchBody('not-a-uuid'));
});
