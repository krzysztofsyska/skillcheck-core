import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { OPS_002B_ALLOWLIST, checkScope, outsideAllowlist } from '../../tools/agent-pipeline/lib/allowlist.mjs';

test('the allowlist validator accepts controller files and rejects product files', () => {
  assert.deepEqual(outsideAllowlist([
    'tools/agent-pipeline/cli.mjs',
    'tests/agent-pipeline/reconcile.test.mjs',
    '.github/workflows/checks.yml',
  ], OPS_002B_ALLOWLIST), []);
  assert.deepEqual(outsideAllowlist([
    'app/page.tsx',
    'supabase/migrations/001.sql',
    'package-lock.json',
  ], OPS_002B_ALLOWLIST), ['app/page.tsx', 'supabase/migrations/001.sql', 'package-lock.json']);
});

test('another task is not subject to the SC-OPS-002B allowlist', () => {
  let calls = 0;
  const result = checkScope({
    event: { pull_request: { body: 'TASK: SC-006\nSTATUS: READY\n', base: { sha: 'a'.repeat(40) } } },
    branch: 'feat/sc-006-something',
    env: { GITHUB_HEAD_REF: 'feat/sc-006-something' },
  }, () => {
    calls += 1;
    return { status: 1, stderr: 'git should not run', stdout: '' };
  });
  assert.equal(result.applicable, false);
  assert.equal(result.checked, false);
  assert.equal(result.ok, true);
  assert.equal(calls, 0);
});

test('a missing comparison base fails the SC-OPS-002B scope check', () => {
  const result = checkScope({
    branch: 'feat/sc-ops-002b-agent-orchestration',
    env: {},
  }, () => ({ status: 1, stderr: 'fatal: bad object 579da382f976971392bc15239fded5417945c0f0\n', stdout: '' }));
  assert.equal(result.applicable, true);
  assert.equal(result.checked, false);
  assert.equal(result.ok, false);
  assert.match(result.error, /bad object|git fetch failed/);
});

test('files outside the allowlist fail the PR scope check', () => {
  const result = checkScope({ branch: 'feat/sc-ops-002b-agent-orchestration' }, (command, args) => {
    assert.equal(command, 'git');
    if (args[0] === 'cat-file') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'diff') return { status: 0, stdout: 'app/page.tsx\n', stderr: '' };
    return { status: 1, stderr: `unexpected ${args.join(' ')}`, stdout: '' };
  });
  assert.equal(result.checked, true);
  assert.equal(result.ok, false);
  assert.deepEqual(result.outside, ['app/page.tsx']);
});

test('this checkout stays inside the SC-OPS-002B allowlist when the check applies', () => {
  const shown = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
  assert.equal(shown.status, 0, shown.stderr);
  const current = shown.stdout.trim();
  const branch = current === 'HEAD' ? (process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || '') : current;
  let event = null;
  if (process.env.GITHUB_EVENT_PATH) {
    event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  }
  const result = checkScope({ branch, env: process.env, event });
  if (!result.applicable) {
    assert.equal(result.checked, false);
    assert.equal(result.ok, true);
    return;
  }
  assert.equal(result.ok, true, result.error || (result.outside ?? []).join(','));
  assert.equal(result.checked, true);
  assert.deepEqual(result.outside, []);
  assert.equal(result.files.length > 0, true);
});
