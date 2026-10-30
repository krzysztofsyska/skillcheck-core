import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { bootHostedRehearsal, replayObservedHistory } from './helpers/sc19-hosted-rehearsal.mjs';
import { assertCurrentInventory, assertR6, catalogSnapshot, migrationManifest } from './helpers/sc19-migration-fixture.mjs';

const m13 = '20261021084732_sc019_credits_payments_inventory.sql';
const dir = new URL('../supabase/migrations/', import.meta.url);

// Rewrites only the function body (prosrc) line endings, as a CRLF source file
// executed in the SQL editor would have created it. Owner and ACL are preserved.
async function setBodyLineEndings(db, signature, eol) {
  // Same key as the routines fingerprint: identity arguments include parameter names.
  const rows = (await db.query(`select pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'=$1`, [signature])).rows;
  assert.equal(rows.length, 1, signature);
  const { def } = rows[0];
  const open = def.indexOf('$function$'), close = def.lastIndexOf('$function$');
  assert.ok(open > 0 && close > open, `${signature} uses the $function$ body delimiter`);
  const body = def.slice(open + 10, close).replaceAll('\r\n', '\n');
  await db.query(def.slice(0, open + 10) + (eol === '\r\n' ? body.replaceAll('\n', '\r\n') : body) + def.slice(close));
}

// Production (inspect run 41021636267) = current checked-in chain through M12 in the hosted
// role model, with CRLF bodies in 13 functions from the 2026-10-01..04 migrations.
test('production_hosted_20261030: exact production fingerprints, M13 accepted as r4_legacy, unknown state refused', async t => {
  const url = new URL(process.env.SC19_HOSTED_REHEARSAL_DATABASE_URL);
  assert.equal(url.port, '55433');
  assert.equal(url.pathname, '/sc19_production_hosted');
  assert.equal(process.env.SC19_TEST_PG_MAJOR, '17', 'The observed production state is PostgreSQL 17');
  const { db } = await bootHostedRehearsal(t, url);
  const history = await replayObservedHistory(t, db);
  const applied = new Set(history.map(entry => entry.name));
  const pending = (await readdir(dir)).filter(f => f.endsWith('.sql') && !applied.has(f.replace(/^\d+_/, '').replace(/\.sql$/, ''))).sort();
  const m13Index = pending.indexOf(m13);
  assert.equal(m13Index, 12, 'Production recorded M1..M12; M13 is the next pending migration');
  for (const name of pending.slice(0, m13Index)) await db.query(await readFile(new URL(name, dir), 'utf8'));

  const manifest = await migrationManifest();
  const state = manifest.states.production_hosted_20261030;
  assert.equal(state.behaves_as, 'r4_legacy');
  assert.equal(state.crlf_functions.length, 13);
  const lf = await catalogSnapshot(db);
  assert.equal(lf.routines, manifest.states.r4_legacy.pg16.routines, 'Current files replay to the reviewed r4_legacy routines');
  for (const signature of state.crlf_functions) await setBodyLineEndings(db, signature, '\r\n');
  assert.deepEqual(await catalogSnapshot(db), state.inspect_observed, 'Rehearsal reproduces all 8 production fingerprints');

  const sql = await readFile(new URL(m13, dir), 'utf8');
  for (const [label, mutation] of [
    ['one more CRLF function', async () => setBodyLineEndings(db, 'private.erasure_hash(value jsonb)', '\r\n')],
    ['one CRLF function back to LF', async () => setBodyLineEndings(db, state.crlf_functions[0], '\n')],
    ['unreviewed table', async () => db.query('create table public.unreviewed_hosted_table(id integer)')],
  ]) {
    const before = await catalogSnapshot(db);
    await db.query('begin'); await mutation();
    await assert.rejects(db.query(sql), /sc19_source_schema_unreviewed/, label);
    await db.query('rollback');
    assert.deepEqual(await catalogSnapshot(db), before, `${label}: refusal rolls back`);
  }

  await db.query(sql);
  // The state runs M13's r4_legacy branch: analysis billing triggers are installed.
  assert.deepEqual((await db.query(`select tgname from pg_trigger where tgrelid='public.screening_analysis_versions'::regclass
    and tgname like 'sc19%' order by tgname`)).rows.map(row => row.tgname),
  ['sc19_analysis_bill', 'sc19_analysis_lock', 'sc19_analysis_reconcile']);
  // M13 leaves the CRLF bodies alone and checks its own reviewed output for this state;
  // with LF restored the result is exactly the reviewed legacy R6 output.
  assert.deepEqual(await catalogSnapshot(db), manifest.outputs.legacy_production_hosted_20261030.pg17);
  for (const signature of state.crlf_functions) await setBodyLineEndings(db, signature, '\n');
  await assertR6(db);
  for (const name of pending.slice(m13Index + 1)) await db.query(await readFile(new URL(name, dir), 'utf8'));
  await assertCurrentInventory(db);
});
