// R7: the Stripe checkout migration against PostgreSQL 16 (disposable loopback
// database, SC19_TEST_DATABASE_URL). A minimal fixture of the tables the migration
// touches stands in for the full SC-019 history; the real migration file is applied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const url = process.env.SC19_TEST_DATABASE_URL;
const migration = readFileSync(new URL('../supabase/migrations/20261121110000_r7_stripe_checkout.sql', import.meta.url), 'utf8');
const rollback = readFileSync(new URL('../supabase/rollbacks/20261121110000_r7_stripe_checkout_down.sql', import.meta.url), 'utf8');
// The REAL order guard, taken verbatim from the SC-019 migration: the trigger
// function and its trigger on private.sc19_payment_orders.
const history = readFileSync(new URL('../supabase/migrations/20261021084732_sc019_credits_payments_inventory.sql', import.meta.url), 'utf8');
const guardFn = history.slice(history.indexOf('create or replace function private.sc19_payment_immutable()'),
  history.indexOf('end $$;', history.indexOf('create or replace function private.sc19_payment_immutable()')) + 'end $$;'.length);
const guardTrigger = /create trigger sc19_order_immutable[^;]+;/.exec(history)[0];
const fixture = `
 do $$ begin
  if not exists(select from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select from pg_roles where rolname='sc19_p24_checkout') then create role sc19_p24_checkout nologin noinherit; end if;
 end $$;
 create schema private;
 create table public.companies(id uuid primary key, name text not null, owner_id uuid not null);
 create table private.sc19_trial_approvals(company_id uuid primary key references public.companies(id), nip text not null);
 create table private.sc19_payment_orders(id uuid primary key, company_id uuid not null, provider text not null,
  account text not null, mode text not null, status text not null, session_id text, checkout_url text, payment_id text);
 alter table private.sc19_payment_orders enable row level security;
 grant usage on schema private to sc19_p24_checkout;
 grant select, insert, update(status, session_id, checkout_url, payment_id) on private.sc19_payment_orders to sc19_p24_checkout;
 create policy p24_checkout_orders on private.sc19_payment_orders to sc19_p24_checkout
  using (mode='test' and provider='przelewy24') with check (mode='test' and provider='przelewy24');
 create function private.erasure_schema_signature() returns text language sql stable as $f$
  select md5(string_agg(n.nspname||'.'||c.relname||':'||a.attname, ',' order by 1))
  from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0
  where n.nspname in ('public','private') and c.relkind='r' $f$;
 insert into public.companies values ('00000000-0000-4000-8000-000000000001','Firma A','00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-000000000003','Firma B','00000000-0000-4000-8000-000000000002');
 insert into private.sc19_trial_approvals values ('00000000-0000-4000-8000-000000000001','7394002294'),
  ('00000000-0000-4000-8000-000000000003','1234567890');
`;

test('R7 migration: additive, TEST-mode Stripe orders only, buyer data only for an unpaid Stripe order, rollback',
  { skip: !url && 'SC19_TEST_DATABASE_URL required' }, async t => {
  const u = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw Error('Disposable loopback database required');
  const root = new pg.Client({ connectionString: u.href }); await root.connect();
  const name = 'r7stripe_' + randomBytes(6).toString('hex');
  await root.query(`create database "${name}"`); u.pathname = '/' + name;
  const db = new pg.Client({ connectionString: u.href }); await db.connect();
  t.after(async () => { await db.end(); await root.query(`drop database "${name}"`); await root.end(); });
  await db.query(fixture);
  await db.query(guardFn); await db.query(guardTrigger);
  const signature = (await db.query('select private.erasure_schema_signature() s')).rows[0].s;
  await db.query(migration);
  assert.equal((await db.query('select private.erasure_schema_signature() s')).rows[0].s, signature);
  await assert.rejects(db.query(migration), /already_installed/);
  await db.query('rollback');

  const A = '00000000-0000-4000-8000-000000000001', B = '00000000-0000-4000-8000-000000000003';
  const asRole = async (sql, values) => {
    await db.query('begin'); await db.query('set local role sc19_p24_checkout');
    try { const r = await db.query(sql, values); await db.query('commit'); return r; }
    catch (e) { await db.query('rollback'); throw e; }
  };
  const order = (mode, provider = 'stripe', account = 'ktig-consulting') =>
    asRole(`insert into private.sc19_payment_orders values (gen_random_uuid(),$1,$2,$3,$4,'awaiting_payment')`, [A, provider, account, mode]);
  // No unpaid Stripe order yet: no buyer data.
  assert.equal((await asRole('select * from sc19_stripe.buyer($1)', [A])).rows.length, 0);
  await order('test');
  // Stripe order lifecycle under the real immutability trigger: binding the first
  // session and settling are allowed; replacing a bound session is not (why an
  // expired Stripe session is refused rather than re-bound).
  const stripeOrder = (await db.query(`select id from private.sc19_payment_orders where provider='stripe'`)).rows[0].id;
  await asRole(`update private.sc19_payment_orders set session_id='cs_test_a', checkout_url='https://checkout.stripe.com/c/pay/cs_test_a' where id=$1`, [stripeOrder]);
  await assert.rejects(asRole(`update private.sc19_payment_orders set session_id='cs_test_b', checkout_url='https://checkout.stripe.com/c/pay/cs_test_b' where id=$1`, [stripeOrder]), /sc19_order_immutable/);
  await asRole(`update private.sc19_payment_orders set status='paid', payment_id='pi_fixture1' where id=$1`, [stripeOrder]);
  await assert.rejects(asRole(`update private.sc19_payment_orders set status='awaiting_payment' where id=$1`, [stripeOrder]), /sc19_order_immutable/);
  await asRole(`insert into private.sc19_payment_orders values (gen_random_uuid(),$1,'stripe','ktig-consulting','test','awaiting_payment')`, [A]);
  await assert.rejects(order('live'), /row-level security/);
  await assert.rejects(order('test', 'stripe', 'another-account'), /row-level security/);
  await order('test', 'przelewy24');
  assert.deepEqual((await asRole('select * from sc19_stripe.buyer($1)', [A])).rows, [{ company_name: 'Firma A', nip: '7394002294' }]);
  assert.equal((await asRole('select * from sc19_stripe.buyer($1)', [B])).rows.length, 0, 'other company has no Stripe order');
  await assert.rejects(asRole('select nip from private.sc19_trial_approvals'), /permission denied/);
  // Customers: insert/select test only, no update or delete.
  await asRole(`insert into sc19_stripe.customers(company_id,mode,customer_id) values ($1,'test','cus_fixture1')`, [A]);
  await assert.rejects(asRole(`insert into sc19_stripe.customers(company_id,mode,customer_id) values ($1,'live','cus_fixture2')`, [A]), /row-level security/);
  await assert.rejects(asRole(`update sc19_stripe.customers set customer_id='cus_other1'`), /permission denied/);
  await assert.rejects(asRole(`delete from sc19_stripe.customers`), /permission denied/);
  assert.equal((await asRole('select customer_id from sc19_stripe.customers where company_id=$1', [A])).rows[0].customer_id, 'cus_fixture1');
  // Compare-and-set replacement of a deleted customer: wrong stale id changes nothing, live mode refused.
  assert.equal((await asRole(`select sc19_stripe.replace_customer($1,'test','cus_wrong1','cus_fixture3') v`, [A])).rows[0].v, 'cus_fixture1');
  await assert.rejects(asRole(`select sc19_stripe.replace_customer($1,'live','cus_fixture1','cus_fixture3')`, [A]), /stripe_customer_invalid/);
  assert.equal((await asRole(`select sc19_stripe.replace_customer($1,'test','cus_fixture1','cus_fixture3') v`, [A])).rows[0].v, 'cus_fixture3');
  for (const role of ['anon', 'authenticated']) {
    await db.query('begin'); await db.query(`set local role ${role}`);
    await assert.rejects(db.query(`select sc19_stripe.replace_customer($1,'test','cus_fixture3','cus_fixture4')`, [A]), /permission denied/);
    await db.query('rollback');
  }
  // API roles see nothing.
  for (const role of ['anon', 'authenticated']) {
    await db.query('begin'); await db.query(`set local role ${role}`);
    await assert.rejects(db.query('select * from sc19_stripe.customers'), /permission denied/);
    await db.query('rollback');
  }
  // Rollback refuses while accounting records exist, then undoes everything.
  await assert.rejects(db.query(rollback), /refused/);
  await db.query('rollback').catch(() => {});
  await db.query(`alter table private.sc19_payment_orders disable trigger sc19_order_immutable;
   delete from private.sc19_payment_orders where provider='stripe'; delete from sc19_stripe.customers;`);
  await db.query(rollback);
  assert.equal((await db.query(`select to_regnamespace('sc19_stripe') n`)).rows[0].n, null);
  assert.equal((await db.query(`select count(*)::int n from pg_policies where policyname like 'stripe_%'`)).rows[0].n, 0);
});
