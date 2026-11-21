// R7: the Fakturownia VAT invoice record (migration 20261122000000) against
// PostgreSQL 16 (disposable loopback database, SC19_TEST_DATABASE_URL). A minimal
// fixture of the tables the migrations touch stands in for the full SC-019 history;
// the real migration files (Stripe checkout, then the invoice record) are applied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const url = process.env.SC19_TEST_DATABASE_URL;
const file = name => readFileSync(new URL(`../supabase/${name}`, import.meta.url), 'utf8');
const checkout = file('migrations/20261121110000_r7_stripe_checkout.sql');
const migration = file('migrations/20261122000000_r7_fakturownia_vat_invoice.sql');
const rollback = file('rollbacks/20261122000000_r7_fakturownia_vat_invoice_down.sql');
const A = '00000000-0000-4000-8000-000000000001';
const fixture = `
 do $$ declare r text; begin
  -- Roles are cluster-wide and other test files create them in parallel: tolerate the race.
  foreach r in array array['anon','authenticated','sc19_p24_checkout'] loop
   begin execute format('create role %I nologin noinherit', r);
   exception when duplicate_object or unique_violation then null; end;
  end loop;
 end $$;
 create schema private;
 create table public.companies(id uuid primary key, name text not null, owner_id uuid not null);
 create table private.sc19_trial_approvals(company_id uuid primary key references public.companies(id), nip text not null);
 create table private.sc19_payment_orders(id uuid primary key, company_id uuid not null, provider text not null,
  account text not null, mode text not null, status text not null, session_id text, checkout_url text, payment_id text);
 alter table private.sc19_payment_orders enable row level security;
 grant usage on schema private to sc19_p24_checkout;
 create function private.erasure_schema_signature() returns text language sql stable as $f$
  select md5(string_agg(n.nspname||'.'||c.relname||':'||a.attname, ',' order by 1))
  from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0
  where n.nspname in ('public','private') and c.relkind='r' $f$;
 insert into public.companies values ('${A}','Firma A','00000000-0000-4000-8000-000000000002');
 insert into private.sc19_trial_approvals values ('${A}','7394002294');
`;

test('R7 VAT invoice record: live paid Stripe orders only, one claim, outcome recorded, adapter role has no table access, rollback',
  { skip: !url && 'SC19_TEST_DATABASE_URL required' }, async t => {
  const u = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw Error('Disposable loopback database required');
  const root = new pg.Client({ connectionString: u.href }); await root.connect();
  const name = 'r7invoice_' + randomBytes(6).toString('hex');
  await root.query(`create database "${name}"`); u.pathname = '/' + name;
  const db = new pg.Client({ connectionString: u.href }); await db.connect();
  const other = new pg.Client({ connectionString: u.href }); await other.connect();
  t.after(async () => { await db.end(); await other.end(); await root.query(`drop database "${name}"`); await root.end(); });
  await db.query(fixture);
  await db.query(checkout);
  const signature = (await db.query('select private.erasure_schema_signature() s')).rows[0].s;
  await db.query(migration);
  assert.equal((await db.query('select private.erasure_schema_signature() s')).rows[0].s, signature, 'erasure schema unchanged');
  await assert.rejects(db.query(migration), /already_installed/);
  await db.query('rollback');

  const asRole = async (client, sql, values) => {
    await client.query('begin'); await client.query('set local role sc19_p24_checkout');
    try { const r = await client.query(sql, values); await client.query('commit'); return r; }
    catch (e) { await client.query('rollback'); throw e; }
  };
  const addOrder = async (mode, status, provider = 'stripe', account = 'ktig-consulting') => (await db.query(
    `insert into private.sc19_payment_orders values (gen_random_uuid(),$1,$2,$3,$4,$5) returning id`,
    [A, provider, account, mode, status])).rows[0].id;
  const claim = (id, client = db) => asRole(client, 'select * from sc19_stripe.claim_vat_invoice($1)', [id]).then(r => r.rows);
  const finish = (id, ...args) => asRole(db, 'select sc19_stripe.finish_vat_invoice($1,$2,$3,$4,$5) ok', [id, ...args]).then(r => r.rows[0].ok);
  const row = async id => (await db.query('select status, attempts, fakturownia_id, invoice_number, error_code from sc19_stripe.vat_invoices where order_id=$1', [id])).rows[0];

  // Not eligible: test mode, unpaid, another provider or account, unknown order. No row, no buyer data.
  for (const id of [await addOrder('test', 'paid'), await addOrder('live', 'awaiting_payment'),
    await addOrder('live', 'paid', 'przelewy24'), await addOrder('live', 'paid', 'stripe', 'other'),
    '00000000-0000-4000-8000-0000000000ff']) {
    assert.deepEqual(await claim(id), [{ outcome: 'not_eligible', company_name: null, nip: null }]);
    assert.equal(await row(id), undefined);
  }

  // Live paid order: concurrent claims — exactly one gets the buyer data.
  const live = await addOrder('live', 'paid');
  const [x, y] = await Promise.all([claim(live, db), claim(live, other)]);
  const outcomes = [x[0].outcome, y[0].outcome].sort();
  assert.deepEqual(outcomes, ['claimed', 'issuing']);
  const won = x[0].outcome === 'claimed' ? x[0] : y[0];
  assert.deepEqual(won, { outcome: 'claimed', company_name: 'Firma A', nip: '7394002294' });
  assert.deepEqual(await claim(live), [{ outcome: 'issuing', company_name: null, nip: null }]);

  // 'failed' (nothing created) may be claimed again; 'check' never; 'issued' is final.
  assert.equal(await finish(live, 'failed', null, null, 'FAKTUROWNIA_RATE_LIMITED'), true);
  assert.equal(await finish(live, 'issued', 5, 'FV 1', null), false, 'only an issuing row changes');
  assert.equal((await row(live)).status, 'failed');
  assert.equal((await claim(live))[0].outcome, 'claimed');
  assert.equal((await row(live)).attempts, 2);
  assert.equal(await finish(live, 'issued', 5, 'FV 1/11/2026', null), true);
  assert.deepEqual(await row(live), { status: 'issued', attempts: 2, fakturownia_id: '5', invoice_number: 'FV 1/11/2026', error_code: null });
  assert.deepEqual(await claim(live), [{ outcome: 'issued', company_name: null, nip: null }]);
  assert.equal(await finish(live, 'failed', null, null, 'X'), false);

  const unsure = await addOrder('live', 'paid');
  await claim(unsure);
  assert.equal(await finish(unsure, 'check', null, null, 'FAKTUROWNIA_TIMEOUT'), true);
  assert.deepEqual(await claim(unsure), [{ outcome: 'check', company_name: null, nip: null }]);
  assert.equal((await row(unsure)).attempts, 1);

  // Constraints: bad status, issued without id, error code shape.
  const bad = await addOrder('live', 'paid'); await claim(bad);
  await assert.rejects(finish(bad, 'issuing', null, null, null), /vat_invoice_status_invalid/);
  await assert.rejects(finish(bad, 'issued', null, null, null), /check constraint/);
  await assert.rejects(finish(bad, 'failed', null, null, 'buyer jan@example.test'), /check constraint/);
  await assert.rejects(finish(bad, 'failed', null, null, null), /check constraint/);

  // The adapter role reaches the record only through the two functions.
  await assert.rejects(asRole(db, 'select * from sc19_stripe.vat_invoices'), /permission denied/);
  await assert.rejects(asRole(db, `insert into sc19_stripe.vat_invoices(order_id,status) values (gen_random_uuid(),'issued')`), /permission denied/);
  await assert.rejects(asRole(db, 'select nip from private.sc19_trial_approvals'), /permission denied/);
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await db.query(`select has_function_privilege($1,'sc19_stripe.claim_vat_invoice(uuid)','execute') v`, [role])).rows[0].v, false);
    assert.equal((await db.query(`select has_function_privilege($1,'sc19_stripe.finish_vat_invoice(uuid,text,bigint,text,text)','execute') v`, [role])).rows[0].v, false);
  }
  for (const fn of ['claim_vat_invoice', 'finish_vat_invoice'])
    assert.deepEqual((await db.query(`select prosecdef, proconfig from pg_proc where proname=$1`, [fn])).rows,
      [{ prosecdef: true, proconfig: ['search_path=""'] }]);

  // Rollback refuses while records exist; succeeds on an empty table.
  await assert.rejects(db.query(rollback), /rollback_refused_records_exist/);
  await db.query('rollback');
  await db.query('delete from sc19_stripe.vat_invoices');
  await db.query(rollback);
  assert.equal((await db.query(`select to_regclass('sc19_stripe.vat_invoices') v`)).rows[0].v, null);
  assert.equal((await db.query(`select to_regprocedure('sc19_stripe.claim_vat_invoice(uuid)') v`)).rows[0].v, null);
  // And applies again after the rollback.
  await db.query(migration);
});
