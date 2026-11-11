import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowPreviewWrites, runGuard } from '../scripts/preview-freeze-guard.mjs';

// `policy` is the ACTIVE hold shape: the guard contract (a hold denies writes, only an explicit valid
// disabled policy permits them) is tested against it whatever state is checked in.
// The freeze was lifted on 2026-11-11 (release SC-RELEASE-20261104); the checked-in file is `released` below.
const baselineSha = '4db85e268a3b203fdf3f0a4c9d0636d33346d6a8';
const policy = { enabled: true, baselineSha };
const released = { enabled: false, baselineSha };
test('freeze denies writes; only an explicit valid disabled policy permits them', () => {
  assert.equal(allowPreviewWrites(JSON.stringify(policy)), false);
  assert.equal(allowPreviewWrites(JSON.stringify(released)), true);
  for (const invalid of ['', '{', 'null', '[]', '{}',
    JSON.stringify({ ...policy, enabled: 'false' }),
    JSON.stringify({ ...policy, baselineSha: 'HEAD' }),
    JSON.stringify({ ...policy, override: true }),
    JSON.stringify({ baselineSha: policy.baselineSha }),
  ]) assert.throws(() => allowPreviewWrites(invalid));
});

test('missing or invalid policy emits deny and fails, active hold succeeds with deny', () => {
  const dir = mkdtempSync(join(tmpdir(), 'preview-freeze-'));
  try {
    for (const [name, read, expectedExit, expectedAllow] of [
      ['missing', () => { throw new Error('ENOENT'); }, 1, false],
      ['invalid', () => '{', 1, false],
      ['hold', () => JSON.stringify(policy), 0, false],
      ['released', () => JSON.stringify({ ...policy, enabled: false }), 0, true],
    ]) {
      const output = join(dir, name);
      assert.equal(runGuard({ read, output }), expectedExit);
      assert.equal(readFileSync(output, 'utf8'), `allow=${expectedAllow}\n`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('checked-in policy is RELEASED (freeze lifted 2026-11-11), keeps the historical baseline and no infrastructure or candidate metadata', () => {
  const text = readFileSync(new URL('../config/preview-freeze.json', import.meta.url), 'utf8');
  assert.deepEqual(JSON.parse(text), released);
  assert.equal(allowPreviewWrites(text), true);
  // Flipping the file back to a hold must fail this test, not slip through.
  assert.notDeepEqual(JSON.parse(text), policy);
});

for (const [file, job] of [['preview-db-migrate.yml', 'migrate'], ['preview-ai-smoke.yml', 'smoke']]) {
  test(`${file}: trusted preflight gates environment and secrets at job level`, () => {
    const yml = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
    const preflight = yml.split('  preflight:\n')[1]?.split(`  ${job}:\n`)[0];
    assert.ok(preflight);
    assert.match(preflight, /ref: refs\/heads\/integration\n/);
    assert.doesNotMatch(preflight, /environment:|secrets\.|github\.(sha|ref)|npm ci/);
    assert.match(preflight, /persist-credentials: false/);
    assert.match(preflight, /allow: \$\{\{ steps\.freeze\.outputs\.allow \}\}/);
    assert.match(preflight, /- id: freeze\n\s+run: node scripts\/preview-freeze-guard\.mjs/);
    assert.match(yml, new RegExp(`  ${job}:\\n    needs: preflight\\n    if: needs.preflight.outputs.allow == 'true'\\n`));
    assert.match(yml.split(`  ${job}:\n`)[1], /environment: preview-db/);
  });
}
