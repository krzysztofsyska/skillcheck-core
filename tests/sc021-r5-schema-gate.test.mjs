import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {setupRankingDatabase, users} from './helpers/screening-ranking-fixture.mjs';

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

  // Codex P1: attempting to build the staged signing source while provider
  // usage is reserved must fail BEFORE any manifest can be produced.
  await assert.rejects(db.query(
    'select * from private.erasure_purge_rows_sc021_r5($1,$2::uuid[])',
    [tenantA.companyId,[tenantA.candidate.id]],
  ),e=>e.code==='PT409' && /SC021_UNRECONCILED_CANDIDATE_USAGE/.test(e.message));

  // Candidate worker capabilities must never create an unbound generic entry.
  await db.exec('set role ai_meter_worker');
  await assert.rejects(db.query(
    'select * from public.ai_gateway_reserve(' +
    '$1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::text,' +
    '$7::text,$8::text,$9::text,$10::text,$11::bigint)',
    [tenantA.companyId,randomUUID(),randomUUID(),null,null,'cv_screening',
      'openai','synthetic-test-model','policy-test','price-test',5],
  ),e=>e.code==='42501');
  await h.asAdmin();

  // The original R4 function still performs candidate locks and shared
  // administrative checks; the staged R5 wrapper must call it FIRST.
  const executionId=randomUUID();
  await db.query(
    "insert into private.erasure_executions ("+
      "request_id,company_id,candidate_ids,scope_kind,owner_id,policy_copy,"+
      "resolution_revision,generation,phase,recovery_retain_until) "+
      "values ($1,$2,$3::uuid[],'candidate_record',$4,$5::jsonb,0,1,'authorized',now()+interval '30 days')",
    [executionId,tenantA.companyId,[tenantA.candidate.id],tenantA.owner,JSON.stringify({revision:0})],
  );
  await assert.rejects(db.query(
    'select private.erasure_check_purge_scope_sc021_r5($1)',
    [executionId],
  ),e=>e.code==='PT409' && /SC021_UNRECONCILED_CANDIDATE_USAGE/.test(e.message));
  await assert.rejects(db.query(
    'select private.ai_gateway_r5_prepare_gate($1)',
    [executionId],
  ),e=>e.code==='PT409');

  // An open erasure execution freezes the candidate. Settlement must use the
  // candidate-bound RPC, which refuses that lock, so release the execution
  // only for the ledger close and restore it before the success-path scope check.
  await db.query("update private.erasure_executions set phase='cancelled' where request_id=$1",[executionId]);
  await assert.rejects(db.query(
    'select public.ai_gateway_settle($1,$2,90,250,0,80,$3)',
    [tenantA.companyId,a.id,'response-sc021-r5-test'],
  ),e=>/SC021_CANDIDATE_BINDING_REQUIRED/.test(e.message));
  await db.query(
    'select private.ai_gateway_settle_candidate($1,$2,$3,90,250,0,80,$4)',
    [tenantA.companyId,tenantA.candidate.id,a.id,'response-sc021-r5-test'],
  );
  await db.query("update private.erasure_executions set phase='authorized' where request_id=$1",[executionId]);
  assert.equal((await db.query(
    'select private.ai_gateway_r5_assert_reconciled($1,$2::uuid[]) n',
    [tenantA.companyId,[tenantA.candidate.id]],
  )).rows[0].n,1);
  await db.query('select private.erasure_check_purge_scope_sc021_r5($1)',[executionId]);
  // No R5 baseline exists. A real irreversible manifest cannot be issued yet.
  await assert.rejects(db.query(
    'select private.ai_gateway_r5_prepare_gate($1)',[executionId],
  ),e=>e.code==='PT409' && /SC021_R5_BASELINE_NOT_REVIEWED/.test(e.message));

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

  // Earlier regression already rejects reserved usage BEFORE manifest.
  // Once settled, the same candidate remains a single reconciled subject.
  assert.equal((await db.query(
    'select private.ai_gateway_r5_assert_reconciled($1,$2::uuid[]) as n',
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

  await h.asAdmin();
  await db.exec('set role erasure_purge_owner');
  await assert.rejects(db.query(
    'select * from private.ai_gateway_r5_inventory_rows($1,$2::uuid[])',
    [tenantB.companyId,[tenantB.candidate.id]],
  ),e=>e.code==='42501');
  await h.asAdmin();

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


test('SC-021/SC-005 trusted lease-bound screening reservation derives tenant and candidate from DB',async t=>{
  const db=new PGlite({extensions:{pgcrypto}});
  t.after(()=>db.close());
  const h=await setupRankingDatabase(db);
  const a=await h.seed();
  const b=await h.seed(users.otherOwner);
  await h.asAdmin();
  for (const path of [
    '../db/prototypes/sc021-ai-gateway-ledger.sql',
    '../db/prototypes/sc021-r5-anonymous-erasure.sql',
    '../db/prototypes/sc021-r5-erasure-inventory-adapter.sql',
    '../db/prototypes/sc021-r5-sc005-lease-bound-reservation.sql',
  ]) await db.exec(readFileSync(new URL(path,import.meta.url),'utf8'));

  await db.query('insert into public.ai_gateway_limits(company_id,monthly_limit_micro_usd) values ($1,10000),($2,10000)',[a.companyId,b.companyId]);
  const started=await h.start(a);
  const claimed=await h.claim(started); // trusted DB-generated lease in screening_worker claim
  assert.ok(claimed.lease_token);
  const rpc='select * from public.ai_gateway_reserve_screening_attempt('+
    '$1::uuid,$2::text,$3::text,$4::text,$5::text,$6::text,$7::text,$8::bigint)';
  const signature=(await db.query(
    "select pg_get_function_identity_arguments(p.oid) as args from pg_proc p "+
    "join pg_namespace n on n.oid=p.pronamespace "+
    "where n.nspname='public' and p.proname='ai_gateway_reserve_screening_attempt'",
  )).rows;
  assert.equal(signature.length,1);
  assert.equal(signature[0].args,
    'target_attempt uuid, target_lease_token text, target_input_fingerprint text, expected_provider text, expected_model text, expected_policy_version text, expected_price_version text, expected_micro_usd bigint');
  await h.asAdmin();
  const idempotencyKey=(await db.query(
    'select idempotency_key from public.screening_analysis_attempts where id=$1',
    [started.attempt_id],
  )).rows[0].idempotency_key;
  await h.asWorker();
  const args=[
    started.attempt_id,claimed.lease_token,claimed.input_fingerprint,
    claimed.provider,claimed.model,'test-policy-v1','test-pricing-v1',100,
  ];
  await assert.rejects(db.query(rpc,[
    ...args.slice(0,1),'wrong-token',...args.slice(2),
  ]),e=>e.code==='42501');
  await assert.rejects(db.query(rpc,[
    ...args.slice(0,2),'wrong-fingerprint',...args.slice(3),
  ]),e=>e.code==='42501');
  await assert.rejects(db.query(rpc,[
    ...args.slice(0,3),'different-provider',...args.slice(4),
  ]),e=>e.code==='42501');

  const first=(await db.query(rpc,args)).rows[0];
  assert.equal(first.created,true);
  assert.equal(first.company_id,a.companyId);
  assert.equal(first.request_key,idempotencyKey);
  assert.equal('candidate_id' in first,false);
  const replay=(await db.query(rpc,args)).rows[0];
  assert.equal(replay.created,false);
  assert.equal(replay.usage_id,first.usage_id);
  assert.equal(replay.request_key,idempotencyKey);
  // A restricted worker must never read the private candidate identity
  // mapping table; inspect state solely as synthetic test DB administrator.
  await h.asAdmin();
  const stored=(await db.query(
    'select u.company_id,u.operation_id,u.process_id,u.request_key,l.candidate_id '+
      'from public.ai_gateway_usage u join private.ai_gateway_candidate_links l '+
      'on l.company_id=u.company_id and l.usage_id=u.id where u.request_key=$1',
    [idempotencyKey],
  )).rows[0];
  assert.equal(stored.company_id,a.companyId);
  assert.equal(stored.candidate_id,a.candidate.id);
  assert.equal(stored.operation_id,started.analysis_id);
  assert.equal(stored.process_id,a.recruitment.id);
  assert.equal((await db.query(
    'select count(*)::int n from public.ai_gateway_usage where company_id=$1',[a.companyId],
  )).rows[0].n,1);
  const binding=(await db.query(
    'select company_id,request_key,usage_id from private.ai_gateway_screening_attempt_reservations where attempt_id=$1',
    [started.attempt_id],
  )).rows[0];
  assert.equal(binding.company_id,a.companyId);
  assert.equal(binding.request_key,idempotencyKey);
  assert.equal(binding.usage_id,first.usage_id);

  await h.asWorker();
  await assert.rejects(db.query(
    'select * from private.ai_gateway_screening_attempt_reservations'),e=>e.code==='42501');
  await assert.rejects(db.query(
    'select * from public.ai_gateway_reserve(' +
    '$1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::text,' +
    '$7::text,$8::text,$9::text,$10::text,$11::bigint)',
    [a.companyId,randomUUID(),randomUUID(),null,null,'cv_screening',
      'openai','synthetic-test-model','policy-test','price-test',5],
  ),e=>e.code==='42501');
  await assert.rejects(db.query(rpc,[
    ...args.slice(0,4),'wrong-model',...args.slice(5),
  ]),e=>e.code==='42501');
  await assert.rejects(db.query(rpc,[
    randomUUID(),...args.slice(1),
  ]),e=>e.code==='42501');

  await h.asUser(a.owner);
  await assert.rejects(db.query(rpc,args),e=>e.code==='42501');
  await h.asAdmin();
  await db.exec('set role ai_meter_worker');
  await assert.rejects(db.query(rpc,args),e=>e.code==='42501');
  await h.asAdmin();

  const leftovers=(await db.query('select count(*)::int n from public.ai_gateway_usage where company_id=$1',[b.companyId])).rows[0].n;
  assert.equal(leftovers,0);

  // An application change that commits during reservation, after the first
  // stale check and before the candidate lock is released, must roll the
  // usage row back. The trigger fires inside reserve_candidate, while that
  // lock is already held, and leaves attempt status as processing.
  const fresh=await h.candidate({
    owner:a.owner,companyId:a.companyId,position:a.position,recruitment:a.recruitment,
  });
  const staleStarted=await h.start(fresh);
  const staleClaimed=await h.claim(staleStarted);
  await h.asAdmin();
  await db.exec(`
    create function private.sc021_test_touch_application_on_usage()
    returns trigger language plpgsql security definer set search_path='' as $fn$
    begin
      update public.applications set status=status
      where id=(
        select application_id from public.screening_analysis_versions
        where id=new.operation_id and company_id=new.company_id
      );
      return new;
    end $fn$;
    create trigger sc021_test_stale_during_reserve
    after insert on public.ai_gateway_usage
    for each row execute function private.sc021_test_touch_application_on_usage();
  `);
  try {
    await h.asWorker();
    await assert.rejects(db.query(rpc,[
      staleStarted.attempt_id,staleClaimed.lease_token,staleClaimed.input_fingerprint,
      staleClaimed.provider,staleClaimed.model,'test-policy-v1','test-pricing-v1',100,
    ]),e=>e.code==='42501' && /SC021_SCREENING_INPUT_STALE/.test(e.message));
  } finally {
    await h.asAdmin();
    await db.exec('drop trigger sc021_test_stale_during_reserve on public.ai_gateway_usage');
    await db.exec('drop function private.sc021_test_touch_application_on_usage()');
  }
  assert.equal((await db.query(
    'select count(*)::int n from public.ai_gateway_usage where operation_id=$1',
    [staleStarted.analysis_id],
  )).rows[0].n,0);
  assert.equal((await db.query(
    'select count(*)::int n from private.ai_gateway_screening_attempt_reservations where attempt_id=$1',
    [staleStarted.attempt_id],
  )).rows[0].n,0);

  const fresher=await h.candidate({
    owner:a.owner,companyId:a.companyId,position:a.position,recruitment:a.recruitment,
  });
  const early=await h.start(fresher);
  const earlyClaim=await h.claim(early);
  await h.asAdmin();
  await db.query('update public.applications set status=status where id=$1',[fresher.application.id]);
  await h.asWorker();
  await assert.rejects(db.query(rpc,[
    early.attempt_id,earlyClaim.lease_token,earlyClaim.input_fingerprint,
    earlyClaim.provider,earlyClaim.model,'test-policy-v1','test-pricing-v1',100,
  ]),e=>e.code==='42501' && /SC021_SCREENING_CLAIM_INVALID/.test(e.message));
  await h.asAdmin();
  assert.equal((await db.query(
    'select count(*)::int n from public.ai_gateway_usage where operation_id=$1',[early.analysis_id],
  )).rows[0].n,0);
});
