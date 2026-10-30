import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

// An isolated CI-owned cluster with real pg_cron, never a production connection.
// Models the observed hosted creator: supabase_admin is the bootstrap superuser,
// postgres a non-superuser that owns the database and runs the migrations.
export async function bootHostedRehearsal(t, url) {
  assert.equal(process.env.SC19_REHEARSAL_DISPOSABLE, 'yes');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.hostname, '127.0.0.1');
  const database = url.pathname.slice(1);
  const platformUrl = new URL(url); platformUrl.username = 'supabase_admin';
  const platform = new pg.Client({ connectionString: platformUrl.href });
  await platform.connect(); t.after(() => platform.end());
  assert.equal((await platform.query("select to_regclass('public.companies') v")).rows[0].v, null);
  // PG16+ generates the bootstrap-admin membership automatically on CREATE ROLE.
  await platform.query(`create role postgres login inherit createrole createdb replication bypassrls password 'synthetic-only';
    alter database ${database} owner to postgres;
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant anon,authenticated,service_role to postgres with admin true, inherit true, set true;
    create extension pg_cron;`);
  const db = new pg.Client({ connectionString: url.href });
  await db.connect(); t.after(() => db.end()); db.exec = sql => db.query(sql);
  assert.deepEqual((await db.query(`select current_user::text name,session_user::text session,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls from pg_roles where rolname=current_user`)).rows[0],
    {name:'postgres',session:'postgres',rolsuper:false,rolinherit:true,rolcreaterole:true,rolcreatedb:true,rolcanlogin:true,rolreplication:true,rolbypassrls:true});
  assert.equal(Math.floor(Number((await db.query("select current_setting('server_version_num') v")).rows[0].v)/10000), Number(process.env.SC19_TEST_PG_MAJOR));
  assert.equal((await db.query("select to_regclass('public.companies') v")).rows[0].v, null, 'Only an empty owned test database');
  await db.query(`alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
    grant usage on schema public to postgres,anon,authenticated,service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated;
    grant execute on function auth.uid() to anon,authenticated;`);
  return { platform, db };
}

// Replays the observed application migration history, not a Supabase platform dump.
export async function replayObservedHistory(t, db) {
  const { history } = JSON.parse(await readFile(new URL('../fixtures/sc19-production-history.json', import.meta.url), 'utf8'));
  assert.equal(history.length, 19);
  for (const entry of history) {
    await db.query(entry.statements.join(';\n') + ';');
    t.diagnostic(`replayed observed ${entry.version} ${entry.name}`);
  }
  return history;
}
