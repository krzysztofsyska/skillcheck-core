import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

// Real PostgreSQL sessions: an advisory lock cannot be proven on a single PGlite connection.
const maintenanceUrl = process.env.SCREENING_TEST_DATABASE_URL;
const databaseName = `company_limit_${process.pid}`;
const migrations = [
  '20260930000100_skillcheck_core.sql',
  '20261001000100_idempotent_onboarding.sql',
  '20261030130000_company_creation_limit.sql',
];
const user = '00000000-0000-0000-0000-000000000201';

test('concurrent create_company and ensure_initial_company create at most one owned company', async (t) => {
  assert.ok(maintenanceUrl, 'SCREENING_TEST_DATABASE_URL is required for the PostgreSQL concurrency suite');
  const url = new URL(maintenanceUrl);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Disposable loopback database only');
  const maintenance = new pg.Client({ connectionString: url.href });
  await maintenance.connect();
  await maintenance.query(`drop database if exists ${databaseName} with (force)`);
  await maintenance.query(`create database ${databaseName}`);
  const target = new URL(url); target.pathname = `/${databaseName}`;
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.end().catch(() => {})));
    await maintenance.query(`drop database if exists ${databaseName} with (force)`).catch(() => {});
    await maintenance.end();
  });
  const connect = async () => { const c = new pg.Client({ connectionString: target.href }); await c.connect(); clients.push(c); return c; };
  const admin = await connect();
  await admin.query(`do $$ begin
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    end $$;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
  for (const name of migrations) await admin.query(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
  await admin.query('insert into auth.users values ($1)', [user]);

  for (const round of ['create_company', 'ensure_initial_company']) {
    await admin.query('delete from public.company_profiles; delete from public.companies');
    const sessions = await Promise.all(Array.from({ length: 6 }, connect));
    for (const s of sessions) {
      await s.query('set role authenticated');
      await s.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
      await s.query('begin');
    }
    const calls = sessions.map((s, i) => s.query(`select public.${round}($1) id`, [`Firma ${i}`])
      .then(async r => { await s.query('commit'); return { ok: r.rows[0].id }; },
        async error => { await s.query('rollback'); return { error }; }));
    const results = await Promise.all(calls);
    const ok = results.filter(r => r.ok);
    const companies = (await admin.query('select id from public.companies where owner_id=$1', [user])).rows;
    assert.equal(companies.length, 1, `${round}: exactly one owned company`);
    if (round === 'create_company') {
      assert.equal(ok.length, 1);
      for (const r of results.filter(r => r.error)) assert.equal(r.error.code, 'PT409');
    } else {
      // Onboarding stays idempotent: every caller gets the same company, nobody sees PT409.
      assert.equal(ok.length, sessions.length);
      assert.deepEqual([...new Set(ok.map(r => r.ok))], [companies[0].id]);
    }
  }
});
