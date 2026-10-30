import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { bootHostedRehearsal, replayObservedHistory } from './helpers/sc19-hosted-rehearsal.mjs';
import { assertCurrentInventory, assertR6, catalogSnapshot, migrationManifest } from './helpers/sc19-migration-fixture.mjs';

const m13 = '20261021084732_sc019_credits_payments_inventory.sql';
const normalize = '20261021084500_normalize_function_line_endings.sql';
const dir = new URL('../supabase/migrations/', import.meta.url);

// Production project wsvjawuikxfzjyivxgsu, read-only inspect of 'DB migrate production'
// run 41021636267 (2026-10-30, PostgreSQL 17.6): all 8 raw catalog fingerprints.
const inspected = {
  sc010_signature: 'd2e7725bd5051e15cb7e700a128026a3ad6f0d87f9d3bba3de8e1539c9d3eabd',
  routines: '00a80249fa7ae58ee90bd25b8c5f29b3f9778dd1ed3de891abab14b198c557e7',
  indexes: '6914c23eb115e05186ed163a569f4e67d5677d56cf63c273d8861d3fcd7da38d',
  trigger_states: '89214d67680a0c2a6fb0d26c277783fb95fea921acbe9ef800b72234d5c4caff',
  relations: 'e2a90771ec941a06b2d9b4797e6af72443cbe7f0c351dee29657e6470fafddf6',
  policies: 'd7918648cf896d04731b18e4827399b4f9c0b21c243786f11aa2812fe18e8772',
  nonowned_acl: '340b40cc5295e717cef60f2124602963a5eb02e4dec9c6434075c1f9d68ce294',
  rewrites: 'e9c6543bb90eae112800eec33f1bec5a733fc5e6194a92915f7ff1124fad897f',
};
// Same inspect: these 13 bodies (and only these) are stored with CRLF; signatures as in the routines key.
const crlfFunctions = [
  'private.behavior_trim(value text)',
  'private.exercise_key(value text)',
  'private.has_company_access(target_company uuid, write_access boolean)',
  'private.is_company_owner(target_company uuid)',
  'private.touch_updated_at()',
  'private.validate_exercise_definition(value jsonb)',
  'private.version_candidate_document()',
  'public.create_company(company_name text)',
  'public.ensure_initial_company(company_name text)',
  'public.review_candidate_document(document_id uuid, expected_version integer)',
  'public.save_behavior_assessment(target_application uuid, target_area text, new_rating text, new_evidence text, expected_version integer, expected_position_updated_at timestamp with time zone, expected_position_id uuid)',
  'public.save_exercise_definition(target_recruitment uuid, target_exercise uuid, new_definition jsonb, expected_version integer, expected_position_id uuid, expected_position_updated_at timestamp with time zone)',
  'public.save_exercise_observations(target_application uuid, target_definition uuid, expected_version integer, new_work_sample text, new_observations jsonb)',
];

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

// Production = current checked-in chain through M12 in the hosted role model, with CRLF bodies
// in 13 functions from the 2026-10-01..04 migrations. The line ending normalization migration
// must turn exactly this state into reviewed r4_legacy so that the unchanged M13 applies.
test('inspected production state: normalization then the unchanged M13 reach the reviewed R6 output', async t => {
  const url = new URL(process.env.SC19_HOSTED_REHEARSAL_DATABASE_URL);
  assert.equal(url.port, '55433');
  assert.equal(url.pathname, '/sc19_production_hosted');
  assert.equal(process.env.SC19_TEST_PG_MAJOR, '17', 'The observed production state is PostgreSQL 17');
  const { db } = await bootHostedRehearsal(t, url);
  const history = await replayObservedHistory(t, db);
  const applied = new Set(history.map(entry => entry.name));
  const pending = (await readdir(dir)).filter(f => f.endsWith('.sql') && !applied.has(f.replace(/^\d+_/, '').replace(/\.sql$/, ''))).sort();
  const normalizeIndex = pending.indexOf(normalize), m13Index = pending.indexOf(m13);
  assert.equal(normalizeIndex, 12, 'Production recorded M1..M12; normalization is the next pending migration');
  assert.equal(m13Index, 13);
  for (const name of pending.slice(0, normalizeIndex)) await db.query(await readFile(new URL(name, dir), 'utf8'));

  const manifest = await migrationManifest();
  assert.equal((await catalogSnapshot(db)).routines, manifest.states.r4_legacy.pg16.routines, 'Current files replay to reviewed r4_legacy routines');
  for (const signature of crlfFunctions) await setBodyLineEndings(db, signature, '\r\n');
  assert.deepEqual(await catalogSnapshot(db), inspected, 'Rehearsal reproduces all 8 production fingerprints');

  const m13Sql = await readFile(new URL(m13, dir), 'utf8');
  await db.query('begin');
  await assert.rejects(db.query(m13Sql), /sc19_source_schema_unreviewed/, 'Without normalization M13 refuses, as on 2026-10-29');
  await db.query('rollback');
  assert.deepEqual(await catalogSnapshot(db), inspected);

  await db.query(await readFile(new URL(normalize, dir), 'utf8'));
  assert.deepEqual(await catalogSnapshot(db), { ...inspected, routines: manifest.states.r4_legacy.pg16.routines },
    'Normalization changes only the routines fingerprint, to reviewed r4_legacy');

  for (const [label, mutation] of [
    ['CRLF outside the normalized list', async () => setBodyLineEndings(db, 'private.erasure_hash(value jsonb)', '\r\n')],
    ['unreviewed table', async () => db.query('create table public.unreviewed_hosted_table(id integer)')],
  ]) {
    const before = await catalogSnapshot(db);
    await db.query('begin'); await mutation();
    await assert.rejects(db.query(m13Sql), /sc19_source_schema_unreviewed/, label);
    await db.query('rollback');
    assert.deepEqual(await catalogSnapshot(db), before, `${label}: refusal rolls back`);
  }

  await db.query(m13Sql);
  assert.deepEqual((await db.query(`select tgname from pg_trigger where tgrelid='public.screening_analysis_versions'::regclass
    and tgname like 'sc19%' order by tgname`)).rows.map(row => row.tgname),
  ['sc19_analysis_bill', 'sc19_analysis_lock', 'sc19_analysis_reconcile'], 'r4_legacy path installs analysis billing');
  await assertR6(db);
  for (const name of pending.slice(m13Index + 1)) await db.query(await readFile(new URL(name, dir), 'utf8'));
  await assertCurrentInventory(db);
});
