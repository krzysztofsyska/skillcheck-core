// Creates four isolated databases in the disposable CI PostgreSQL service.
import pg from 'pg';
import { readFile } from 'node:fs/promises';
const url = process.env.SALES_LEADS_TEST_DATABASE_URL;
if (!url || process.env.SALES_LEADS_TEST_DISPOSABLE !== 'YES') throw new Error('Disposable PostgreSQL required');
const parsed = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) throw new Error('Local CI service only');
const admin = new pg.Client({ connectionString: url });
await admin.connect();
try {
  await admin.query("create role anon; create role authenticated;");
  for (const name of ['sales_default', 'sales_current', 'sales_previous', 'sales_after']) {
    await admin.query(`create database ${name}`);
    const target = new URL(url); target.pathname = '/' + name;
    const client = new pg.Client({ connectionString: target.href });
    await client.connect();
    try {
      await client.query(`create schema auth; create schema private;
        create table auth.users(id uuid primary key);
        create function auth.uid() returns uuid language sql stable as $$
          select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
        grant usage on schema auth, public to anon, authenticated;
        grant usage on schema private to authenticated;
        grant execute on function auth.uid() to anon, authenticated;`);
      await client.query(await readFile(new URL('../supabase/migrations/20261007000200_sales_leads.sql', import.meta.url), 'utf8'));
    } finally { await client.end(); }
  }
} finally { await admin.end(); }
