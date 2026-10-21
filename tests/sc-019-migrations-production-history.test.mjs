import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { createRankingHarness, users } from './helpers/screening-ranking-fixture.mjs';
import { assertR6, accountingSnapshot } from './helpers/sc19-migration-fixture.mjs';

// An isolated CI-owned cluster with real pg_cron, never a production connection.
// This replays observed application migration history, not a Supabase platform dump.
test('observed production history + pending chain preserves completed synthetic screening and installs empty R6 billing', async t => {
  assert.equal(process.env.SC19_REHEARSAL_DISPOSABLE, 'yes');
  const url = new URL(process.env.SC19_REHEARSAL_DATABASE_URL);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55432');
  assert.equal(url.pathname, '/sc19_production_rehearsal');
  assert.ok(['16','17'].includes(process.env.SC19_TEST_PG_MAJOR));
  const db = new pg.Client({ connectionString: url.href });
  await db.connect(); t.after(() => db.end()); db.exec = sql => db.query(sql);
  assert.equal(Math.floor(Number((await db.query("select current_setting('server_version_num') v")).rows[0].v)/10000), Number(process.env.SC19_TEST_PG_MAJOR));
  assert.equal((await db.query("select to_regclass('public.companies') v")).rows[0].v, null, 'Only an empty owned test database');
  await db.query(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated;
    grant execute on function auth.uid() to anon,authenticated;`);
  const {history} = JSON.parse(await readFile(new URL('./fixtures/sc19-production-history.json', import.meta.url),'utf8'));
  assert.equal(history.length,19);
  for (const entry of history) {
    await db.query(entry.statements.join(';\n') + ';');
    t.diagnostic(`replayed observed ${entry.version} ${entry.name}`);
  }
  assert.equal((await db.query("select count(*)::int n from pg_extension where extname='pg_cron'")).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from cron.job')).rows[0].n,0,'No scheduled destructive job');
  const membership=(await db.query(`select inherit_option,set_option from pg_auth_members where roleid='screening_worker'::regrole and member='postgres'::regrole`)).rows;
  assert.ok(membership.some(r=>r.set_option && !r.inherit_option));
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
  assert.equal(pending.length,13);
  assert.equal(pending.at(-2),'20261021084245_explicit_data_api_table_acl.sql');
  assert.equal(pending.at(-1),'20261021084732_sc019_credits_payments_inventory.sql');
  for(const name of pending) { await db.query(await readFile(new URL(name,dir),'utf8')); t.diagnostic(`applied pending ${name}`); }
  assert.deepEqual(await snapshot(),before,'No existing application data rewritten or removed');
  await assertR6(db);
  for(const [table,rows] of Object.entries(await accountingSnapshot(db))) assert.deepEqual(rows,[],`No commercial activation or retrospective billing: ${table}`);
  await h.asUser(f.owner); assert.equal((await h.row(f)).eligibility_reason,'eligible');
  assert.equal((await h.shortlist(f)).length,1);
  await h.asUser(users.otherOwner); assert.deepEqual(await h.ranking(f),[]);
  await h.asAdmin();
  for(const role of ['anon','authenticated','screening_worker']) for(const table of ['private.sc19_balances','private.sc19_credit_journal','private.sc19_payment_orders']) {
    for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) assert.equal((await db.query('select has_table_privilege($1,$2,$3) allowed',[role,table,privilege])).rows[0].allowed,false);
  }
});
