import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {setupRankingDatabase, users} from './helpers/screening-ranking-fixture.mjs';

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


test('SC-021-B/R5 staged inventory uses REAL SC-010-R4 graph and authoritative tenant-candidate FKs', async t => {
  const db = new PGlite({extensions:{pgcrypto}});
  t.after(() => db.close());
  const h = await setupRankingDatabase(db);
  const tenantA = await h.seed();
  const tenantB = await h.seed(users.otherOwner);
  await h.asAdmin();

  for (const path of [
    '../db/prototypes/sc021-ai-gateway-ledger.sql',
    '../db/prototypes/sc021-r5-anonymous-erasure.sql',
    '../db/prototypes/sc021-r5-erasure-inventory-adapter.sql',
  ]) {
    await db.exec(readFileSync(new URL(path, import.meta.url), 'utf8'));
  }

  await db.query(
    'insert into public.ai_gateway_limits(company_id,monthly_limit_micro_usd) values ($1,100000),($2,100000)',
    [tenantA.companyId, tenantB.companyId],
  );
  const reserve = async f => {
    const id = randomUUID();
    const row = (await db.query(
      'select * from private.ai_gateway_reserve_candidate(' +
      '$1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::text,' +
      '$7::text,$8::text,$9::text,$10::text,$11::bigint)',
      [f.companyId,f.candidate.id,id,randomUUID(),null,'cv_screening',
        'openai','synthetic-test-model','policy-test','price-test',100],
    )).rows[0];
    assert.equal(row.created,true);
    return {id,usageId:row.usage_id};
  };
  const a=await reserve(tenantA);
  const b=await reserve(tenantB);
  // A non-candidate generic usage row must not accidentally be swept up
  // by the per-candidate manifest merely because the tenant matches.
  const unrelated=(await db.query(
    'select * from public.ai_gateway_reserve(' +
    '$1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::text,' +
    '$7::text,$8::text,$9::text,$10::text,$11::bigint)',
    [tenantA.companyId,randomUUID(),randomUUID(),null,null,'interview_plan',
      'openai','synthetic-test-model','policy-test','price-test',50],
  )).rows[0];
  assert.equal(unrelated.created,true);

  const rowsA=(await db.query(
    'select adapter,row_key,row_data from private.ai_gateway_r5_inventory_rows($1,$2::uuid[]) order by adapter',
    [tenantA.companyId,[tenantA.candidate.id]],
  )).rows;
  assert.deepEqual(rowsA.map(x=>x.adapter),
    ['private.ai_gateway_candidate_links','public.ai_gateway_usage']);
  assert.ok(rowsA.every(x=>x.row_key===a.usageId));
  assert.ok(rowsA.every(x=>x.row_data.company_id===tenantA.companyId));

  const rowsB=(await db.query(
    'select adapter,row_key from private.ai_gateway_r5_inventory_rows($1,$2::uuid[])',
    [tenantB.companyId,[tenantB.candidate.id]],
  )).rows;
  assert.equal(rowsB.length,2);
  assert.ok(rowsB.every(x=>x.row_key===b.usageId));
  const foreign=(await db.query(
    'select * from private.ai_gateway_r5_inventory_rows($1,$2::uuid[])',
    [tenantA.companyId,[tenantB.candidate.id]],
  )).rows;
  assert.equal(foreign.length,0,'a foreign candidate must not leak any financial rows');

  const complete=(await db.query(
    'select adapter,row_key,row_data from private.erasure_purge_rows_sc021_r5($1,$2::uuid[])',
    [tenantA.companyId,[tenantA.candidate.id]],
  )).rows;
  const finance=complete.filter(row=>row.adapter.startsWith('private.ai_gateway_')
    || row.adapter==='public.ai_gateway_usage');
  assert.deepEqual(finance.map(row=>row.adapter).sort(),
    ['private.ai_gateway_candidate_links','public.ai_gateway_usage']);
  assert.ok(complete.some(row=>row.adapter==='public.candidates'));
  assert.ok(!complete.some(row=>row.row_key===b.usageId || row.row_key===unrelated.usage_id));

  for(const row of rowsA) {
    const refs=(await db.query(
      'select private.ai_gateway_r5_row_candidates($1,$2,$3::jsonb) ids',
      [tenantA.companyId,row.adapter,JSON.stringify(row.row_data)],
    )).rows[0].ids;
    assert.deepEqual(refs,[tenantA.candidate.id]);
  }
  await assert.rejects(db.query(
    'select private.ai_gateway_r5_row_candidates($1,$2,$3::jsonb)',
    [tenantB.companyId,'public.ai_gateway_usage',JSON.stringify(rowsA[1].row_data)],
  ),e=>e.code==='PT409');
  await assert.rejects(db.query(
    'select private.ai_gateway_r5_row_candidates($1,$2,$3::jsonb)',
    [tenantA.companyId,'private.ai_gateway_candidate_links',
      JSON.stringify({...rowsA[0].row_data,candidate_id:tenantB.candidate.id})],
  ),e=>e.code==='PT409');

  // Outstanding provider charges block signed erasure; a settled invoice
  // preserves the explicit candidate inventory and becomes reconcilable.
  await assert.rejects(db.query(
    'select private.ai_gateway_r5_assert_reconciled($1,$2::uuid[])',
    [tenantA.companyId,[tenantA.candidate.id]],
  ),e=>e.code==='PT409');
  await db.query(
    'select public.ai_gateway_settle($1,$2,90,250,0,80,$3)',
    [tenantA.companyId,a.id,'response-sc021-r5-test'],
  );
  assert.equal((await db.query(
    'select private.ai_gateway_r5_assert_reconciled($1,$2::uuid[]) n',
    [tenantA.companyId,[tenantA.candidate.id]],
  )).rows[0].n,1);
  await assert.rejects(db.query(
    'select private.ai_gateway_r5_assert_reconciled($1,$2::uuid[])',
    [tenantA.companyId,[tenantB.candidate.id]],
  ),e=>e.code==='PT409');

  // R4's existing immutable baseline and candidate-erasure preview must
  // continue failing closed, irrespective of this staged R5 adapter.
  const schema=(await db.query(
    'select schema_signature expected,private.erasure_schema_signature() actual from private.erasure_inventory_baseline_r4 where singleton',
  )).rows[0];
  assert.notEqual(schema.expected,schema.actual);

  await h.asUser(tenantA.owner);
  await assert.rejects(db.query(
    'select * from private.ai_gateway_r5_inventory_rows($1,$2::uuid[])',
    [tenantA.companyId,[tenantA.candidate.id]],
  ),e=>e.code==='42501');
  const preview=(await db.query(
    "select public.preview_candidate_erasure($1,'candidate_record',null) value",
    [tenantA.candidate.id],
  )).rows[0].value;
  assert.ok(preview.blockers.includes('schema_dependency_unknown'));
});
