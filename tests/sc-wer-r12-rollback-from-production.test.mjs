import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { bootHostedRehearsal, replayObservedHistory, CURRENT_HISTORY } from './helpers/sc19-hosted-rehearsal.mjs';
import { assertCurrentInventory } from './helpers/sc19-migration-fixture.mjs';

// The SC-WER C1 rollback is only valid in one window of the release: after r12 and before the
// broker limiter / r13 (its guard needs the exact r12 schema signature and no rate_window).
// tests/competency-active-migration.test.mjs runs it on a synthetic schema where `drop ... cascade`
// happens to remove functions in a harmless order. This test starts from the real thing:
// the production migration history (49 recorded, read 2026-11-10) plus the pending migrations
// up to r12, exactly as the release applies them.
const dir = new URL('../supabase/migrations/', import.meta.url);
const r12 = '20261106063720_sc_wer_c1_inventory_r12.sql';
const r12Signature = '48afc7b117ac';
const r11Signature = '0d22eb7a547b1f8838298b034d3d257ca4cba9e81430f5c6b20b9212e4d88b84';

test('r12 rollback runs from the state the release reaches after r12, replayed from production history', async t => {
  const url = new URL(process.env.SC19_R12_ROLLBACK_DATABASE_URL);
  assert.equal(url.port, '55435');
  assert.equal(url.pathname, '/sc19_r12_rollback');
  assert.ok(['16', '17'].includes(process.env.SC19_TEST_PG_MAJOR));
  const { db } = await bootHostedRehearsal(t, url);
  const history = await replayObservedHistory(t, db, CURRENT_HISTORY);
  const recorded = new Set(history.map(e => e.name));
  const pending = (await readdir(dir)).filter(f => f.endsWith('.sql') && !recorded.has(f.replace(/^\d+_/, '').replace(/\.sql$/, ''))).sort();
  assert.ok(pending.includes(r12), 'r12 is still pending on production');
  for (const name of pending.filter(f => f <= r12)) await db.query(await readFile(new URL(name, dir), 'utf8'));
  const signature = async () => (await db.query('select private.erasure_schema_signature() s')).rows[0].s;
  assert.ok((await signature()).startsWith(r12Signature), 'state after r12 has the reviewed r12 schema signature (rollback guard passes)');
  assert.equal((await db.query("select to_regclass('competency_runtime.rate_window') v")).rows[0].v, null);

  // The rollback drops functions in pg_proc scan order and some of them cascade to others
  // (public.list_competency_test_attempts is a dependent of private.competency_staff_attempt_index).
  // Whether the dependent is scanned before or after the function it depends on is a matter of physical
  // heap layout, which differs between clusters (and between hosting and CI). Re-creating the dependent
  // from its own definition moves its tuple behind the other one: the order that used to break the script
  // with `drop function if exists <bare oid> cascade`. Asserted, so the test cannot pass vacuously.
  const dependent = "'public.list_competency_test_attempts(uuid)'::regprocedure", base = "'private.competency_staff_attempt_index(uuid)'::regprocedure";
  const def = (await db.query(`select pg_get_functiondef(${dependent}) d`)).rows[0].d;
  await db.query(def);
  assert.equal((await db.query(`select (select ctid from pg_proc where oid=${base}) < (select ctid from pg_proc where oid=${dependent}) later`)).rows[0].later, true,
    'dependent function is scanned after the function it depends on');

  await db.query(await readFile(new URL('../supabase/rollbacks/20261106063720_sc_wer_c1_inventory_r12_down.sql', import.meta.url), 'utf8'));
  assert.equal((await db.query("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname like '%competency%' and n.nspname in ('public','private')")).rows[0].n, 0, 'every competency function is gone');
  assert.equal((await db.query("select to_regclass('private.competency_test_grants') v")).rows[0].v, null);
  assert.equal((await db.query('select schema_signature from private.erasure_inventory_baseline_r11')).rows[0].schema_signature, r11Signature);
  await assertCurrentInventory(db);
});
