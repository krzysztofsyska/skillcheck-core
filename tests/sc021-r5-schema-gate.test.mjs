import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {setupRankingDatabase} from './helpers/screening-ranking-fixture.mjs';

// This verifies that the real SC-010-R4 inventory rejects the new candidate
// linkage until a NEW, independently reviewed R5 schema/purge baseline exists.
// It does not bypass the baseline or execute a real erasure.
test('SC-021-B/R5 candidate ledger addition leaves SC-010-R4 fail-closed', async t => {
  const db = new PGlite({extensions:{pgcrypto}});
  t.after(() => db.close());
  const harness = await setupRankingDatabase(db);
  const fixture = await harness.seed();
  await harness.asAdmin();

  const previous = (await db.query(
    'select schema_signature as expected, private.erasure_schema_signature() as actual from private.erasure_inventory_baseline_r4 where singleton',
  )).rows[0];
  assert.equal(previous.expected, previous.actual, 'existing SC-010-R4 must have an accepted baseline');

  for (const path of [
    '../db/prototypes/sc021-ai-gateway-ledger.sql',
    '../db/prototypes/sc021-r5-anonymous-erasure.sql',
  ]) {
    await db.exec(readFileSync(new URL(path, import.meta.url), 'utf8'));
  }

  const after = (await db.query(
    'select schema_signature as expected, private.erasure_schema_signature() as actual from private.erasure_inventory_baseline_r4 where singleton',
  )).rows[0];
  assert.equal(after.expected, previous.expected, 'no mutation to reviewed SC-010-R4 baseline');
  assert.notEqual(after.expected, after.actual, 'new unreviewed tables MUST cause schema drift');

  await harness.asUser(fixture.owner);
  const preview = (await db.query(
    "select public.preview_candidate_erasure($1,'candidate_record',null) as value",
    [fixture.candidate.id],
  )).rows[0].value;
  assert.ok(preview.blockers.includes('schema_dependency_unknown'),JSON.stringify(preview));
  assert.equal(preview.execution_enabled,false);
});
