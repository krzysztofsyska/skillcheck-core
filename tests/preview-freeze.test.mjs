import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowPreviewWrites, runGuard } from '../scripts/preview-freeze-guard.mjs';

const policy = { enabled: true, baselineSha: '4db85e268a3b203fdf3f0a4c9d0636d33346d6a8' };
test('freeze denies writes; only an explicit valid disabled policy permits them', () => {
  assert.equal(allowPreviewWrites(JSON.stringify(policy)), false);
  assert.equal(allowPreviewWrites(JSON.stringify({ ...policy, enabled: false })), true);
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

test('checked-in freeze pins baseline with no infrastructure or candidate metadata', () => {
  const text = readFileSync(new URL('../config/preview-freeze.json', import.meta.url), 'utf8');
  assert.deepEqual(JSON.parse(text), policy);
  assert.equal(allowPreviewWrites(text), false);
});

for (const [file, job] of [['preview-db-migrate.yml', 'migrate'], ['preview-ai-smoke.yml', 'smoke']]) {
  test(`${file}: trusted preflight gates environment and secrets at job level`, () => {
    const yml = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
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
