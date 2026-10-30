import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRankingHarness, users } from './helpers/screening-ranking-fixture.mjs';
import { bootHostedRehearsal, replayObservedHistory } from './helpers/sc19-hosted-rehearsal.mjs';
import { assertCurrentInventory, assertR6, accountingSnapshot, catalogSnapshot, migrationManifest } from './helpers/sc19-migration-fixture.mjs';

test('observed production history + pending chain preserves completed synthetic screening and installs empty R6 billing', async t => {
  const url = new URL(process.env.SC19_REHEARSAL_DATABASE_URL);
  assert.equal(url.port, '55432');
  assert.equal(url.pathname, '/sc19_production_rehearsal');
  assert.ok(['16','17'].includes(process.env.SC19_TEST_PG_MAJOR));
  const { platform, db } = await bootHostedRehearsal(t, url);
  const history = await replayObservedHistory(t, db);
  assert.equal((await db.query("select count(*)::int n from pg_extension where extname='pg_cron'")).rows[0].n,1);
  assert.equal((await platform.query('select count(*)::int n from cron.job')).rows[0].n,0,'No scheduled destructive job');
  const membership=(await db.query(`select grantor::regrole::text grantor,admin_option,inherit_option,set_option from pg_auth_members where roleid='screening_worker'::regrole and member='postgres'::regrole order by grantor::regrole::text`)).rows;
  assert.deepEqual(membership,[
    {grantor:'postgres',admin_option:false,inherit_option:false,set_option:true},
    {grantor:'supabase_admin',admin_option:true,inherit_option:false,set_option:false}
  ]);
  t.diagnostic(JSON.stringify({observedHostedWorkerMembership:membership}));
  for(const id of Object.values(users)) await db.query('insert into auth.users values($1)',[id]);
  const h=createRankingHarness(db), f=await h.seed();
  const started=await h.start(f), claimed=await h.claim(started);
  await h.finishClaim(started,claimed,Array(claimed.criteria_snapshot.length).fill('meets'));
  await h.review(f,started.analysis_id); await h.add(f,'suggested',undefined,null,5);
  await h.asAdmin();
  const tables=(await db.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows.map(r=>r.tablename);
  const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async name=>[name,(await db.query(`select to_jsonb(t) value from public."${name}" t order by to_jsonb(t)::text collate "C"`)).rows])));
  const before=await snapshot();
  const dir=new URL('../supabase/migrations/',import.meta.url);
  const applied=new Set(history.map(e=>e.name));
  const pending=(await readdir(dir)).filter(f=>f.endsWith('.sql')&&!applied.has(f.replace(/^\d+_/,'').replace(/\.sql$/,''))).sort();
  // Locate M13 by name: reviewed migrations ordered after it
  // are part of the pending chain and are replayed after the R6 checkpoint.
  const m13='20261021084732_sc019_credits_payments_inventory.sql';
  const m13Index=pending.indexOf(m13);
  assert.equal(m13Index,13,'Exactly 13 observed-pending migrations precede M13');
  assert.equal(pending[m13Index-2],'20261021084245_explicit_data_api_table_acl.sql');
  assert.equal(pending[m13Index-1],'20261021084500_normalize_function_line_endings.sql');
  let afterM13=null;
  for(const name of pending) {
    if(name===m13) {
      const observed=await catalogSnapshot(db), manifest=await migrationManifest();
      const expected=manifest.states.r4_legacy['pg'+process.env.SC19_TEST_PG_MAJOR];
      t.diagnostic(JSON.stringify({observed,expected,mismatches:Object.keys(expected).filter(k=>expected[k]!==observed[k])}));

    }
    const sql=await readFile(new URL(name,dir),'utf8');
    if(name===m13) for(const mutation of [
      'grant execute on function public.platform_operator_status() to service_role with grant option',
      'grant execute on function private.erasure_hash(jsonb) to service_role',
      'grant create on schema public to service_role',
      'grant select(id) on public.companies to service_role',
      'create table public.unreviewed_hosted_table(id integer)',
      'grant erasure_worker to anon with admin false, inherit false, set false',
    ]) {
      const beforeCatalog=await catalogSnapshot(db);
      await db.query('begin'); await db.query(mutation);
      await assert.rejects(db.query(sql), /sc19_(source_schema_unreviewed|unsafe_worker_role)/);
      await db.query('rollback');
      assert.deepEqual(await catalogSnapshot(db),beforeCatalog,'Refusal rolls back hosted ACL normalization and hostile changes');
    }
    const protectedRole = name==='20261010204840_erasure_execution_protocol.sql' ? 'erasure_worker'
      : name==='20261012031026_retention_scheduler_protocol.sql' ? 'erasure_scheduler' : null;
    if(protectedRole) for(const mutation of [
      `grant ${protectedRole} to postgres with admin false, inherit false, set false`,
      `alter role ${protectedRole} login`,
      `grant ${protectedRole} to postgres with admin false, inherit true, set false`,
      `grant ${protectedRole} to postgres with admin false, inherit false, set true`,
      `grant ${protectedRole} to anon with admin false, inherit false, set false`,
      `grant anon to ${protectedRole} with admin false, inherit false, set false`,
    ]) {
      await db.query('begin');
      await db.query(`create role ${protectedRole} nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`);
      await db.query(mutation);
      await assert.rejects(db.query(sql), /Unsafe (erasure|scheduler) role/);
      await db.query('rollback');
      assert.equal((await db.query('select count(*)::int n from pg_roles where rolname=$1',[protectedRole])).rows[0].n,0);
    }
    if(['20261010205030_erasure_purge_graph.sql','20261012031039_retention_scheduler_inventory.sql'].includes(name)) {
      const access=async()=>({
        memberships:(await db.query(`select to_jsonb(m) v from pg_auth_members m where roleid='erasure_purge_owner'::regrole or member='erasure_purge_owner'::regrole order by roleid,member,grantor`)).rows,
        acl:(await db.query(`select nspacl::text v from pg_namespace where nspname='private'`)).rows,
      });
      const beforeAccess=await access();
      await platform.query('begin; set local role postgres');
      await assert.rejects(platform.query(sql), /Migration identity must be direct/);
      await platform.query('rollback');
      assert.deepEqual(await access(),beforeAccess,'Indirect migration identity is refused atomically');
      const duringAccess=name==='20261010205030_erasure_purge_graph.sql'
        ? sql.replace('alter function private.erasure_purge_engine(uuid,bigint,boolean) owner to erasure_purge_owner;',
          'alter function private.erasure_purge_engine(uuid,bigint,boolean) owner to erasure_purge_owner; select 1/0;')
        : sql.replace('reset role;','select 1/0; reset role;');
      await assert.rejects(db.query(duringAccess), /division by zero/);
      await db.query('rollback');
      assert.deepEqual(await access(),beforeAccess,'Failed ownership transfer restores all memberships and schema ACL');
      assert.equal((await db.query('select current_user')).rows[0].current_user,'postgres');
      if(name==='20261010205030_erasure_purge_graph.sql') assert.equal((await db.query("select to_regclass('private.erasure_purge_manifest') v")).rows[0].v,null);
      await db.query(sql);
      assert.equal((await db.query('select current_user')).rows[0].current_user,'postgres');
      assert.deepEqual((await access()).memberships,beforeAccess.memberships,'Successful ownership transfer restores exact membership');
      assert.equal((await db.query("select has_schema_privilege('erasure_purge_owner','private','CREATE') v")).rows[0].v,false);
    } else await db.query(sql);
    t.diagnostic(`applied pending ${name}`);
    if(name===m13) {
      assert.deepEqual(await snapshot(),before,'No existing application data rewritten or removed');
      await assertR6(db);
      afterM13=await snapshot();
    }
  }
  assert.ok(afterM13,'M13 was applied');
  // Later reviewed migrations may only add columns: every existing value is unchanged.
  const canonical=(rows,keys)=>rows.map(row=>JSON.stringify(keys.map(k=>[k,row.value[k]]))).sort();
  const final=await snapshot();
  for(const [table,rows] of Object.entries(afterM13)) {
    const keys=Object.keys(rows[0]?.value??{}).sort();
    assert.deepEqual(canonical(final[table],keys),canonical(rows,keys),`${table} existing rows and values preserved`);
  }
  await assertCurrentInventory(db);
  for(const [table,rows] of Object.entries(await accountingSnapshot(db))) assert.deepEqual(rows,[],`No commercial activation or retrospective billing: ${table}`);
  await h.asUser(f.owner); assert.equal((await h.row(f)).eligibility_reason,'eligible');
  assert.equal((await h.shortlist(f)).length,1);
  await h.asUser(users.otherOwner); await assert.rejects(h.ranking(f),error=>error.code==='42501');
  await h.asAdmin();
  for(const role of ['anon','authenticated','service_role','screening_worker']) for(const table of ['private.sc19_balances','private.sc19_credit_journal','private.sc19_payment_orders']) {
    for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) assert.equal((await db.query('select has_table_privilege($1,$2,$3) allowed',[role,table,privilege])).rows[0].allowed,false);
  }
});
