import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {setupRankingDatabase} from './helpers/screening-ranking-fixture.mjs';

// This verifies that the real SC-010-R4 inventory rejects the new candidate
// linkage until a NEW, independently reviewed R5 schema/purge baseline exists.
// Ledger drift and R5 drift are measured separately. It does not bypass the
// baseline or execute a real erasure.
async function schemaSignature(db) {
  const actual = (await db.query('select private.erasure_schema_signature() as actual')).rows[0].actual;
  assert.equal(typeof actual, 'string');
  assert.ok(actual.length > 0);
  return actual;
}

// A column probe is rolled back. The signature moves only when this relation
// is inside erasure_schema_signature(); sibling ledger objects cannot hide a miss.
async function assertRelationIsSigned(db, qualifiedName, signed) {
  const [schema, name] = qualifiedName.split('.');
  assert.match(schema, /^[a-z_]+$/);
  assert.match(name, /^[a-z_]+$/);
  const found = (await db.query(
    `select c.relrowsecurity from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and c.relname = $2 and c.relkind = 'r'`,
    [schema, name],
  )).rows;
  assert.equal(found.length, 1, `${qualifiedName} must exist`);
  assert.equal(found[0].relrowsecurity, true, `${qualifiedName} must enable row level security`);

  await assert.rejects(
    db.query(`do $probe$
      declare before text := private.erasure_schema_signature();
      declare moved text;
      begin
        alter table ${schema}.${name} add column r5_signature_probe text;
        moved := private.erasure_schema_signature();
        if before is not distinct from moved then
          raise exception 'SC021_R5_RELATION_UNTRACKED:${schema}.${name}';
        end if;
        raise exception 'SC021_R5_SIGNATURE_PROBE_ROLLBACK';
      end
    $probe$`),
    error => {
      assert.equal(error.code, 'P0001');
      assert.match(error.message, /SC021_R5_SIGNATURE_PROBE_ROLLBACK/);
      return true;
    },
  );
  assert.equal(await schemaSignature(db), signed, `${qualifiedName} probe must roll back`);
}

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

  await db.exec(readFileSync(new URL('../db/prototypes/sc021-ai-gateway-ledger.sql', import.meta.url), 'utf8'));
  const afterLedger = await schemaSignature(db);
  assert.notEqual(afterLedger, previous.expected, 'base ledger must drift from the reviewed R4 inventory on its own');

  await db.exec(readFileSync(new URL('../db/prototypes/sc021-r5-anonymous-erasure.sql', import.meta.url), 'utf8'));
  const afterR5 = await schemaSignature(db);
  assert.notEqual(afterR5, afterLedger, 'R5 candidate-link schema must drift beyond the base ledger');

  const after = (await db.query(
    'select schema_signature as expected, private.erasure_schema_signature() as actual from private.erasure_inventory_baseline_r4 where singleton',
  )).rows[0];
  assert.equal(after.expected, previous.expected, 'no mutation to reviewed SC-010-R4 baseline');
  assert.equal(after.actual, afterR5);
  assert.notEqual(after.expected, after.actual, 'unreviewed ledger and R5 tables must stay outside the R4 baseline');

  for (const relation of [
    'private.ai_gateway_candidate_links',
    'private.ai_gateway_anonymous_spend',
  ]) {
    await assertRelationIsSigned(db, relation, afterR5);
  }

  await harness.asUser(fixture.owner);
  const preview = (await db.query(
    "select public.preview_candidate_erasure($1,'candidate_record',null) as value",
    [fixture.candidate.id],
  )).rows[0].value;
  assert.ok(preview.blockers.includes('schema_dependency_unknown'),JSON.stringify(preview));
  assert.equal(preview.execution_enabled,false);
});
