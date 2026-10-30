import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertCurrentInventory, bootMigrationDatabase } from './helpers/sc19-migration-fixture.mjs';
import { setupRankingDatabase, users } from './helpers/screening-ranking-fixture.mjs';

// Operator fulfillment RPCs on the complete checked-in chain, real PostgreSQL.
const migration = '20261029100000_sc019_operator_fulfillment.sql';
const operator = users.outsider;

// Checksum-valid synthetic NIP for a nine-digit prefix whose checksum is not 10.
function nip(prefix) {
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const sum = [...prefix].reduce((acc, digit, i) => acc + Number(digit) * weights[i], 0) % 11;
  assert.notEqual(sum, 10, `${prefix} has no valid NIP checksum`);
  return `${prefix}${sum}`;
}
const nipA = nip('526025099'), nipB = nip('951000001');

const code = expected => error => error.code === expected;

async function ready(t) {
  const env = await bootMigrationDatabase(t);
  const h = await setupRankingDatabase(env.db, { throughMigration: null });
  const { db } = env;
  await h.asAdmin();
  await db.query('insert into public.platform_operators(user_id) values($1)', [operator]);
  const a = await h.seed(users.owner), b = await h.seed(users.otherOwner);
  await h.asAdmin();
  return { db, h, a, b };
}

const call = (db, sql, params) => db.query(sql, params).then(r => r.rows);

test('operator RPCs refuse anon, ordinary users and revoked operators', async t => {
  const { db, h, a } = await ready(t);
  const attempts = [
    ['select * from public.sc19_operator_companies(null)', []],
    ['select * from public.sc19_operator_package_policy()', []],
    ["select public.sc19_operator_set_package_policy('FREE',5)", []],
    ['select public.sc19_operator_approve_trial($1,$2,$3)', [a.companyId, nipA, 'KRS 0000000000 verified']],
    ['select public.sc19_operator_grant_paid($1,$2)', [a.companyId, 'invoice FV/1/2026']],
  ];
  for (const who of [users.owner, users.recruiter]) {
    await h.asUser(who);
    for (const [sql, params] of attempts) await assert.rejects(db.query(sql, params), code('42501'), sql);
  }
  await h.asUser(null, 'anon');
  for (const [sql, params] of attempts) await assert.rejects(db.query(sql, params), code('42501'), sql);
  await h.asAdmin();
  await db.query('update public.platform_operators set revoked_at=now() where user_id=$1', [operator]);
  await h.asUser(operator);
  for (const [sql, params] of attempts) await assert.rejects(db.query(sql, params), code('42501'), sql);
  await h.asAdmin();
  for (const table of ['sc19_package_policy', 'sc19_trial_approvals', 'sc19_balances', 'sc19_credit_journal']) {
    assert.equal((await db.query(`select count(*)::int n from private.${table}`)).rows[0].n, 0, table);
  }
});

test('operator sets policy, approves the trial; owner claims FREE once and spends it', async t => {
  const { db, h, a, b } = await ready(t);
  await h.asUser(a.owner);
  await assert.rejects(db.query('select public.sc19_claim_trial($1,$2)', [a.companyId, nipA]), code('42501'),
    'FREE stays blocked before operator approval');

  await h.asUser(operator);
  assert.deepEqual(await call(db, 'select * from public.sc19_operator_package_policy()'), []);
  for (const [plan, credits] of [['FREE', 0], ['GOLD', 5], ['FREE', 100001], [null, 5]]) {
    await assert.rejects(db.query('select public.sc19_operator_set_package_policy($1,$2)', [plan, credits]), code('22023'));
  }
  await db.query("select public.sc19_operator_set_package_policy('FREE',3)");
  await db.query("select public.sc19_operator_set_package_policy('FREE',5)");
  await db.query("select public.sc19_operator_set_package_policy('PRESELEKCJA',60)");
  assert.deepEqual((await call(db, 'select plan,credits from public.sc19_operator_package_policy()')),
    [{ plan: 'FREE', credits: 5 }, { plan: 'PRESELEKCJA', credits: 60 }]);

  for (const [company, value, proof] of [
    [a.companyId, '1234567890', 'KRS extract checked'], // bad checksum
    [a.companyId, nipA, 'short'],
    [a.companyId, nipA, 'x'.repeat(101)],
    [null, nipA, 'KRS extract checked'],
  ]) {
    await assert.rejects(db.query('select public.sc19_operator_approve_trial($1,$2,$3)', [company, value, proof]), code('22023'));
  }
  const approvedAt = (await call(db, 'select public.sc19_operator_approve_trial($1,$2,$3) v',
    [a.companyId, nipA.replace(/^(\d{3})/, '$1-'), 'KRS extract checked'])).at(0).v;
  assert.ok(approvedAt);
  assert.equal((await call(db, 'select public.sc19_operator_approve_trial($1,$2,$3) v', [a.companyId, nipA, 'second ticket ref'])).at(0).v.getTime(),
    approvedAt.getTime(), 'Same company and NIP is idempotent');
  await assert.rejects(db.query('select public.sc19_operator_approve_trial($1,$2,$3)', [a.companyId, nipB, 'KRS extract checked']), code('23505'));
  await assert.rejects(db.query('select public.sc19_operator_approve_trial($1,$2,$3)', [b.companyId, nipA, 'KRS extract checked']), code('23505'),
    'One NIP cannot approve two companies');

  await h.asAdmin();
  const stored = (await call(db, 'select nip,proof_reference from private.sc19_trial_approvals where company_id=$1', [a.companyId]))[0];
  assert.equal(stored.nip, nipA);
  assert.equal(stored.proof_reference, `KRS extract checked [operator:${operator}]`);

  await h.asUser(b.owner);
  await assert.rejects(db.query('select public.sc19_claim_trial($1,$2)', [b.companyId, nipA]), code('42501'),
    'Another owner cannot use the approved NIP');
  await h.asUser(a.owner);
  assert.equal((await call(db, 'select public.sc19_claim_trial($1,$2) v', [a.companyId, nipA]))[0].v, 5);
  assert.equal((await call(db, 'select public.sc19_claim_trial($1,$2) v', [a.companyId, nipA]))[0].v, 5, 'No second FREE grant');
  await h.start(a);
  assert.equal((await call(db, 'select available from public.sc19_get_balance($1)', [a.companyId]))[0].available, 4);

  await h.asUser(operator);
  const rows = await call(db, 'select * from public.sc19_operator_companies(null)');
  assert.equal(rows.length, 2);
  const rowA = rows.find(r => r.company_id === a.companyId), rowB = rows.find(r => r.company_id === b.companyId);
  assert.deepEqual([rowA.plan, rowA.available, rowA.free_claimed, rowA.approved_nip], ['FREE', 4, true, nipA]);
  assert.deepEqual([rowB.plan, rowB.available, rowB.free_claimed, rowB.approved_nip], [null, null, false, null]);
  assert.deepEqual((await call(db, 'select company_id from public.sc19_operator_companies($1)', [a.companyId])).map(r => r.company_id), [a.companyId]);
  assert.equal((await call(db, 'select company_id from public.sc19_operator_companies($1)', ['no such tenant'])).length, 0);
  await assert.rejects(db.query('select * from public.sc19_operator_companies($1)', ['x'.repeat(201)]), code('22023'));
});

test('operator grants PRESELEKCJA once per settlement reference', async t => {
  const { db, h, a, b } = await ready(t);
  await h.asUser(operator);
  await assert.rejects(db.query('select public.sc19_operator_grant_paid($1,$2)', [a.companyId, 'FV/1/2026/P24']), code('55000'),
    'No grant without an approved PRESELEKCJA policy');
  await db.query("select public.sc19_operator_set_package_policy('PRESELEKCJA',60)");
  await assert.rejects(db.query('select public.sc19_operator_grant_paid($1,$2)', [a.companyId, 'short']), code('22023'));
  await assert.rejects(db.query('select public.sc19_operator_grant_paid($1,$2)', ['00000000-0000-4000-8000-000000000999', 'FV/1/2026/P24']), code('22023'));
  assert.equal((await call(db, 'select public.sc19_operator_grant_paid($1,$2) v', [a.companyId, 'FV/1/2026/P24']))[0].v, 60);
  assert.equal((await call(db, 'select public.sc19_operator_grant_paid($1,$2) v', [a.companyId, ' FV/1/2026/P24 ']))[0].v, 60, 'Replay grants nothing');
  await assert.rejects(db.query('select public.sc19_operator_grant_paid($1,$2)', [b.companyId, 'FV/1/2026/P24']), code('23505'),
    'A settlement belongs to one company');
  assert.equal((await call(db, 'select public.sc19_operator_grant_paid($1,$2) v', [a.companyId, 'FV/2/2026/P24']))[0].v, 120);

  await h.asUser(a.owner);
  assert.deepEqual((await call(db, 'select plan,available from public.sc19_get_balance($1)', [a.companyId]))[0], { plan: 'PRESELEKCJA', available: 120 });
  await h.asUser(b.owner);
  assert.deepEqual(await call(db, 'select * from public.sc19_get_balance($1)', [b.companyId]), []);
  await h.asAdmin();
  assert.deepEqual((await call(db, "select reference,delta from private.sc19_credit_journal where reason='paid_grant' order by reference")),
    [{ reference: 'settlement:FV/1/2026/P24', delta: 60 }, { reference: 'settlement:FV/2/2026/P24', delta: 60 }]);
});

test('migration adds functions only: inventory unchanged, no seeded policy, private grant stays private', async t => {
  const { db } = await ready(t);
  await assertCurrentInventory(db);
  const sql = await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8');
  assert.doesNotMatch(sql, /\b(create|alter|drop)\s+(table|trigger|policy|role)\b/i);
  assert.doesNotMatch(sql, /insert\s+into\s+private\.sc19_package_policy\s*\(plan,credits\)\s*values\s*\('/i);
  for (const fn of ['public.sc19_operator_companies(text)', 'public.sc19_operator_package_policy()',
    'public.sc19_operator_set_package_policy(text,integer)', 'public.sc19_operator_approve_trial(uuid,text,text)',
    'public.sc19_operator_grant_paid(uuid,text)']) {
    assert.equal((await call(db, "select has_function_privilege('anon',$1,'execute') v", [fn]))[0].v, false, fn);
    assert.equal((await call(db, "select has_function_privilege('authenticated',$1,'execute') v", [fn]))[0].v, true, fn);
  }
  for (const fn of ['private.sc19_grant_paid(uuid,text)', 'private.sc19_require_operator()']) {
    assert.equal((await call(db, "select has_function_privilege('authenticated',$1,'execute') v", [fn]))[0].v, false, fn);
  }
});

test('rollback drops only the operator functions and keeps recorded approvals and grants', async t => {
  const { db, h, a } = await ready(t);
  await h.asUser(operator);
  await db.query("select public.sc19_operator_set_package_policy('PRESELEKCJA',60)");
  await db.query('select public.sc19_operator_approve_trial($1,$2,$3)', [a.companyId, nipA, 'KRS extract checked']);
  await db.query('select public.sc19_operator_grant_paid($1,$2)', [a.companyId, 'FV/9/2026/P24']);
  await h.asAdmin();
  const down = await readFile(new URL('../supabase/rollbacks/20261029100000_sc019_operator_fulfillment_down.sql', import.meta.url), 'utf8');
  await db.query(down);
  assert.equal((await call(db, "select count(*)::int n from pg_proc where proname like 'sc19_operator%' or proname='sc19_require_operator'"))[0].n, 0);
  for (const table of ['sc19_package_policy', 'sc19_trial_approvals', 'sc19_balances']) {
    assert.equal((await call(db, `select count(*)::int n from private.${table}`))[0].n, 1, table);
  }
  await assertCurrentInventory(db);
  await db.query(await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8'));
  await h.asUser(operator);
  assert.equal((await call(db, 'select count(*)::int n from public.sc19_operator_companies(null)'))[0].n, 2, 'Re-apply after rollback works');
});
