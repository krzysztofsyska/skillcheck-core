import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migrations = [
  '20260930000100_skillcheck_core.sql',
  '20261001000100_idempotent_onboarding.sql',
  '20261101120000_company_creation_limit.sql',
];

test('create_company allows one owned company per user; ensure_initial_company is unchanged', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  // Emulate Supabase Auth roles, not a production auth implementation.
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  for (const name of migrations) await db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
  const [owner, newcomer, recruiter, legacy] = Array.from({ length: 4 }, (_, i) => `00000000-0000-0000-0000-00000000010${i}`);
  for (const id of [owner, newcomer, recruiter, legacy]) await db.query('insert into auth.users values ($1)', [id]);
  const asUser = async (id, role = 'authenticated') => {
    await db.exec(`reset role; set role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id ?? '']);
  };
  const asAdmin = async () => { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub', '', false)"); };
  const owned = async id => { await asAdmin(); return (await db.query('select count(*)::int n from public.companies where owner_id=$1', [id])).rows[0].n; };
  const limitReached = error => error.code === 'PT409' && /Company limit reached/.test(error.message);

  await asAdmin();
  assert.equal((await db.query('select private.company_creation_limit() n')).rows[0].n, 1);
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await db.query("select has_function_privilege($1, 'private.company_creation_limit()', 'EXECUTE') v", [role])).rows[0].v, false);
  }

  // First company succeeds; a second explicit creation is refused with PT409.
  await asUser(owner);
  const first = (await db.query("select public.create_company('Firma A') id")).rows[0].id;
  assert.ok(first);
  await assert.rejects(db.query("select public.create_company('Firma B')"), limitReached);
  assert.equal(await owned(owner), 1);

  // ensure_initial_company returns the owned company instead of raising.
  await asUser(owner);
  assert.equal((await db.query("select public.ensure_initial_company('Ignored') id")).rows[0].id, first);

  // A new user is onboarded exactly once; retries are idempotent.
  await asUser(newcomer);
  const created = (await db.query("select public.ensure_initial_company('Nowa firma') id")).rows[0].id;
  assert.equal((await db.query("select public.ensure_initial_company('Retry') id")).rows[0].id, created);
  assert.equal(await owned(newcomer), 1);

  // A member of another firm gets that firm and creates nothing.
  await asAdmin();
  await db.query("insert into public.company_members(company_id,user_id,role) values ($1,$2,'recruiter')", [first, recruiter]);
  await asUser(recruiter);
  assert.equal((await db.query("select public.ensure_initial_company('Do not create') id")).rows[0].id, first);
  assert.equal(await owned(recruiter), 0);
  // Membership elsewhere does not consume the owned-company limit.
  await asUser(recruiter);
  assert.ok((await db.query("select public.create_company('Own firm') id")).rows[0].id);
  assert.equal(await owned(recruiter), 1);

  // Existing owners above the limit keep their data and cannot add more.
  await asAdmin();
  await db.query("insert into public.companies(name, owner_id) values ('Legacy 1',$1),('Legacy 2',$1)", [legacy]);
  await asUser(legacy);
  await assert.rejects(db.query("select public.create_company('Legacy 3')"), limitReached);
  assert.equal((await db.query("select public.ensure_initial_company('x') id")).rows.length, 1);
  assert.equal(await owned(legacy), 2);

  // Unchanged authentication and validation behaviour.
  await asUser(null, 'anon');
  await assert.rejects(db.query("select public.create_company('Anonymous')"), error => error.code === '42501');
  await asUser(null);
  await assert.rejects(db.query("select public.create_company('Missing session')"), error => error.code === '42501');
  await asUser(owner);
  const ensureSource = (await db.query("select prosrc from pg_proc where oid='public.ensure_initial_company(text)'::regprocedure")).rows[0].prosrc;
  const original = (await readFile(new URL('../supabase/migrations/20261001000100_idempotent_onboarding.sql', import.meta.url), 'utf8'));
  assert.ok(original.includes(ensureSource), 'ensure_initial_company body is byte-for-byte the reviewed onboarding source');
});

test('rollback restores the original create_company and drops the limit', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  for (const name of migrations) await db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
  const aclBefore = (await db.query("select proacl::text acl from pg_proc where oid='public.create_company(text)'::regprocedure")).rows[0].acl;
  await db.exec(await readFile(new URL('../supabase/rollbacks/20261101120000_company_creation_limit_down.sql', import.meta.url), 'utf8'));

  assert.equal((await db.query("select to_regprocedure('private.company_creation_limit()') is null gone")).rows[0].gone, true);
  assert.equal((await db.query("select proacl::text acl from pg_proc where oid='public.create_company(text)'::regprocedure")).rows[0].acl, aclBefore);
  const source = (await db.query("select prosrc from pg_proc where oid='public.create_company(text)'::regprocedure")).rows[0].prosrc;
  const original = await readFile(new URL('../supabase/migrations/20260930000100_skillcheck_core.sql', import.meta.url), 'utf8');
  assert.ok(original.includes(source), 'create_company body is byte-for-byte the reviewed original source');

  // Without the limit, the same user can own a second company again; onboarding still works.
  const user = '00000000-0000-0000-0000-000000000200';
  await db.query('insert into auth.users values ($1)', [user]);
  await db.exec('set role authenticated');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user]);
  const first = (await db.query("select public.ensure_initial_company('Pierwsza') id")).rows[0].id;
  assert.ok((await db.query("select public.create_company('Druga') id")).rows[0].id);
  assert.equal((await db.query("select public.ensure_initial_company('Retry') id")).rows[0].id, first);
});
