import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Every migration from November 2026 onwards must ship the script that undoes it.
// A migration without one cannot be backed out on the Preview database without
// hand-written SQL under time pressure, which is how shared Preview state gets
// broken. The pairing is checked on the checked-in files only: no database, no
// network, so this runs in every CI job and locally.
//
// The cutoff is deliberate. Migrations before 2026-11 predate this rule and are
// not retrofitted here; raising the cutoff is an intentional, reviewed change.
const FROM = '20261101000000';

const dir = name => fileURLToPath(new URL(`../supabase/${name}`, import.meta.url));
const sqlIn = name => readdirSync(dir(name)).filter(file => file.endsWith('.sql')).sort();

const migrations = sqlIn('migrations')
  .map(file => file.replace(/\.sql$/, ''))
  .filter(stem => /^\d{14}_/.test(stem) && stem.slice(0, 14) >= FROM);
const rollbacks = new Set(sqlIn('rollbacks').map(file => file.replace(/\.sql$/, '')));

test('every migration from 2026-11 on has a matching _down.sql rollback', () => {
  assert.ok(migrations.length > 0, 'no migrations found in the checked window');
  const missing = migrations.filter(stem => !rollbacks.has(`${stem}_down`));
  assert.deepEqual(missing, [], `missing supabase/rollbacks/<name>_down.sql for: ${missing.join(', ')}`);
});

test('every rollback in the checked window belongs to a migration', () => {
  const orphans = [...rollbacks]
    .filter(stem => /^\d{14}_/.test(stem) && stem.slice(0, 14) >= FROM)
    .filter(stem => stem.endsWith('_down'))
    .filter(stem => !migrations.includes(stem.replace(/_down$/, '')));
  assert.deepEqual(orphans, [], `rollback without its migration: ${orphans.join(', ')}`);
});

test('rollback files are named _down.sql and wrapped in a transaction', () => {
  for (const file of sqlIn('rollbacks')) {
    assert.match(file, /_down\.sql$/, `${file} does not follow the _down.sql naming`);
    const sql = readFileSync(`${dir('rollbacks')}/${file}`, 'utf8');
    // A rollback that is not one transaction can leave the schema half-undone.
    assert.match(sql, /^\s*(--[^\n]*\n|\s)*begin;/i, `${file} does not open with begin;`);
    assert.match(sql, /\bcommit;\s*$/i, `${file} does not end with commit;`);
  }
});
