import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {boot, SC011B2_DISPATCH_SCHEMA, SC011B3_TRANSCRIPT_SCHEMA} from './helpers/voice-preparation-fixture.mjs';
import {syntheticRetellProof} from './helpers/voice-preparation-provider-fixture.mjs';
import {
  prepareOfflineVoiceDraft, cancelOfflineVoicePreparation,
} from '../lib/voice/offline-preparation.ts';

const tableNames = Object.freeze([
  'private.voice_plan_template_catalog',
  'private.voice_interview_permission_policies',
  'private.voice_interview_permission_issuers',
  'private.voice_interview_permission_receipts',
  'private.voice_interview_permission_revocations',
  'private.sc19_voice_entitlements',
  'private.sc010c_voice_preparations',
  'private.sc010c_voice_preparation_requests',
  'private.sc011b_voice_attempts',
  'private.sc011b_voice_webhook_receipts',
  'private.sc011b_voice_transcripts',
]);
const signatures = Object.freeze([
  'private.sc012b_review_plan(uuid,bigint,text,text,text,uuid)',
  'private.sc012b_assert_fresh_write()',
  'private.sc012b_release_plan(uuid,uuid,text,bigint,uuid,uuid)',
  'private.sc012b_current_release(uuid)',
  'private.voice_interview_permission_protect_history()',
  'private.voice_interview_permission_protect_registry()',
  'private.voice_interview_permission_lock_revocation()',
  'private.voice_interview_permission_status(uuid,uuid,uuid)',
  'private.ingest_voice_interview_permission_receipt(jsonb)',
  'private.sc19_voice_entitlement_eligible(private.sc19_voice_entitlements)',
  'private.sc19_voice_entitlement_guard()',
  'private.sc010c_preparation_guard()',
  'private.sc010c_request_guard()',
  'private.sc010c_lock_voice_contact(uuid,uuid,uuid,uuid)',
  'private.sc010c_preparation_current_guard()',
  'private.sc011b_attempt_guard()',
  'private.sc011b_receipt_guard()',
  'private.sc011b_block_cancel_after_dispatch()',
  'private.sc011b_transcript_guard()',
  'private.sc011b_purge_voice_transcripts()',
]);
const ingestionSignature = 'private.ingest_voice_interview_permission_receipt(jsonb)';
const roleCandidates = Object.freeze([
  'pg_read_all_stats', 'pg_monitor', 'anon', 'authenticated', 'screening_worker',
  'contact_verifier', 'voice_permission_verifier', 'service_role', 'erasure_worker',
  'erasure_ledger_attestor', 'erasure_restore_attestor', 'erasure_purge_owner', 'erasure_scheduler',
]);
const quoteIdentifier = value => '"' + value.replaceAll('"', '""') + '"';
const defaults = async db => (await db.query(`
  select defaclrole,defaclnamespace,defaclobjtype,defaclacl::text
  from pg_catalog.pg_default_acl order by defaclrole,defaclnamespace,defaclobjtype
`)).rows;
const permissionDenied = description => error => {
  assert.equal(error.code, '42501', description);
  assert.match(error.message, /permission denied for (table|function)/, description);
  return true;
};

test('SC010/012/019: inherited default grants cannot expose offline authority', async t => {
  let defaultsBefore, hostileRoles;
  const env = await boot(t, {extraSchemas: [SC011B2_DISPATCH_SCHEMA, SC011B3_TRANSCRIPT_SCHEMA], beforeIsolated: async db => {
    // Change only the disposable database's defaults for its creating owner.
    // Existing predefined/worker roles avoid cluster-wide role or membership edits.
    hostileRoles = (await db.query(`select rolname from pg_catalog.pg_roles
      where rolname=any($1::text[]) and not rolsuper order by rolname`,
    [['pg_read_all_stats', 'service_role', 'erasure_worker', 'voice_permission_verifier']])).rows.map(row => row.rolname);
    assert.ok(hostileRoles.includes('pg_read_all_stats'), 'PostgreSQL predefined role is required');
    const roles = hostileRoles.map(quoteIdentifier).join(',');
    // Deliberately permit schema resolution: a 42501 must name the object, not
    // merely its private schema. Grant options exercise complete ACL removal.
    await db.exec(`grant usage on schema private to public;
      alter default privileges in schema private grant all on tables to public;
      alter default privileges in schema private grant execute on functions to public;
      alter default privileges in schema private grant all on tables to ${roles} with grant option;
      alter default privileges in schema private grant execute on functions to ${roles} with grant option;
      create table private.offline_acl_unrelated_probe(id integer);
      create function private.offline_acl_unrelated_probe() returns integer language sql as 'select 17'`);
    defaultsBefore = await defaults(db);
  }});
  const {db} = env;
  const roles = (await db.query(`select rolname from pg_catalog.pg_roles
    where rolname=any($1::text[]) and not rolsuper order by rolname`, [roleCandidates])).rows.map(row => row.rolname);
  const originalFetch = globalThis.fetch;
  let externalCalls = 0;
  globalThis.fetch = async () => {externalCalls++; throw new Error('External network forbidden');};
  t.after(() => {globalThis.fetch = originalFetch;});

  await t.test('only object owners and the dedicated signed-receipt entry point retain grants', async () => {
    const relations = (await db.query(`select c.oid::regclass::text as name,c.relrowsecurity,c.relforcerowsecurity
      from pg_catalog.pg_class c where c.oid=any($1::regclass[]) order by name`, [tableNames])).rows;
    assert.equal(relations.length, tableNames.length);
    assert.ok(relations.every(row => row.relrowsecurity && row.relforcerowsecurity));
    const tableGrants = (await db.query(`select c.oid::regclass::text as name,a.grantee,a.privilege_type,a.is_grantable
      from pg_catalog.pg_class c
      cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      where c.oid=any($1::regclass[]) and a.grantee<>c.relowner order by name,a.grantee,a.privilege_type`,
    [tableNames])).rows;
    assert.deepEqual(tableGrants, [], 'Default grants must not survive on any new private table');
    assert.equal((await db.query('select count(*)::int n from pg_catalog.pg_proc where oid=any($1::regprocedure[])',
      [signatures])).rows[0].n, signatures.length);
    const functionGrants = (await db.query(`select p.oid::regprocedure::text as signature,
        pg_catalog.pg_get_userbyid(a.grantee) as recipient,a.privilege_type,a.is_grantable
      from pg_catalog.pg_proc p
      cross join lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      where p.oid=any($1::regprocedure[]) and a.grantee<>p.proowner
      order by signature,recipient,a.privilege_type`, [signatures])).rows;
    assert.deepEqual(functionGrants, [{signature: ingestionSignature,
      recipient: 'voice_permission_verifier', privilege_type: 'EXECUTE', is_grantable: false}]);
  });

  await t.test('effective privileges deny arbitrary roles, inherited members, and existing workers', async () => {
    assert.ok(roles.includes('pg_monitor'));
    assert.equal((await db.query("select pg_catalog.pg_has_role('pg_monitor','pg_read_all_stats','USAGE') as inherited")).rows[0].inherited, true);
    for (const role of roles) {
      const tables = (await db.query(`select name,
          pg_catalog.has_table_privilege($1,name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as allowed
        from unnest($2::text[]) name`, [role, tableNames])).rows;
      assert.ok(tables.every(row => !row.allowed), role + ': no table privilege, including inherited or PUBLIC');
      const functions = (await db.query(`select signature,
          pg_catalog.has_function_privilege($1,signature,'EXECUTE') as allowed,
          pg_catalog.has_function_privilege($1,signature,'EXECUTE WITH GRANT OPTION') as grantable
        from unnest($2::text[]) signature`, [role, signatures])).rows;
      for (const row of functions) {
        assert.equal(row.allowed, role === 'voice_permission_verifier' && row.signature === ingestionSignature,
          role + ': ' + row.signature);
        assert.equal(row.grantable, false, role + ': no delegated authority for ' + row.signature);
      }
    }
  });

  let subject, prepared;
  await t.test('signed verification and the trusted server still prepare and replay one reserved UUID', async () => {
    subject = await env.ready();
    await env.asServer(subject.f.owner);
    const proof = await syntheticRetellProof();
    assert.equal(proof.calls.length, 2);
    assert.ok(proof.calls.every(call => call.method === 'GET'));
    const dependencies = subject.deps(proof.retell, proof.verifiedAgent);
    prepared = await prepareOfflineVoiceDraft(db, subject.context, subject.request, dependencies);
    const replay = await prepareOfflineVoiceDraft(db, subject.context,
      {...subject.request, requestKey: randomUUID()}, dependencies);
    assert.equal(prepared.state, 'prepared_offline');
    assert.equal(prepared.preflightOnly, true);
    assert.equal(prepared.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.operationId, prepared.operationId);
    assert.equal(replay.draft.payload.idempotency_key, prepared.draft.payload.idempotency_key);
    const row = (await db.query(`select used,reserved from private.sc19_voice_entitlements where id=$1`,
      [subject.request.entitlementId])).rows[0];
    assert.deepEqual(row, {used: 0, reserved: 1});
    assert.equal(externalCalls, 0);
  });

  await t.test('direct table CRUD and private authority calls are denied before evaluating payloads', async () => {
    assert.ok(subject && prepared, 'A valid signed/reviewed/reserved fixture is required');
    const directCalls = [
      ['select private.sc012b_review_plan($1,1,$2,\'approved\',null,$3)',
        [subject.request.planId, subject.f.source.sourceHash, randomUUID()]],
      ['select private.sc012b_release_plan($1,$2,$3,$4,$5,$6)',
        [subject.request.planId, subject.f.planReviewId, subject.f.source.sourceHash,
          subject.request.pointerVersion, subject.request.releaseId, randomUUID()]],
      ['select private.sc012b_current_release($1)', [subject.f.application.id]],
      ['select private.voice_interview_permission_status($1,$2,$3)',
        [subject.f.application.id, subject.f.contactReceiptId, subject.request.permissionReceiptId]],
      ['select private.sc19_voice_entitlement_eligible(null::private.sc19_voice_entitlements)', []],
      ['select private.sc010c_lock_voice_contact($1,$2,$3,$4)',
        [subject.f.companyId, subject.request.communicationId, subject.request.approvalId, subject.request.permissionReceiptId]],
    ];
    // These trigger functions are not public capabilities either. In particular,
    // the new deferred currentness guard must not inherit the default EXECUTE.
    for (const signature of signatures.filter(value => value.endsWith('()'))) {
      directCalls.push(['select ' + signature, []]);
    }
    for (const role of roles) {
      await env.asServer(subject.f.owner);
      await db.exec('set role ' + quoteIdentifier(role));
      try {
        for (const name of tableNames) {
          const column = name === 'private.voice_plan_template_catalog' ? 'version' : 'company_id';
          for (const sql of [
            'select * from ' + name,
            'insert into ' + name + ' default values',
            'update ' + name + ' set ' + column + '=' + column,
            'delete from ' + name,
            'truncate table ' + name,
          ]) await assert.rejects(db.query(sql), permissionDenied(role + ': ' + sql));
        }
        for (const [sql, params] of directCalls) {
          await assert.rejects(db.query(sql, params), permissionDenied(role + ': ' + sql));
        }
        if (role !== 'voice_permission_verifier') {
          // A well-formed raw receipt deliberately bypasses the server signature
          // verifier. Legacy/default-granted roles must not enter its SQL sink.
          await assert.rejects(db.query('select private.ingest_voice_interview_permission_receipt($1::jsonb)',
            [JSON.stringify(subject.f.permissionReceipt)]), permissionDenied(role + ': raw receipt ingestion'));
        }
      } finally {await env.asServer(subject.f.owner);}
    }
  });

  await t.test('failed direct accesses leave the reservation intact and trusted cancellation releases it once', async () => {
    assert.ok(subject && prepared);
    await env.asServer(subject.f.owner);
    assert.equal((await db.query('select reserved from private.sc19_voice_entitlements where id=$1',
      [subject.request.entitlementId])).rows[0].reserved, 1);
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual(await cancelOfflineVoicePreparation(db, subject.context, prepared.operationId),
        {operationId: prepared.operationId, state: 'cancelled_offline'});
    }
    assert.deepEqual((await db.query('select used,reserved,revision from private.sc19_voice_entitlements where id=$1',
      [subject.request.entitlementId])).rows[0], {used: 0, reserved: 0, revision: '3'});
    assert.equal((await db.query('select count(*)::int n from private.sc010c_voice_preparations where company_id=$1',
      [subject.f.companyId])).rows[0].n, 1);
    assert.equal(externalCalls, 0);
  });

  await t.test('closures leave owner defaults and unrelated objects unchanged', async () => {
    await env.asServer();
    assert.deepEqual(await defaults(db), defaultsBefore);
    for (const role of hostileRoles) {
      const row = (await db.query(`select
        pg_catalog.has_table_privilege($1,'private.offline_acl_unrelated_probe','INSERT WITH GRANT OPTION') as table_grant,
        pg_catalog.has_function_privilege($1,'private.offline_acl_unrelated_probe()','EXECUTE WITH GRANT OPTION') as function_grant`,
      [role])).rows[0];
      assert.deepEqual(row, {table_grant: true, function_grant: true}, role);
    }
    await db.exec('set role pg_monitor');
    try {
      await db.query('insert into private.offline_acl_unrelated_probe values (1)');
      assert.equal((await db.query('select private.offline_acl_unrelated_probe() as n')).rows[0].n, 17);
    } finally {await env.asServer();}
  });
});
