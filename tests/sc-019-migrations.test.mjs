import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setupRankingDatabase, users } from './helpers/screening-ranking-fixture.mjs';
import { lifecycleHarness } from './helpers/erasure-lifecycle-fixture.mjs';
import { retentionHarness } from './helpers/retention-scheduler-fixture.mjs';
import {
  accountingSnapshot, accountingTables, applyMigration, assertR6, blockersOf,
  bootMigrationDatabase, catalogSnapshot, installSource, paymentHarness, paymentUsers,
  seedCreditData, seedHistoricalOrders, seedSyntheticPolicy, sourceStates,
} from './helpers/sc19-migration-fixture.mjs';

// These are actual checked-in migrations on disposable native PostgreSQL. The
// URL and major version are mandatory: absence is a failure, never a skip.
const boot = async (t, state = 'r4_legacy') => installSource(await bootMigrationDatabase(t), state);
const rows = async (db, table) => (await db.query(`select to_jsonb(t) value from ${table} t order by to_jsonb(t)::text collate "C"`)).rows;
const denied = error => error.code === '42501';

async function assertRefusal(env, message = /sc19_source_schema_unreviewed/, code = '55000') {
  await env.h.asAdmin();
  const before = { catalog: await catalogSnapshot(env.db), accounting: await accountingSnapshot(env.db) };
  await assert.rejects(applyMigration(env.db), error => error.code === code && message.test(error.message));
  assert.deepEqual(await catalogSnapshot(env.db), before.catalog, 'Failed migration is catalog-atomic');
  assert.deepEqual(await accountingSnapshot(env.db), before.accounting, 'Failed migration preserves all accounting rows');
  assert.equal((await env.db.query("select to_regclass('private.erasure_inventory_baseline_r6') name")).rows[0].name, null);
}

for (const state of sourceStates) test(`SC-019 migration accepts the pinned ${state} upgrade without rewriting data`, async t => {
  const env = await boot(t, state), { db, h } = env;
  let fixtures;
  if (state.startsWith('r5_')) fixtures = await seedCreditData(env);
  else if (state.startsWith('orders')) fixtures = await seedHistoricalOrders(env);
  else fixtures = { first: await h.seed(), second: await h.seed(users.otherOwner) };
  await h.asAdmin();
  const before = await accountingSnapshot(db);
  const history = {};
  for (const table of ['erasure_inventory_baseline', 'erasure_inventory_baseline_r2', 'erasure_inventory_baseline_r3', 'erasure_inventory_baseline_r4']) {
    history[table] = await rows(db, `private.${table}`);
  }
  await applyMigration(db);
  await assertR6(db, state.endsWith('_voice') ? 'voice' : 'legacy');
  const after = await accountingSnapshot(db);
  if (state.startsWith('r4_')) assert.deepEqual(after.sc19_package_policy, [], 'Fresh migration must not choose package quantities');
  for (const [table, values] of Object.entries(before)) {
    if (table === 'sc19_payment_requests') {
      for (const value of values) assert.ok(after[table].some(row => JSON.stringify(row) === JSON.stringify(value)), 'Existing recovery aliases are immutable');
    } else assert.deepEqual(after[table], values, `${state} preserves ${table} byte-for-byte`);
  }
  for (const [table, values] of Object.entries(history)) assert.deepEqual(await rows(db, `private.${table}`), values);
  if (state.startsWith('r5_')) {
    assert.deepEqual((await db.query('select plan,credits from private.sc19_package_policy order by plan')).rows,
      [{ plan: 'FREE', credits: 7 }, { plan: 'PRESELEKCJA', credits: 23 }]);
  }
  if (state.startsWith('orders')) {
    for (const order of fixtures.orders) {
      assert.equal((await db.query('select order_id from private.sc19_payment_requests where company_id=$1 and request_id=$2',
        [order.tenant.companyId, order.requestId])).rows[0].order_id, order.id);
    }
    assert.equal(after.sc19_payment_requests.length, state === 'orders129_legacy' ? 2 : 3);
  }
  const x = retentionHarness(h);
  for (const f of [fixtures.first, fixtures.second]) {
    await h.asUser(f.owner);
    assert.equal(blockersOf(await x.preview(f)).includes('schema_dependency_unknown'), false);
    assert.equal(blockersOf(await x.scheduleStatus(f)).includes('schema_dependency_unknown'), false);
  }
});

test('SC-019 migration is exercised by the complete current migration chain', async t => {
  const env = await bootMigrationDatabase(t);
  await setupRankingDatabase(env.db, { throughMigration: null });
  await assertR6(env.db);
  await assert.rejects(env.db.query("update private.erasure_inventory_baseline_r6 set schema_signature=repeat('a',64)"), /immutable/i);
  for (const table of accountingTables) {
    assert.equal((await env.db.query(`select count(*)::int n from private.${table}`)).rows[0].n, 0, 'Fresh install creates no policy/sales/approval/balance');
  }
  const { db, h } = env, f = await h.seed(); await h.asAdmin();
  await assert.rejects(db.query('select private.sc19_grant_paid($1,$2)', [f.companyId, 'synthetic-missing-policy-grant']), /sc19_missing_paid_policy/);
  await db.query(`insert into private.sc19_trial_approvals(company_id,nip,proof_reference)
    values($1,'1234563218','synthetic-missing-policy-proof')`, [f.companyId]);
  await h.asUser(f.owner);
  await assert.rejects(db.query("select public.sc19_claim_trial($1,'1234563218')", [f.companyId]), /sc19_missing_free_policy/);
  await h.asUser(null, 'anon');
  assert.deepEqual((await db.query('select * from public.sc19_package_sizes()')).rows, []);
  const after = await accountingSnapshot(db);
  for (const table of ['sc19_balances', 'sc19_trial_nips', 'sc19_credit_journal']) assert.deepEqual(after[table], []);
});

const driftCases = [
  ['unreviewed table', 'r4_legacy', 'create table public.unreviewed_candidate_copy(candidate_id uuid)'],
  ['unreviewed view', 'r4_legacy', 'create view public.unreviewed_candidates as select id from public.candidates'],
  ['changed reviewed view body', 'r4_legacy', `create or replace view public.latest_behavior_assessments with (security_invoker=true) as
    select distinct on (company_id,application_id,area_key) * from public.behavior_assessment_entries where false
    order by company_id,application_id,area_key,version desc`, 'rewrites'],
  ['extra view rewrite rule', 'r4_legacy', 'create rule sc19_unreviewed_update as on update to public.latest_behavior_assessments do instead nothing', 'rewrites'],
  ['incoming foreign key from a third schema', 'r4_legacy', 'create schema unrelated; create table unrelated.incoming(candidate_id uuid references public.candidates(id))'],
  ['unknown billing column', 'r5_legacy', 'alter table private.sc19_balances add column unreviewed_note text'],
  ['partial credit schema', 'r5_legacy', 'drop table private.sc19_trial_approvals'],
  ['unreviewed routine', 'r4_legacy', "create or replace function private.erasure_schema_signature() returns text language sql stable security definer set search_path='' as $$select 'd2e7725bd5051e15cb7e700a128026a3ad6f0d87f9d3bba3de8e1539c9d3eabd'::text$$; create table public.signature_spoof(id uuid)"],
  ['missing unresolved unique index', 'orders152_legacy', 'drop index private.sc19_payment_one_unresolved'],
  ['incorrect unresolved predicate', 'orders152_legacy', "drop index private.sc19_payment_one_unresolved; create unique index sc19_payment_one_unresolved on private.sc19_payment_orders(company_id) where status='paid'"],
  ['disabled immutable trigger', 'orders152_legacy', 'alter table private.sc19_payment_orders disable trigger user'],
  ['disabled RLS', 'r5_legacy', 'alter table private.sc19_balances disable row level security'],
  ['unexpected RLS policy', 'r5_legacy', 'create policy forbidden_read on private.sc19_balances for select to authenticated using(true)'],
  ['extra private SC-010 execute grant', 'r4_legacy', 'grant execute on function private.purge_candidate_erasure(uuid,bigint) to authenticated'],
  ['extra SC-010 column privilege', 'r4_legacy', 'grant select(candidate_ids) on private.erasure_executions to authenticated'],
  ['unsafe schema CREATE grant', 'r4_legacy', 'grant create on schema private to authenticated'],
];
for (const [label, state, sql, fingerprint] of driftCases) test(`SC-019 migration refuses ${label} atomically`, async t => {
  const env = await boot(t, state), before = fingerprint ? await catalogSnapshot(env.db) : null;
  await env.db.query(sql);
  if (fingerprint) assert.notEqual((await catalogSnapshot(env.db))[fingerprint], before[fingerprint]);
  await assertRefusal(env);
});

test('SC-019 migration refuses owner-rights views and accepts the canonical two-tenant boundary', async t => {
  const env = await boot(t), { db, h } = env, first = await h.seed(), second = await h.seed(users.otherOwner);
  for (const f of [first, second]) {
    await h.asUser(f.owner);
    await db.query("update public.positions set required_behaviors=array['Odpowiedzialność: Standardowy'] where id=$1", [f.position.id]);
    const stamp = (await db.query('select updated_at::text value from public.positions where id=$1', [f.position.id])).rows[0].value;
    await db.query('select public.save_behavior_assessment($1,$2,$3,$4,$5,$6,$7)',
      [f.application.id, 'responsibility', 'meets', 'SYNTHETIC tenant-scoped assessment', 0, stamp, f.position.id]);
  }
  await h.asUser(first.owner);
  assert.deepEqual((await db.query('select company_id from public.latest_behavior_assessments')).rows, [{ company_id: first.companyId }]);
  const before = await catalogSnapshot(db);
  await db.query('alter view public.latest_behavior_assessments set (security_invoker=false)');
  const changed = await catalogSnapshot(db);
  assert.equal(changed.sc010_signature, before.sc010_signature, 'SC-010 relation layout alone does not capture view security');
  assert.notEqual(changed.relations, before.relations, 'Reviewed relation options close the security-invoker gap');
  await h.asUser(first.owner);
  assert.deepEqual(new Set((await db.query('select company_id from public.latest_behavior_assessments')).rows.map(row => row.company_id)),
    new Set([first.companyId, second.companyId]), 'Unsafe source really exposes the second tenant');
  await assertRefusal(env);
  await db.query('alter view public.latest_behavior_assessments set (security_invoker=true)');
  await applyMigration(db); await assertR6(db);
  await h.asUser(first.owner);
  assert.deepEqual((await db.query('select company_id from public.latest_behavior_assessments')).rows, [{ company_id: first.companyId }]);
});

test('SC-019 migration fingerprints rewrite firing mode and refuses an unreviewed rule', async t => {
  const env = await boot(t), { db } = env;
  await db.query('create rule sc19_unreviewed_update as on update to public.candidates do instead nothing');
  const before = await catalogSnapshot(db);
  await db.query('alter table public.candidates enable replica rule sc19_unreviewed_update');
  const after = await catalogSnapshot(db);
  assert.notEqual(after.rewrites, before.rewrites, 'Rule ev_enabled must be part of the committed fingerprint contract');
  assert.deepEqual({ ...after, rewrites: before.rewrites }, before, 'Only rewrite firing mode changed');
  await assertRefusal(env);
});

test('SC-019 migration refuses a disabled internal payment FK trigger', async t => {
  const env = await boot(t, 'orders152_legacy');
  const trigger = (await env.db.query(`select t.tgname from pg_trigger t join pg_constraint c on c.oid=t.tgconstraint
    where t.tgrelid='private.sc19_payment_orders'::regclass and t.tgisinternal and c.contype='f' order by t.tgname limit 1`)).rows[0];
  assert.ok(trigger);
  await env.db.query(`alter table private.sc19_payment_orders disable trigger "${trigger.tgname.replaceAll('"', '""')}"`);
  await assertRefusal(env, /sc19_.*(?:constraint|trigger|foreign|fk)/);
  assert.equal((await env.db.query('select tgenabled from pg_trigger where tgrelid=$1::regclass and tgname=$2', ['private.sc19_payment_orders', trigger.tgname])).rows[0].tgenabled, 'D');
});

test('SC-019 migration refuses a disabled FK action trigger on auth.users', async t => {
  const env = await boot(t), { db } = env;
  const trigger = (await db.query(`select t.tgname from pg_trigger t join pg_constraint c on c.oid=t.tgconstraint
    join pg_class child on child.oid=c.conrelid join pg_namespace n on n.oid=child.relnamespace
    where t.tgrelid='auth.users'::regclass and c.confrelid=t.tgrelid and t.tgisinternal
      and c.contype='f' and n.nspname in ('public','private') order by t.tgname limit 1`)).rows[0];
  assert.ok(trigger, 'Fixture must include an FK action trigger outside public/private');
  const before = await catalogSnapshot(db);
  await db.query(`alter table auth.users disable trigger "${trigger.tgname.replaceAll('"', '""')}"`);
  assert.deepEqual(await catalogSnapshot(db), before, 'Internal FK state requires the separate enforcement guard');
  await assertRefusal(env, /sc19_foreign_key_enforcement_unreviewed/);
  assert.equal((await db.query("select tgenabled from pg_trigger where tgrelid='auth.users'::regclass and tgname=$1", [trigger.tgname])).rows[0].tgenabled, 'D');
});

test('SC-019 migration refuses unsafe browser attributes and memberships, restoring global roles', async t => {
  const env = await boot(t);
  const snapshot = async role => ({
    attributes: (await env.admin.query("select to_jsonb(r)-'rolpassword' value from pg_roles r where rolname=$1", [role])).rows[0].value,
    memberships: (await env.admin.query(`select to_jsonb(m) value from pg_auth_members m
      where m.member=$1::regrole or m.roleid=$1::regrole order by m.roleid,m.member,m.grantor`, [role])).rows,
  });
  for (const role of ['anon', 'authenticated']) {
    const before = await snapshot(role);
    assert.equal(before.attributes.rolsuper, false);
    assert.equal(before.attributes.rolbypassrls, false);
    for (const attribute of ['BYPASSRLS', 'SUPERUSER']) await t.test(`${role} ${attribute}`, async st => {
      // Role changes are cluster-global. Each subtest restores through the
      // independent maintenance connection in finally and again in its cleanup
      // guard, before the parent disposable database/connection cleanup runs.
      const restore = async () => {
        await env.admin.query(`alter role ${role} NO${attribute}`);
        assert.deepEqual(await snapshot(role), before, 'Original browser role is restored exactly');
      };
      st.after(restore);
      try {
        await env.admin.query(`alter role ${role} ${attribute}`);
        await assertRefusal(env, /sc19_unsafe_browser_role/, '42501');
      } finally { await restore(); }
    });
    for (const parent of ['postgres', 'pg_read_all_data']) await t.test(`${role} is a member of ${parent}`, async st => {
      assert.equal((await env.admin.query('select count(*)::int n from pg_auth_members where member=$1::regrole and roleid=$2::regrole', [role, parent])).rows[0].n, 0);
      let granted = false;
      const restore = async () => {
        if (granted) { await env.admin.query(`revoke ${parent} from ${role}`); granted = false; }
        assert.deepEqual(await snapshot(role), before, 'Original memberships and options are restored exactly');
      };
      st.after(restore);
      try {
        await env.admin.query(`grant ${parent} to ${role}`); granted = true;
        await assertRefusal(env, /sc19_unsafe_browser_role/, '42501');
      } finally { await restore(); }
    });
  }
  await applyMigration(env.db); await assertR6(env.db);
});

test('SC-019 migration accepts an authenticator holding the authenticated role', async t => {
  const env = await boot(t), authenticator = `sc19_authenticator_${randomUUID().replaceAll('-', '')}`;
  await t.test('membership direction remains compatible with the auth gateway', async st => {
    let created = false;
    const cleanup = async () => {
      if (created) {
        await env.admin.query(`drop role ${authenticator}`); created = false;
      }
      assert.equal((await env.admin.query('select count(*)::int n from pg_roles where rolname=$1', [authenticator])).rows[0].n, 0);
    };
    st.after(cleanup);
    try {
      await env.admin.query(`create role ${authenticator} nologin noinherit`); created = true;
      await env.admin.query(`grant authenticated to ${authenticator}`);
      await applyMigration(env.db); await assertR6(env.db);
    } finally { await cleanup(); }
  });
});

test('SC-019 migration can be retried after explicitly removing unknown source drift', async t => {
  const env = await boot(t);
  await env.db.query('create table public.unreviewed_candidate_copy(candidate_id uuid)');
  await assertRefusal(env);
  await env.db.query('drop table public.unreviewed_candidate_copy');
  await applyMigration(env.db); await assertR6(env.db);
});

for (const [state, table] of [['r4_legacy', 'erasure_inventory_baseline_r4'], ['r4_voice', 'erasure_inventory_baseline_r4_voice']]) {
  for (const field of ['signature', 'allowlist']) test(`SC-019 migration refuses corrupted ${table} ${field} data`, async t => {
    const env = await boot(t, state), { db } = env;
    await db.query(`alter table private.${table} disable trigger user`);
    await db.query(field === 'signature'
      ? `update private.${table} set schema_signature=repeat('a',64)`
      : `update private.${table} set known_tables=array['public.candidates']`);
    await db.query(`alter table private.${table} enable trigger user`);
    const before = await rows(db, `private.${table}`);
    await assertRefusal(env, /sc19_.*baseline/);
    assert.deepEqual(await rows(db, `private.${table}`), before, 'Source history is not silently repaired');
  });
}

test('SC-019 migration refuses duplicate pending #129 orders without choosing or deleting one', async t => {
  const env = await boot(t, 'orders129_legacy');
  await seedHistoricalOrders(env, { duplicatePending: true });
  await assertRefusal(env, /sc19_duplicate_unresolved_orders/);
  assert.equal((await env.db.query("select count(*)::int n from private.sc19_payment_orders where status='awaiting_payment'")).rows[0].n, 2);
});

test('SC-019 migration refuses an original request alias pointing at another order', async t => {
  const env = await boot(t, 'orders152_legacy');
  await seedHistoricalOrders(env, { conflictingAlias: true });
  await assertRefusal(env, /sc19_original_request_alias_conflict/);
});

for (const corruption of ['missing_grant', 'wrong_settlement_reference', 'wrong_purchased_credits', 'grant_for_pending']) {
  test(`SC-019 migration refuses ${corruption} without inferring settlement`, async t => {
    const env = await boot(t, 'orders129_legacy'), { db } = env;
    const fixture = await seedHistoricalOrders(env);
    if (corruption === 'missing_grant') {
      // Administrative construction of malformed historical data, with the
      // exact accepted trigger definitions and enabled state restored afterward.
      await db.query('alter table private.sc19_payment_grants disable trigger user');
      await db.query('delete from private.sc19_payment_grants');
      await db.query('alter table private.sc19_payment_grants enable trigger user');
    } else if (corruption === 'grant_for_pending') {
      await db.query('insert into private.sc19_payment_grants(payment_key,order_id) values($1,$2)', ['synthetic-invalid-pending-grant', fixture.pending.id]);
    } else {
      await db.query('alter table private.sc19_credit_journal disable trigger user');
      if (corruption === 'wrong_settlement_reference') await db.query("update private.sc19_credit_journal set reference='settlement:synthetic-unrelated'");
      else await db.query('update private.sc19_credit_journal set delta=999');
      await db.query('alter table private.sc19_credit_journal enable trigger user');
    }
    await assertRefusal(env, /sc19_payment_accounting_inconsistent/);
  });
}

test('SC-019 migration preserves completed unbilled history and refuses active unreserved history', async t => {
  for (const completed of [false, true]) await t.test(completed ? 'completed history stays unbilled' : 'active history requires reconciliation', async st => {
    const env = await boot(st), { h, db } = env, f = await h.seed(), started = await h.start(f);
    if (completed) {
      const claimed = await h.claim(started); await h.finishClaim(started, claimed, Array(claimed.criteria_snapshot.length).fill('meets'));
    }
    await h.asAdmin();
    const before = await rows(db, 'public.screening_analysis_versions');
    if (!completed) await assertRefusal(env, /sc19_preexisting_unbilled_analysis/);
    else {
      await applyMigration(db); await assertR6(db);
      assert.equal((await db.query('select count(*)::int n from private.sc19_analysis_spend')).rows[0].n, 0);
      assert.equal((await db.query('select count(*)::int n from private.sc19_credit_journal')).rows[0].n, 0);
    }
    assert.deepEqual(await rows(db, 'public.screening_analysis_versions'), before);
  });
});

const historyCases = [
  ['nonterminal execution', 'erasure_executions', `insert into private.erasure_executions(request_id,company_id,candidate_ids,scope_kind,owner_id,policy_copy,resolution_revision,generation,phase,recovery_retain_until)
    values(gen_random_uuid(),gen_random_uuid(),array[gen_random_uuid()],'candidate_record',$1,'{}',1,1,'authorized',now()+interval '60 days')`],
  ['terminal execution', 'erasure_executions', `insert into private.erasure_executions(request_id,company_id,candidate_ids,scope_kind,owner_id,policy_copy,resolution_revision,generation,phase,sequence,schema_signature,local_purged,recovery_retain_until)
    values(gen_random_uuid(),gen_random_uuid(),array[gen_random_uuid()],'candidate_record',$1,'{}',1,1,'active_data_erased',3,private.erasure_schema_signature(),true,now()+interval '60 days')`],
  ['verified signed ledger history', 'erasure_verified_ledger_events', `insert into private.erasure_verified_ledger_events(request_id,sequence,reservation_id,envelope_hash,event_hash,phase)
    values($1,1,gen_random_uuid(),repeat('a',64),repeat('b',64),'authorized')`],
  ['terminal receipt', 'erasure_receipts', `insert into private.erasure_receipts(company_id,policy_revision,phase,counts) values($1,1,'active_data_erased','{}')`],
  ['retired candidate tombstone', 'retired_candidate_ids', `insert into private.retired_candidate_ids(candidate_id,company_id,generation,recovery_event_id,retain_until) values($1,gen_random_uuid(),1,repeat('a',64),now()+interval '60 days')`],
  ['restore checkpoint', 'erasure_restore_checkpoint', `insert into private.erasure_restore_checkpoint(singleton,sequence,checkpoint_hash) values(true,1,$1)`],
];
for (const [label, table, sql] of historyCases) test(`SC-019 v1 refuses and preserves old ${label}`, async t => {
  const env = await boot(t); await env.db.query(sql, [users.owner]);
  const before = await rows(env.db, `private.${table}`);
  await assertRefusal(env, /sc19_signed_erasure_history_transition_required/);
  assert.deepEqual(await rows(env.db, `private.${table}`), before, 'No expiring, deleting or rewriting old signed history');
});

test('SC-019 v1 refuses active candidate freeze and preserves the request', async t => {
  const env = await boot(t), x = lifecycleHarness(env.h), f = await x.ready();
  await x.freeze(f); await env.h.asAdmin();
  const before = await rows(env.db, 'private.erasure_requests');
  await assertRefusal(env, /sc19_signed_erasure_history_transition_required/);
  assert.deepEqual(await rows(env.db, 'private.erasure_requests'), before);
});

test('SC-019 migration accepts unsigned preview tickets but refuses their stale authorization', async t => {
  const env = await boot(t), { db, h } = env, x = lifecycleHarness(h), f = await x.ready();
  const ticket = await x.ticket(f); await h.asAdmin();
  const before = await rows(db, 'private.erasure_preview_tickets');
  await applyMigration(db); await assertR6(db);
  assert.deepEqual(await rows(db, 'private.erasure_preview_tickets'), before);
  await h.asUser(f.owner);
  await assert.rejects(x.authorize(f, ticket), error => error.code === 'PT409');
  const fresh = await x.ticket(f);
  assert.notEqual(fresh.manifest_hash, ticket.manifest_hash);
  assert.match(await x.authorize(f, fresh), /^[0-9a-f-]{36}$/);
});

test('SC-019 migration removes hostile default grants while retaining unrelated privileges', async t => {
  const env = await boot(t), { db, h } = env;
  await db.query(`create schema isolated_acl_fixture;
    create table isolated_acl_fixture.unrelated(id integer);
    grant usage on schema isolated_acl_fixture to contact_verifier;
    grant select on isolated_acl_fixture.unrelated to contact_verifier;
    alter default privileges grant all on tables to contact_verifier with grant option;
    alter default privileges grant execute on functions to contact_verifier with grant option;
    alter default privileges in schema private grant all on tables to contact_verifier with grant option;
    alter default privileges in schema private grant execute on functions to contact_verifier with grant option`);
  await applyMigration(db); await assertR6(db);
  for (const table of [...accountingTables, 'erasure_inventory_baseline_r5', 'erasure_inventory_baseline_r6']) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      assert.equal((await db.query('select has_table_privilege($1,$2,$3) allowed', ['contact_verifier', `private.${table}`, privilege])).rows[0].allowed, false, `${table}: ${privilege}`);
    }
  }
  assert.equal((await db.query("select has_function_privilege('contact_verifier','private.sc19_grant_paid(uuid,text)','EXECUTE') allowed")).rows[0].allowed, false);
  assert.equal((await db.query("select has_table_privilege('contact_verifier','isolated_acl_fixture.unrelated','SELECT') allowed")).rows[0].allowed, true);
  await db.query('set role contact_verifier');
  await assert.rejects(db.query('truncate private.sc19_balances cascade'), denied);
  await assert.rejects(db.query("select private.sc19_grant_paid(gen_random_uuid(),'synthetic-forbidden')"), denied);
  await h.asAdmin();
});

test('SC-019 migration strips existing owned column privileges and grant options', async t => {
  const env = await boot(t, 'orders152_legacy'), { db } = env;
  await seedHistoricalOrders(env);
  await db.query(`grant select(available),update(available),insert(available) on private.sc19_balances to contact_verifier with grant option;
    grant select(amount_minor),update(amount_minor),insert(amount_minor),references(id) on private.sc19_payment_orders to authenticated with grant option`);
  const before = await accountingSnapshot(db);
  await applyMigration(db); await assertR6(db);
  for (const [role, table, column, privileges] of [
    ['contact_verifier', 'private.sc19_balances', 'available', ['SELECT', 'INSERT', 'UPDATE']],
    ['authenticated', 'private.sc19_payment_orders', 'amount_minor', ['SELECT', 'INSERT', 'UPDATE']],
    ['authenticated', 'private.sc19_payment_orders', 'id', ['REFERENCES']],
  ]) for (const privilege of privileges) {
    assert.equal((await db.query('select has_column_privilege($1,$2,$3,$4) allowed', [role, table, column, privilege])).rows[0].allowed, false);
  }
  assert.deepEqual((await db.query(`select a.attname from pg_attribute a join pg_class c on c.oid=a.attrelid where a.attrelid in
    ('private.sc19_balances'::regclass,'private.sc19_payment_orders'::regclass) and a.attacl is not null
    and exists(select 1 from aclexplode(a.attacl) x where x.grantee<>c.relowner)`)).rows, []);
  const after = await accountingSnapshot(db);
  for (const table of accountingTables.filter(value => value !== 'sc19_payment_requests')) assert.deepEqual(after[table], before[table]);
});

test('SC-019 installed credit RPCs enforce tenant, role, FREE and charge/refund invariants', async t => {
  const env = await boot(t), { db, h } = env; await applyMigration(db); await assertR6(db);
  await seedSyntheticPolicy(db);
  const first = await h.seed(), second = await h.seed(users.otherOwner);
  await h.asAdmin();
  await db.query('insert into public.company_members(company_id,user_id,role) values($1,$2,$3),($1,$4,$5)',
    [first.companyId, users.recruiter, 'recruiter', users.viewer, 'viewer']);
  for (const table of accountingTables) {
    assert.equal((await db.query('select relrowsecurity from pg_class where oid=$1::regclass', [`private.${table}`])).rows[0].relrowsecurity, true);
  }
  for (const role of ['anon', 'authenticated']) {
    await h.asUser(first.owner, role);
    for (const table of accountingTables) for (const sql of [
      `select * from private.${table}`, `insert into private.${table} default values`,
      `delete from private.${table}`, `truncate private.${table} cascade`,
    ]) await assert.rejects(db.query(sql), denied, `${role}: ${sql}`);
    await assert.rejects(db.query('update private.sc19_balances set available=999'), denied);
    await assert.rejects(db.query('select private.sc19_grant_paid($1,$2)', [first.companyId, 'synthetic-forbidden-settlement']), denied);
  }
  await h.asUser(null, 'anon');
  assert.equal((await db.query('select * from public.sc19_package_sizes()')).rows.length, 2);
  await assert.rejects(db.query('select public.sc19_get_balance($1)', [first.companyId]), denied);
  for (const actor of [users.otherOwner, users.outsider, users.recruiter, users.viewer]) {
    await h.asUser(actor);
    await assert.rejects(db.query("select public.sc19_claim_trial($1,'1234563218')", [first.companyId]), denied);
  }
  await h.asUser(first.owner);
  await assert.rejects(db.query("select public.sc19_claim_trial($1,'1234563218')", [first.companyId]), /sc19_trial_requires_verified_company/);
  await h.asAdmin();
  await db.query(`insert into private.sc19_trial_approvals(company_id,nip,proof_reference)
    values($1,'1234563218','synthetic-approved-company-A')`, [first.companyId]);
  await assert.rejects(db.query(`insert into private.sc19_trial_approvals(company_id,nip,proof_reference)
    values($1,'1234563218','synthetic-duplicate-entity-B')`, [second.companyId]), error => error.code === '23505');
  const free = (await db.query("select credits from private.sc19_package_policy where plan='FREE'")).rows[0].credits;
  await h.asUser(first.owner);
  assert.equal((await db.query("select public.sc19_claim_trial($1,'1234563218') available", [first.companyId])).rows[0].available, free);
  assert.equal((await db.query("select public.sc19_claim_trial($1,'1234563218') available", [first.companyId])).rows[0].available, free);
  // Even an explicit synthetic operator reassignment of verification cannot
  // reissue the legal entity's already-consumed FREE pack to another company.
  await h.asAdmin();
  await db.query('delete from private.sc19_trial_approvals where company_id=$1', [first.companyId]);
  await db.query(`insert into private.sc19_trial_approvals(company_id,nip,proof_reference)
    values($1,'1234563218','synthetic-reassigned-entity-B')`, [second.companyId]);
  await h.asUser(second.owner);
  await assert.rejects(db.query("select public.sc19_claim_trial($1,'1234563218')", [second.companyId]), error => error.code === '23505');
  for (const actor of [users.recruiter, users.viewer]) {
    await h.asUser(actor);
    assert.equal((await db.query('select * from public.sc19_get_balance($1)', [first.companyId])).rows[0].available, free);
    await assert.rejects(db.query('select public.sc19_get_balance($1)', [second.companyId]), denied);
  }
  await h.asUser(users.outsider);
  await assert.rejects(db.query('select public.sc19_get_balance($1)', [first.companyId]), denied);
  const started = await h.start(first), claimed = await h.claim(started);
  await h.asAdmin();
  assert.equal((await db.query('select available from private.sc19_balances where company_id=$1', [first.companyId])).rows[0].available, free - 1);
  await db.query("update public.screening_analysis_versions set stale_at=clock_timestamp(),stale_reason='manual_invalidation' where id=$1", [started.analysis_id]);
  assert.equal((await db.query('select available from private.sc19_balances where company_id=$1', [first.companyId])).rows[0].available, free);
  assert.equal((await db.query('select status from public.screening_analysis_attempts where id=$1', [started.attempt_id])).rows[0].status, 'abandoned');
  const ledger = await accountingSnapshot(db);
  await assert.rejects(h.finishClaim(started, claimed, Array(claimed.criteria_snapshot.length).fill('meets')), denied);
  assert.deepEqual(await accountingSnapshot(db), ledger, 'Rejected late completion cannot double-refund');
  assert.equal((await db.query("select count(*)::int n from private.sc19_credit_journal where reason='trial'")).rows[0].n, 1);
  assert.equal((await db.query('select private.sc19_grant_paid($1,$2) available', [second.companyId, 'synthetic-operator-settlement-B'])).rows[0].available, 60);
  await db.query('select private.sc19_grant_paid($1,$2)', [second.companyId, 'synthetic-operator-settlement-B']);
  assert.equal((await db.query('select available from private.sc19_balances where company_id=$1', [second.companyId])).rows[0].available, 60);
});

test('SC-019 authenticated platform operator cannot use SQL-only credit privileges', async t => {
  const env = await boot(t), { db, h } = env; await applyMigration(db); await assertR6(db);
  const f = await h.seed(); await h.asAdmin();
  await db.query('insert into public.platform_operators(user_id,granted_by) values($1,$2)', [users.outsider, f.owner]);
  const before = await accountingSnapshot(db);
  await h.asUser(users.outsider);
  assert.equal((await db.query('select public.platform_operator_status() allowed')).rows[0].allowed, true);
  await assert.rejects(db.query('select private.sc19_grant_paid($1,$2)', [f.companyId, 'synthetic-platform-operator-denied']), denied);
  await assert.rejects(db.query('select public.sc19_get_balance($1)', [f.companyId]), denied);
  await assert.rejects(db.query("insert into private.sc19_trial_approvals(company_id,nip,proof_reference) values($1,'1234563218','synthetic-self-approval')", [f.companyId]), denied);
  await assert.rejects(db.query('truncate private.sc19_balances cascade'), denied);
  assert.deepEqual(await accountingSnapshot(db), before);
});

test('SC-019 migrated payment store supports native concurrency, replay, immutable terms and rollback', async t => {
  const env = await boot(t), { db, h } = env; await applyMigration(db); await assertR6(db);
  await seedSyntheticPolicy(db);
  const first = await h.seed(paymentUsers.owner), second = await h.seed(paymentUsers.otherOwner), unapproved = await h.seed(paymentUsers.owner);
  await h.asAdmin();
  const p = paymentHarness(env); await p.seed(first, second);
  const attempts = Array.from({ length: 8 }, () => p.request(first.companyId));
  let hosted;
  await t.test('eight independent concurrent request IDs allocate one unresolved order/session', async () => {
    const connected = await Promise.all(Array.from({ length: 8 }, () => p.pool.connect()));
    try { assert.equal(new Set(await Promise.all(connected.map(async c => (await c.query('select pg_backend_pid() pid')).rows[0].pid))).size, 8); }
    finally { connected.forEach(c => c.release()); }
    const result = await Promise.all(attempts.map(input => p.runtime().service.checkout(input)));
    hosted = result[0]; assert.equal(new Set(result.map(value => value.orderId)).size, 1);
    assert.equal(p.sessions.size, 1); assert.equal(await p.count('sc19_payment_orders'), 1);
    assert.equal(await p.count('sc19_payment_requests'), 8);
  });
  await t.test('company-wide slot and composite alias FK enforce the invariant directly', async () => {
    await assert.rejects(p.pool.query(`insert into private.sc19_payment_orders
      (id,company_id,buyer_id,request_id,offer_id,offer_revision,terms_revision,amount_minor,currency,credits,provider,account,mode,status,checkout_deadline_ms)
      select $1,company_id,$2,$3,offer_id,offer_revision,terms_revision,amount_minor,currency,credits,'other-provider','other-account',mode,status,checkout_deadline_ms
      from private.sc19_payment_orders where id=$4`, [randomUUID(), paymentUsers.recruiter, randomUUID(), hosted.orderId]),
    error => error.code === '23505' && error.constraint === 'sc19_payment_one_unresolved');
    await assert.rejects(p.pool.query('insert into private.sc19_payment_requests(company_id,request_id,order_id) values($1,$2,$3)',
      [second.companyId, randomUUID(), hosted.orderId]), error => error.code === '23503');
    await assert.rejects(p.pool.query('update private.sc19_payment_requests set request_id=$1', [randomUUID()]), /immutable/);
    await assert.rejects(p.pool.query('delete from private.sc19_payment_requests'), /immutable/);
  });
  await t.test('eight simultaneous webhooks and later aliases grant exactly once', async () => {
    const payment = p.payment(hosted);
    const results = await Promise.all(Array.from({ length: 8 }, () => p.notify({ ...payment, eventId: randomUUID() }, p.runtime().service)));
    assert.equal(results.filter(value => value.state === 'applied').length, 1);
    assert.equal(await p.balance(first.companyId), 12);
    assert.equal(await p.count('sc19_payment_grants'), 1); assert.equal(await p.count('sc19_credit_journal'), 1);
    assert.equal((await p.notify(payment)).state, 'already_applied');
    for (const input of attempts) assert.deepEqual(await p.runtime().service.checkout(input), { orderId: hosted.orderId, paid: true });
    assert.equal(await p.count('sc19_payment_orders'), 1);
  });
  await t.test('tenant/owner/KYB authorization and provider signature failures preserve balances', async () => {
    for (const actor of [null, paymentUsers.otherOwner, paymentUsers.outsider, paymentUsers.recruiter, paymentUsers.viewer]) {
      await assert.rejects(p.runtime(actor).service.checkout(p.request(first.companyId)), /FORBIDDEN/);
    }
    await assert.rejects(p.runtime().service.checkout(p.request(unapproved.companyId)), /FORBIDDEN/);
    await assert.rejects(p.runtime(paymentUsers.otherOwner).readOrder(first.companyId, paymentUsers.otherOwner, hosted.orderId), /FORBIDDEN/);
    assert.equal(await p.runtime(paymentUsers.otherOwner).readOrder(second.companyId, paymentUsers.otherOwner, hosted.orderId), null);
    await assert.rejects(p.notify(p.payment(hosted), p.runtime().service, 'synthetic-invalid'), /signature/);
    await assert.rejects(p.notify(p.payment(hosted, { amountMinor: 1 })), /MISMATCH/);
    assert.equal(await p.balance(first.companyId), 12); assert.equal(await p.balance(second.companyId), 0);
  });
  await t.test('current policy changes cannot alter immutable purchased economics', async () => {
    for (const sql of ["update private.sc19_payment_offers set credits=99", "update private.sc19_payment_orders set amount_minor=1",
      "update private.sc19_payment_grants set payment_key='changed'", 'delete from private.sc19_payment_grants']) {
      await assert.rejects(p.pool.query(sql), /immutable/);
    }
    const next = await p.runtime().service.checkout(p.request(first.companyId)); assert.notEqual(next.orderId, hosted.orderId);
    await p.pool.query("update private.sc19_package_policy set credits=99 where plan='PRESELEKCJA'");
    await p.notify(p.payment(next)); assert.equal(await p.balance(first.companyId), 24);
    assert.equal((await p.runtime().readOrder(first.companyId, first.owner, next.orderId)).credits, 12);
  });
  await t.test('failure after credit increment rolls back order, grant, journal and balance', async () => {
    const next = await p.runtime().service.checkout(p.request(first.companyId)), before = await accountingSnapshot(db);
    await p.pool.query(`create function private.fixture_sc19_fail_paid() returns trigger language plpgsql as $$begin
      if new.status='paid' then raise exception 'synthetic fulfillment rollback';end if;return new;end$$;
      create trigger fixture_sc19_fail_paid before update on private.sc19_payment_orders for each row execute function private.fixture_sc19_fail_paid()`);
    try {
      await assert.rejects(p.notify(p.payment(next)), /synthetic fulfillment rollback/);
      assert.deepEqual(await accountingSnapshot(db), before);
    } finally { await p.pool.query('drop trigger fixture_sc19_fail_paid on private.sc19_payment_orders; drop function private.fixture_sc19_fail_paid()'); }
    await p.notify(p.payment(next)); assert.equal(await p.balance(first.companyId), 36);
  });
  await t.test('lost response with a new request reuses the session and settlement drains with checkout disabled', async () => {
    const input = p.request(first.companyId); p.setLostResponse(true);
    await assert.rejects(p.runtime().service.checkout(input), /synthetic lost response/); p.setLostResponse(false);
    const order = (await p.pool.query('select id from private.sc19_payment_orders where request_id=$1', [input.requestId])).rows[0];
    const count = p.sessions.size, recovered = await p.runtime().service.checkout(p.request(first.companyId));
    assert.equal(recovered.orderId, order.id); assert.equal(p.sessions.size, count);
    await p.notify(p.payment(recovered), p.runtime(paymentUsers.owner, { enabled: false }).service);
    assert.equal(await p.balance(first.companyId), 48);
  });
  await assertR6(db);
});
