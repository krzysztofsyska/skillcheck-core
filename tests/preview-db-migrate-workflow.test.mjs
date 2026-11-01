import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const yml = readFileSync(new URL('../.github/workflows/preview-db-migrate.yml', import.meta.url), 'utf8');
const list = readFileSync(new URL('../supabase/preview-migrations.txt', import.meta.url), 'utf8');

test('preview migrations run only against skillcheck-preview, never production', () => {
  assert.match(yml, /PREVIEW_REF: orbyscrupgnupifzlqxp/);
  assert.match(yml, /PRODUCTION_REF: wsvjawuikxfzjyivxgsu/);
  assert.match(yml, /\*"\$PRODUCTION_REF"\*\) echo "::error::Refusing/);
  assert.match(yml, /\*"\$PREVIEW_REF"\*\) ;; \*\) echo "::error::Refusing/);
  assert.match(yml, /^\s+environment: preview-db$/m);
  assert.doesNotMatch(yml, /production-approval|db push|supabase link|secrets set/);
  assert.equal(yml.match(/secrets\./g).length, 1);
  assert.doesNotMatch(yml, /echo[^\n]*DATABASE_URL\b(?!:-}|" in| is not set)/);
});

test('trigger is limited to integration and preview-db/** pushes with read-only token', () => {
  const triggers = yml.slice(yml.indexOf('\non:'), yml.indexOf('\npermissions:'));
  assert.match(triggers, /- integration\n\s+- 'preview-db\/\*\*'/);
  assert.doesNotMatch(triggers, /pull_request|schedule|workflow_run|repository_dispatch|main/);
  assert.match(yml, /^permissions: \{\}$/m);
  assert.doesNotMatch(yml, /: write/);
  assert.match(yml, /persist-credentials: false/);
  for (const [, ref] of yml.matchAll(/uses: [^@\s]+@(\S+)/g)) assert.match(ref, /^[0-9a-f]{40}$/);
});

test('every listed migration exists and is a checked-in file name', () => {
  const entries = list.split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean);
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.match(entry, /^[0-9]{14}_[a-z0-9_]+\.sql$/);
    assert.ok(existsSync(new URL(`../supabase/migrations/${entry}`, import.meta.url)), entry);
  }
  assert.deepEqual([...entries].sort(), entries, 'listed in migration order');
});

test('a listed migration edited after reaching preview fails unless its resync is acknowledged', () => {
  assert.match(yml, /ledger_sha" = "\$body_sha" \]; then echo "skip/);
  assert.match(yml, /grep -qxF "\$body_sha  \$file" supabase\/preview-resynced\.txt/);
  assert.match(yml, /::error::\$file changed after it was applied to preview/);
  const acks = readFileSync(new URL('../supabase/preview-resynced.txt', import.meta.url), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#'));
  for (const line of acks) assert.match(line, /^[0-9a-f]{64} {2}[0-9]{14}_[a-z0-9_]+\.sql$/);
});
