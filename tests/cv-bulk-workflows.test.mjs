import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');

test('background pump: main-only schedule, one secret, no write permissions', () => {
  const yml = read('cv-bulk-pump.yml');
  const triggers = yml.slice(yml.indexOf('\non:'), yml.indexOf('\npermissions:'));
  assert.match(triggers, /schedule:\n\s+- cron: '\*\/5 \* \* \* \*'/);
  assert.doesNotMatch(triggers, /push|pull_request|workflow_run/);
  assert.match(yml, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(yml, /^permissions: \{\}$/m);
  assert.equal(yml.match(/secrets\./g).length, 1);
  assert.match(yml, /APP_URL: https:\/\/skillcheck\.pl$/m);
  assert.doesNotMatch(yml, /uses:/, 'no third-party actions');
});

test('preview AI smoke: preview-only, bounded, secrets only in the preview-db environment', () => {
  const yml = read('preview-ai-smoke.yml');
  const triggers = yml.slice(yml.indexOf('\non:'), yml.indexOf('\npermissions:'));
  assert.match(triggers, /- 'preview-ai\/\*\*'/);
  assert.doesNotMatch(triggers, /main|integration|pull_request|schedule/);
  assert.match(yml, /^\s+environment: preview-db$/m);
  assert.match(yml, /MAX_ATTEMPTS: '10'/);
  assert.match(yml, /persist-credentials: false/);
  for (const [, ref] of yml.matchAll(/uses: [^@\s]+@(\S+)/g)) assert.match(ref, /^[0-9a-f]{40}$/);
  const script = readFileSync(new URL('../scripts/preview-ai-smoke.mjs', import.meta.url), 'utf8');
  assert.match(script, /PRODUCTION_REF = 'wsvjawuikxfzjyivxgsu'/);
  assert.match(script, /c\.name like 'Firma Testowa%'/);
  assert.match(script, /Math\.min\(.*20\)/);
  assert.doesNotMatch(script, /input_cv_text_snapshot|source_text|redacted_text/, 'never logs CV text');
});
