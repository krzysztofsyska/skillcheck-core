import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createRankingHarness, users } from './screening-ranking-fixture.mjs';
import { composeSc19PaymentRuntime } from '../../lib/sc19-payment-runtime.ts';

export const migrationFile = '20261021084732_sc019_credits_payments_inventory.sql';
export const sourceStates = Object.freeze([
  'r4_legacy', 'r4_voice', 'r5_legacy', 'r5_voice', 'orders129_legacy', 'orders152_legacy',
]);
// Historical SQL fixtures intentionally use UUID-shaped values without an RFC
// version/variant. Payment HTTP/domain validation requires real UUIDs, so keep
// separate valid synthetic principals rather than weakening that validation.
export const paymentUsers = Object.freeze(Object.fromEntries(Object.keys(users).map((name, i) =>
  [name, `20000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`])));
export const accountingTables = Object.freeze([
  'sc19_package_policy', 'sc19_balances', 'sc19_trial_nips', 'sc19_trial_approvals',
  'sc19_analysis_spend', 'sc19_credit_journal', 'sc19_payment_offers',
  'sc19_payment_orders', 'sc19_payment_requests', 'sc19_payment_grants',
]);
const repository = fileURLToPath(new URL('../../', import.meta.url));
const bootstrap = `do $$ begin
 if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
 if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
 end $$;
 create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;$$;
 grant usage on schema auth to anon,authenticated;
 grant execute on function auth.uid() to anon,authenticated;`;
const sourceCache = new Map();
let manifest;
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const blockersOf = value => Array.isArray(value?.blockers) ? value.blockers : JSON.parse(value.blockers);

export async function migrationManifest() {
  manifest ??= JSON.parse(await readFile(new URL('../fixtures/sc19-migration-manifest.json', import.meta.url), 'utf8'));
  return manifest;
}

export function pinnedSource(source) {
  assert.match(source.ref, /^[0-9a-f]{40}$/);
  assert.match(source.path, /^(supabase\/migrations|docs\/prototypes|db\/(?:isolated|prototypes))\/[\w.-]+\.sql$/);
  const key = `${source.ref}:${source.path}`;
  if (!sourceCache.has(key)) sourceCache.set(key, execFileSync('git', ['show', key], {
    cwd: repository, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }));
  const sql = sourceCache.get(key);
  assert.equal(sha256(sql), source.sha256, `Pinned source changed: ${key}`);
  return sql;
}

export function maintenanceUrl() {
  assert.ok(process.env.SC19_TEST_DATABASE_URL, 'SC19_TEST_DATABASE_URL required; no skipped or embedded migration substitute');
  const url = new URL(process.env.SC19_TEST_DATABASE_URL);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.pathname === '/postgres',
    'Migration tests require disposable loopback /postgres; remote databases are refused');
  assert.ok(['16', '17'].includes(process.env.SC19_TEST_PG_MAJOR), 'SC19_TEST_PG_MAJOR must explicitly select 16 or 17');
  return url;
}

export async function bootMigrationDatabase(t) {
  const rootUrl = maintenanceUrl();
  const admin = new pg.Client({ connectionString: rootUrl.href, connectionTimeoutMillis: 5000 });
  await admin.connect();
  const databases = new Set(), clients = new Set(), pools = new Set();
  t.after(async () => {
    await Promise.all([...pools].map(pool => pool.end()));
    await Promise.all([...clients].map(client => client.end().catch(() => {})));
    try {
      for (const name of databases) await admin.query(`drop database if exists "${name}" with (force)`);
    } finally { await admin.end(); }
  });
  const databaseUrl = name => { const url = new URL(rootUrl); url.pathname = `/${name}`; return url.href; };
  const createDatabase = async () => {
    const name = `sc19_migration_${randomBytes(8).toString('hex')}`;
    await admin.query(`create database "${name}"`); databases.add(name); return name;
  };
  const name = await createDatabase();
  const connect = async (database = name) => {
    assert.ok(databases.has(database), 'Connection must name an owned disposable database');
    const client = new pg.Client({ connectionString: databaseUrl(database), connectionTimeoutMillis: 5000 });
    clients.add(client); await client.connect(); client.exec = sql => client.query(sql);
    await client.query("set search_path='public'; set timezone='UTC'; set datestyle='ISO, YMD'; set statement_timeout='90s'; set lock_timeout='5s'");
    assert.equal((await client.query('select current_database() name')).rows[0].name, database);
    return client;
  };
  const pool = (database = name) => {
    assert.ok(databases.has(database));
    const value = new pg.Pool({ connectionString: databaseUrl(database), max: 12, connectionTimeoutMillis: 5000 });
    pools.add(value); return value;
  };
  const db = await connect();
  const version = (await db.query("select version() version, current_setting('server_version_num')::integer number")).rows[0];
  assert.equal(Math.floor(version.number / 10000), Number(process.env.SC19_TEST_PG_MAJOR));
  t.diagnostic(version.version);
  const second = await connect();
  assert.notEqual((await db.query('select pg_backend_pid() pid')).rows[0].pid,
    (await second.query('select pg_backend_pid() pid')).rows[0].pid);
  return { db, h: createRankingHarness(db), admin, name, databaseUrl, connect, pool, createDatabase, version };
}

export async function catalogSnapshot(db) {
  await db.query("reset role; set search_path=''");
  const contract = await migrationManifest();
  const result = { sc010_signature: (await db.query('select private.erasure_schema_signature() value')).rows[0].value };
  for (const [name, sql] of Object.entries(contract.queries)) result[name] = (await db.query(sql)).rows[0].digest;
  return result;
}

export async function installSource(env, state) {
  const contract = await migrationManifest(), entry = contract.states[state];
  assert.ok(sourceStates.includes(state) && entry, `Unknown fixture source ${state}`);
  assert.equal(sha256(bootstrap), contract.bootstrap_sha256, 'Canonical auth fixture must match manifest');
  await env.db.query(bootstrap);
  for (const source of entry.sources) await env.db.query(pinnedSource(source));
  for (const id of [...Object.values(users), ...Object.values(paymentUsers)]) await env.db.query('insert into auth.users values($1)', [id]);
  const observed = await catalogSnapshot(env.db);
  const expected = { ...entry.pg16, ...(process.env.SC19_TEST_PG_MAJOR === '17' ? entry.pg17 : {}) };
  for (const [name, actual] of Object.entries(observed)) assert.equal(actual, expected[name], `${state}: ${name}`);
  env.state = state;
  return env;
}

export async function applyMigration(db) {
  const sql = await readFile(new URL(`../../supabase/migrations/${migrationFile}`, import.meta.url), 'utf8');
  assert.ok(sql.length > 1000 && /erasure_inventory_baseline_r6/.test(sql), 'Actual forward migration must be implemented');
  try { await db.query(sql); }
  catch (error) { await db.query('rollback'); throw error; }
}

export async function assertR6(db, variant = 'legacy') {
  await db.query('reset role');
  const contract = await migrationManifest();
  const expected = contract.outputs[variant];
  assert.ok(expected?.sc010_signature && expected?.known_tables, `Missing reviewed ${variant} output manifest`);
  const actual = (await db.query(`select schema_signature,known_tables,
    private.erasure_schema_signature() actual from private.erasure_inventory_baseline_r6 where singleton`)).rows;
  assert.equal(actual.length, 1);
  assert.equal(actual[0].schema_signature, expected.sc010_signature);
  assert.equal(actual[0].actual, expected.sc010_signature);
  const expectedCatalog = { ...expected.pg16, ...(process.env.SC19_TEST_PG_MAJOR === '17' ? expected.pg17 : {}) };
  for (const [name, value] of Object.entries(await catalogSnapshot(db))) {
    assert.equal(value, expectedCatalog[name], `Final ${variant} catalog: ${name}`);
  }
  assert.deepEqual([...actual[0].known_tables].sort(), [...expected.known_tables].sort());
  const tables = (await db.query(`select n.nspname||'.'||c.relname name from pg_class c
    join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private')
    and c.relkind in ('r','p','f') order by (n.nspname||'.'||c.relname) collate "C"`)).rows.map(row => row.name);
  assert.deepEqual(tables, [...expected.known_tables].sort(), 'Inventory is the complete relation allowlist');
  assert.deepEqual((await db.query(`select proname from pg_proc where prosrc ~ 'erasure_inventory_baseline_r[45]'
    and pronamespace in ('public'::regnamespace,'private'::regnamespace)`)).rows, []);
  for (const name of ['preview_candidate_erasure', 'prepare_erasure_purge_manifest', 'authorize_retention_suggestion', 'get_retention_schedule']) {
    assert.equal((await db.query("select count(*)::int n from pg_proc where proname=$1 and prosrc like '%erasure_inventory_baseline_r6%'", [name])).rows[0].n, 1, name);
  }
  const unresolved = (await db.query(`select indisunique,indisvalid,indisready,pg_get_expr(indpred,indrelid) predicate
    from pg_index where indexrelid='private.sc19_payment_one_unresolved'::regclass`)).rows[0];
  assert.ok(unresolved.indisunique && unresolved.indisvalid && unresolved.indisready);
  assert.match(unresolved.predicate, /status = 'awaiting_payment'/);
  assert.deepEqual((await db.query(`select o.id from private.sc19_payment_orders o
    left join private.sc19_payment_requests r on r.company_id=o.company_id and r.request_id=o.request_id
    where r.order_id is distinct from o.id`)).rows, []);
}

export async function accountingSnapshot(db) {
  await db.query('reset role');
  const result = {};
  for (const table of accountingTables) {
    const exists = (await db.query('select to_regclass($1) value', [`private.${table}`])).rows[0].value;
    if (exists) result[table] = (await db.query(`select to_jsonb(t) row from private.${table} t order by to_jsonb(t)::text collate "C"`)).rows.map(row => row.row);
  }
  return result;
}

// Explicit test-only commercial inputs. The real fresh migration must leave
// policy empty; these examples are inserted only after that assertion passes.
export async function seedSyntheticPolicy(db) {
  await db.query('reset role');
  assert.equal((await db.query('select count(*)::int n from private.sc19_package_policy')).rows[0].n, 0);
  await db.query("insert into private.sc19_package_policy(plan,credits) values('FREE',5),('PRESELEKCJA',60)");
}

export async function seedCreditData(env) {
  const { db, h } = env;
  const first = await h.seed(), second = await h.seed(users.otherOwner);
  await h.asAdmin();
  await db.query("update private.sc19_package_policy set credits=7 where plan='FREE'");
  await db.query("update private.sc19_package_policy set credits=23 where plan='PRESELEKCJA'");
  await db.query(`insert into private.sc19_trial_approvals(company_id,nip,proof_reference)
    values($1,'1234563218','synthetic-migration-proof-A'),($2,'1111111111','synthetic-migration-proof-B')`, [first.companyId, second.companyId]);
  await h.asUser(first.owner);
  assert.equal((await db.query("select public.sc19_claim_trial($1,'1234563218') credits", [first.companyId])).rows[0].credits, 7);
  await h.asAdmin();
  await db.query('select private.sc19_grant_paid($1,$2)', [second.companyId, 'synthetic-migration-settlement-B']);
  const started = await h.start(first), claimed = await h.claim(started);
  await h.finishClaim(started, claimed, Array(claimed.criteria_snapshot.length).fill('meets'));
  await h.asAdmin();
  return { first, second, started };
}

export async function seedHistoricalOrders(env, { duplicatePending = false, conflictingAlias = false } = {}) {
  const { db, h } = env;
  const first = await h.seed(), second = await h.seed(users.otherOwner);
  await h.asAdmin();
  await db.query(`insert into private.sc19_payment_offers(id,revision,plan,active,approved,amount_minor,currency,credits,terms_revision,terms_text,valid_until_ms)
    values('synthetic-upgrade-offer','upgrade-v1','PRESELEKCJA',true,true,12345,'PLN',12,'synthetic-terms-v1','SYNTHETIC MIGRATION TEST TERMS',$1)`, [Date.now() + 3600000]);
  const orders = [];
  const createOrder = async (tenant, paid) => {
    const id = randomUUID(), requestId = randomUUID(), paymentId = paid ? `synthetic-paid-${id}` : null;
    await db.query(`insert into private.sc19_payment_orders(id,company_id,buyer_id,request_id,offer_id,offer_revision,terms_revision,
      amount_minor,currency,credits,provider,account,mode,status,session_id,checkout_url,payment_id,checkout_deadline_ms)
      values($1,$2,$3,$4,'synthetic-upgrade-offer','upgrade-v1','synthetic-terms-v1',12345,'PLN',12,
        'synthetic','migration-fixture','test',$5,$6,$7,$8,$9)`,
    [id, tenant.companyId, tenant.owner, requestId, paid ? 'paid' : 'awaiting_payment', paid ? `session-${id}` : null,
      paid ? `https://pay.fixture.invalid/${id}` : null, paymentId, Date.now() + 3600000]);
    const order = { id, requestId, tenant, paymentId }; orders.push(order);
    if (paid) {
      const paymentKey = JSON.stringify(['synthetic', 'migration-fixture', 'test', paymentId]);
      await db.query('insert into private.sc19_payment_grants(payment_key,order_id) values($1,$2)', [paymentKey, id]);
      await db.query("insert into private.sc19_balances(company_id,plan,available) values($1,'PRESELEKCJA',12)", [tenant.companyId]);
      await db.query("insert into private.sc19_credit_journal(company_id,reason,delta,reference) values($1,'paid_grant',12,$2)",
        [tenant.companyId, `settlement:sc19:${sha256(paymentKey)}`]);
    }
    return order;
  };
  const paid = await createOrder(first, true), pending = await createOrder(second, false);
  if (duplicatePending) await createOrder(second, false);
  const hasAliases = (await db.query("select to_regclass('private.sc19_payment_requests') value")).rows[0].value;
  if (hasAliases) {
    await db.query('insert into private.sc19_payment_requests(company_id,request_id,order_id) values($1,$2,$3)', [paid.tenant.companyId, paid.requestId, paid.id]);
    await db.query('insert into private.sc19_payment_requests(company_id,request_id,order_id) values($1,$2,$3)', [paid.tenant.companyId, randomUUID(), paid.id]);
    // Missing pending original alias is the explicitly supported backfill case.
    if (conflictingAlias) {
      const other = await createOrder(first, false);
      await db.query('insert into private.sc19_payment_requests(company_id,request_id,order_id) values($1,$2,$3)', [first.companyId, other.requestId, paid.id]);
    }
  }
  return { first, second, orders, paid, pending };
}

export function paymentHarness(env) {
  const pool = env.pool(), sessions = new Map();
  const scope = { provider: 'synthetic', account: 'migration-fixture', mode: 'test' };
  let lostResponse = false;
  const provider = {
    async createCheckout(order, key) {
      if (!sessions.has(key)) sessions.set(key, { orderId: order.id, sessionId: `session-${order.id}`, url: `https://pay.fixture.invalid/${order.id}`,
        scope, amountMinor: order.amountMinor, currency: 'PLN', paymentKind: 'one_time' });
      if (lostResponse) throw Error('synthetic lost response');
      return sessions.get(key);
    },
    async lookupCheckout(_order, key) { return sessions.get(key) ?? null; },
    async verifyAndRetrieve(bytes, signature) {
      if (signature !== 'synthetic-signed') throw Error('synthetic invalid signature');
      return JSON.parse(new TextDecoder().decode(bytes));
    },
  };
  const runtime = (userId = paymentUsers.owner, overrides = {}) => composeSc19PaymentRuntime({
    pool, provider, scope, authenticate: async () => userId ? { userId } : null, enabled: true, liveApproved: false,
    checkoutOrigins: ['https://pay.fixture.invalid'], appOrigin: 'https://app.fixture.invalid', signatureHeader: 'synthetic-signature', ...overrides,
  });
  const request = (companyId, requestId = randomUUID()) => ({ companyId, requestId, offerId: 'synthetic-runtime-offer', termsRevision: 'synthetic-terms-v1' });
  const payment = (hosted, overrides = {}) => ({ eventId: randomUUID(), orderId: hosted.orderId, sessionId: hosted.sessionId,
    paymentId: `payment-${hosted.orderId}`, scope, amountMinor: 12345, currency: 'PLN', status: 'paid', ...overrides });
  const notify = (payload, service = runtime().service, signature = 'synthetic-signed') => service.notification(new TextEncoder().encode(JSON.stringify(payload)), signature);
  const balance = async companyId => Number((await pool.query('select available from private.sc19_balances where company_id=$1', [companyId])).rows[0]?.available ?? 0);
  const count = async table => {
    assert.ok(accountingTables.includes(table)); return Number((await pool.query(`select count(*) n from private.${table}`)).rows[0].n);
  };
  const seed = async (first, second) => {
    await pool.query(`insert into private.sc19_trial_approvals(company_id,nip,proof_reference)
      values($1,'1234563218','synthetic-runtime-proof-A'),($2,'1111111111','synthetic-runtime-proof-B')`, [first.companyId, second.companyId]);
    await pool.query(`insert into private.sc19_payment_offers(id,revision,plan,active,approved,amount_minor,currency,credits,terms_revision,terms_text,valid_until_ms)
      values('synthetic-runtime-offer','synthetic-v1','PRESELEKCJA',true,true,12345,'PLN',12,'synthetic-terms-v1','SYNTHETIC TEST TERMS',$1)`, [Date.now() + 3600000]);
  };
  return { pool, scope, sessions, provider, runtime, request, payment, notify, balance, count, seed, setLostResponse: value => { lostResponse = value; } };
}
