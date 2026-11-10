import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Every migration from November 2026 onwards must ship the script that undoes it.
// A migration without one cannot be backed out on the Preview database without
// hand-written SQL under time pressure, which is how shared Preview state gets
// broken. The pairing is checked on the checked-in files only: no database, no
// network, so it runs in the `verify` job of .github/workflows/checks.yml and
// locally via `npm run test:migration-pairs`.
//
// Scope: this is a pairing and hygiene check, not a correctness check. It cannot
// tell whether a rollback actually undoes its migration — only that one exists,
// is a single transaction, and contains undo statements. Correctness is a review
// and database-test concern.
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
    // Without this, an empty `begin; commit;` would satisfy the pairing check and
    // the missing rollback would stay invisible. Not proof of correctness — just
    // proof that something is actually undone. `update` is in the list because a
    // migration that only flipped a settings row is correctly undone by flipping it
    // back; three checked-in rollbacks need it and nothing else —
    // 20261102090000_sales_leads_enable_down.sql,
    // 20261106230000_cv_bulk_global_capacity_lock_down.sql and
    // 20261107164252_sc019_catalog_orders_down.sql.
    assert.match(sql, /^\s*(drop|alter|revoke|delete|update|do)\b/im,
      `${file} contains no undo statement`);
  }
});
