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

// R7: WERYFIKACJA and ASSESSMENT CENTER through Stripe Checkout. The REAL
// orchestration (lib/sc19-payments.ts), the REAL Postgres store with the package
// extension, both R7 migrations and the REAL R3 gate function, run as the payment
// adapter's restricted role; Stripe itself is a fake provider (no network).
const packagesMigration = readFileSync(new URL('../supabase/migrations/20261121130000_r7_stripe_packages.sql', import.meta.url), 'utf8');
const packagesRollback = readFileSync(new URL('../supabase/rollbacks/20261121130000_r7_stripe_packages_down.sql', import.meta.url), 'utf8');
const gateSource = readFileSync(new URL('../supabase/migrations/20261121090000_r3_ac_package_gate.sql', import.meta.url), 'utf8');
const gateStart = gateSource.indexOf('create function private.ac_package_required');
const gateFn = gateSource.slice(gateStart, gateSource.indexOf('end;$$;', gateStart) + 'end;$$;'.length);
const fullFixture = `
 do $$ begin
  if not exists(select from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select from pg_roles where rolname='sc19_p24_checkout') then create role sc19_p24_checkout nologin noinherit; end if;
 end $$;
 create schema private; create schema sc19_commerce;
 create table public.companies(id uuid primary key, name text not null, owner_id uuid not null);
 create table private.sc19_trial_approvals(company_id uuid primary key references public.companies(id), nip text not null,
  approved_at timestamptz not null default now());
 create table private.sc19_payment_offers(id text primary key, revision text not null, plan text not null check(plan='PRESELEKCJA'),
  active boolean not null, approved boolean not null, amount_minor integer not null, currency text not null, credits integer not null,
  terms_revision text not null, terms_text text not null, valid_until_ms bigint not null, created_at timestamptz not null default now());
 create table private.sc19_payment_orders(id uuid primary key, company_id uuid not null references public.companies(id), buyer_id uuid not null,
  request_id uuid not null, offer_id text not null references private.sc19_payment_offers(id), offer_revision text not null,
  terms_revision text not null, amount_minor integer not null, currency text not null, credits integer not null, provider text not null,
  account text not null, mode text not null, status text not null, session_id text, checkout_url text, payment_id text,
  checkout_deadline_ms bigint not null, created_at timestamptz not null default now(), unique(company_id,request_id), unique(company_id,id));
 create unique index sc19_payment_one_unresolved on private.sc19_payment_orders(company_id) where status='awaiting_payment';
 create table private.sc19_payment_requests(company_id uuid not null, request_id uuid not null, order_id uuid not null,
  primary key(company_id,request_id), foreign key(company_id,order_id) references private.sc19_payment_orders(company_id,id));
 create table private.sc19_payment_grants(payment_key text primary key, order_id uuid not null unique references private.sc19_payment_orders(id));
 create table private.sc19_credit_journal(id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
  reason text not null, delta integer not null, reference text unique, created_at timestamptz not null default now());
 create table private.sc19_balances(company_id uuid primary key references public.companies(id), plan text not null check(plan in ('FREE','PRESELEKCJA')),
  available integer not null default 0 check(available>=0), free_claimed boolean not null default false, updated_at timestamptz not null default now());
 create table sc19_commerce.orders(company_id uuid not null, status text not null);
 create table sc19_commerce.entitlements(company_id uuid not null references public.companies(id), code text not null,
  available integer not null default 0 check(available>=0), used integer not null default 0, primary key(company_id,code));
 create function private.sc19_has_pending_catalog_order(target_company uuid) returns boolean language sql security definer set search_path='' as
  $f$ select exists(select 1 from sc19_commerce.orders where company_id=target_company and status='pending') $f$;
 -- Relations, columns AND constraints of public/private (incl. incoming foreign keys), like the real signature.
 create function private.erasure_schema_signature() returns text language sql stable as $f$
  select md5(string_agg(x, ',' order by x)) from (
   select n.nspname||'.'||c.relname||':'||a.attname x from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid and a.attnum>0 where n.nspname in ('public','private') and c.relkind='r'
   union all select 'k:'||k.conname||':'||pg_get_constraintdef(k.oid) from pg_constraint k
    where k.conrelid in (select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private'))
       or k.confrelid in (select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private'))) s $f$;
 -- The adapter role's grants and policies, as 20261111140000_sc19_p24_checkout_role.sql sets them.
 grant usage on schema private, public to sc19_p24_checkout;
 grant execute on function private.sc19_has_pending_catalog_order(uuid) to sc19_p24_checkout;
 grant select(id, owner_id), update(id) on public.companies to sc19_p24_checkout;
 grant select(company_id), update(company_id) on private.sc19_trial_approvals to sc19_p24_checkout;
 grant select, update(id) on private.sc19_payment_offers to sc19_p24_checkout;
 alter table public.companies enable row level security; alter table private.sc19_trial_approvals enable row level security;
 alter table private.sc19_payment_offers enable row level security; alter table private.sc19_payment_orders enable row level security;
 alter table private.sc19_payment_requests enable row level security; alter table private.sc19_payment_grants enable row level security;
 alter table private.sc19_credit_journal enable row level security; alter table private.sc19_balances enable row level security;
 create policy p24_checkout_read on public.companies for select to sc19_p24_checkout using (true);
 create policy p24_checkout_lock on public.companies for update to sc19_p24_checkout using (true) with check (false);
 create policy p24_checkout_read on private.sc19_trial_approvals for select to sc19_p24_checkout using (true);
 create policy p24_checkout_lock on private.sc19_trial_approvals for update to sc19_p24_checkout using (true) with check (false);
 create policy p24_checkout_read on private.sc19_payment_offers for select to sc19_p24_checkout using (approved and active);
 create policy p24_checkout_lock on private.sc19_payment_offers for update to sc19_p24_checkout using (approved and active) with check (false);
 grant select, insert, update(status, session_id, checkout_url, payment_id) on private.sc19_payment_orders to sc19_p24_checkout;
 create policy p24_checkout_orders on private.sc19_payment_orders to sc19_p24_checkout
  using (mode = 'test' and provider = 'przelewy24') with check (mode = 'test' and provider = 'przelewy24');
 grant select, insert on private.sc19_payment_requests, private.sc19_payment_grants to sc19_p24_checkout;
 create policy p24_checkout_requests on private.sc19_payment_requests to sc19_p24_checkout
  using (exists (select 1 from private.sc19_payment_orders o where o.id = order_id)) with check (exists (select 1 from private.sc19_payment_orders o where o.id = order_id));
 create policy p24_checkout_receipts on private.sc19_payment_grants to sc19_p24_checkout
  using (exists (select 1 from private.sc19_payment_orders o where o.id = order_id)) with check (exists (select 1 from private.sc19_payment_orders o where o.id = order_id));
 grant insert(company_id, reason, delta, reference) on private.sc19_credit_journal to sc19_p24_checkout;
 create policy p24_checkout_grant on private.sc19_credit_journal for insert to sc19_p24_checkout
  with check (reason = 'paid_grant' and delta > 0 and reference ~ '^settlement:sc19:[0-9a-f]{64}$');
 grant select, insert(company_id, plan, available), update(plan, available, updated_at) on private.sc19_balances to sc19_p24_checkout;
 create policy p24_checkout_balance on private.sc19_balances to sc19_p24_checkout using (true) with check (plan = 'PRESELEKCJA');
 insert into public.companies values ('00000000-0000-4000-8000-000000000001','Firma A','00000000-0000-4000-8000-000000000002');
 insert into private.sc19_trial_approvals(company_id,nip) values ('00000000-0000-4000-8000-000000000001','7394002294');
 insert into private.sc19_payment_offers values ('preselekcja-60-2026-11-r3','preselekcja-60-v3','PRESELEKCJA',true,true,30000,'PLN',60,
  'preselekcja-terms-2026-11-v3','Warunki.',1830297599000,now());
`;

test('R7 packages: paid test-mode WERYFIKACJA / ASSESSMENT CENTER grant once through the adapter role and satisfy the R3 AC gate',
  { skip: !url && 'SC19_TEST_DATABASE_URL required' }, async t => {
  const { createSc19Payments } = await import('../lib/sc19-payments.ts');
  const { createPostgresPaymentStore } = await import('../lib/sc19-payment-postgres.ts');
  const { stripePackageExtension, STRIPE_PACKAGE_OFFERS } = await import('../lib/sc19-stripe-packages.ts');
  const { readStripeBuyerCompany } = await import('../lib/sc19-stripe-provider.ts');
  const u = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw Error('Disposable loopback database required');
  const root = new pg.Client({ connectionString: u.href }); await root.connect();
  const name = 'r7packages_' + randomBytes(6).toString('hex');
  await root.query(`create database "${name}"`); u.pathname = '/' + name;
  const db = new pg.Client({ connectionString: u.href }); await db.connect();
  const pool = new pg.Pool({ connectionString: u.href, max: 3 });
  t.after(async () => { await pool.end(); await db.end(); await root.query(`drop database "${name}"`); await root.end(); });
  await db.query(fullFixture);
  await db.query(gateFn);
  await db.query(migration);
  const A = '00000000-0000-4000-8000-000000000001', OWNER = '00000000-0000-4000-8000-000000000002';
  const rolePool = { async connect() { const c = await pool.connect(); await c.query('set role sc19_p24_checkout'); return c; } };
  const scope = { provider: 'stripe', account: 'ktig-consulting', mode: 'test' };
  // The REAL buyer lookup of the Stripe runtime (lib/sc19-stripe-runtime.ts):
  // sc19_stripe.buyer() on its own connection as the adapter role, after the order
  // transaction committed — exactly where Stripe's createCheckout reads it.
  const roleQuery = async (sql, values) => {
    const c = await rolePool.connect();
    try { return (await c.query(sql, values)).rows; } finally { c.release(); }
  };
  const buyers = [];
  let paymentId = 'pi_fixtureac1';
  const provider = {
    async createCheckout(order) {
      buyers.push(await readStripeBuyerCompany(roleQuery, order.companyId));
      const sid = `cs_test_${order.id.replace(/-/g, '')}`;
      return { orderId: order.id, sessionId: sid, url: `https://checkout.stripe.com/c/pay/${sid}`, scope,
        amountMinor: order.amountMinor, currency: 'PLN', paymentKind: 'one_time' };
    },
    async lookupCheckout() { return null; },
    async verifyAndRetrieve(raw) {
      const order = JSON.parse(new TextDecoder().decode(raw));
      return { eventId: 'evt_fixture' + order.n, orderId: order.id, sessionId: order.sessionId, paymentId, scope,
        amountMinor: order.amountMinor, currency: 'PLN', status: 'paid' };
    },
  };
  const make = () => {
    const store = createPostgresPaymentStore(rolePool, stripePackageExtension);
    return { store, service: createSc19Payments({ store, provider, scope, checkoutOrigins: ['https://checkout.stripe.com'],
      enabled: true, liveApproved: false, authenticate: async () => ({ userId: OWNER }) }) };
  };
  const ac = STRIPE_PACKAGE_OFFERS.find(o => o.plan === 'ASSESSMENT_CENTER');
  const wer = STRIPE_PACKAGE_OFFERS.find(o => o.plan === 'WERYFIKACJA');
  const req = n => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
  const deliver = async (service, order, n = 1) =>
    service.notification(new TextEncoder().encode(JSON.stringify({ ...order, n })), 'sig');

  // Pre-migration schema: the extension offers nothing extra and package offers are unknown.
  {
    const { store, service } = make();
    assert.deepEqual((await store.listOffers(A, OWNER)).map(o => o.plan), ['PRESELEKCJA']);
    await assert.rejects(service.checkout({ companyId: A, offerId: ac.id, termsRevision: ac.termsRevision, requestId: req(1),
      packageCode: 'ASSESSMENT_CENTER' }), e => e.code === 'SC19_PAYMENT_OFFER_UNAVAILABLE');
  }
  const signature = (await db.query('select private.erasure_schema_signature() s')).rows[0].s;
  await db.query(packagesMigration);
  assert.equal((await db.query('select private.erasure_schema_signature() s')).rows[0].s, signature, 'erasure signature unchanged');
  await assert.rejects(db.query(packagesMigration), /already_installed/);
  await db.query('rollback');

  const { store, service } = make();
  assert.deepEqual((await store.listOffers(A, OWNER)).map(o => [o.plan, o.amountMinor]),
    [['PRESELEKCJA', 30000], ['WERYFIKACJA', 61500], ['ASSESSMENT_CENTER', 149900]]);
  // R3 gate before any purchase: refused.
  await assert.rejects(db.query('select private.ac_package_required($1)', [A]), /Assessment Center package required/);

  const hosted = await service.checkout({ companyId: A, offerId: ac.id, termsRevision: ac.termsRevision, requestId: req(2),
    packageCode: 'ASSESSMENT_CENTER' });
  assert.equal(hosted.amountMinor, 149900);
  const row = (await db.query('select * from sc19_stripe.package_orders where id=$1', [hosted.orderId])).rows[0];
  assert.equal(row.package_code, 'ASSESSMENT_CENTER'); assert.equal(row.mode, 'test'); assert.equal(row.session_id, hosted.sessionId);
  // Codex P1 (PR #563): buyer data is available for an unpaid PACKAGE order, so the
  // Stripe session is actually created instead of SC19_PAYMENT_FORBIDDEN.
  assert.deepEqual(buyers, [{ companyName: 'Firma A', nip: '7394002294' }]);
  assert.equal((await db.query(`select has_function_privilege('sc19_p24_checkout','sc19_stripe.buyer(uuid)','execute') r`)).rows[0].r, true);
  for (const role of ['anon', 'authenticated'])
    assert.equal((await db.query(`select has_function_privilege($1,'sc19_stripe.buyer(uuid)','execute') r`, [role])).rows[0].r, false);
  // Same request again: same order. Another purchase while it is unpaid: refused.
  assert.equal((await service.checkout({ companyId: A, offerId: ac.id, termsRevision: ac.termsRevision, requestId: req(2),
    packageCode: 'ASSESSMENT_CENTER' })).orderId, hosted.orderId);
  await assert.rejects(service.checkout({ companyId: A, offerId: 'preselekcja-60-2026-11-r3', termsRevision: 'preselekcja-terms-2026-11-v3',
    requestId: req(3), packageCode: 'PRESELEKCJA' }), e => e.code === 'SC19_PAYMENT_PURCHASE_PENDING');
  // Not paid yet: nothing granted.
  assert.equal((await db.query('select count(*)::int n from sc19_commerce.entitlements')).rows[0].n, 0);

  const order = { id: hosted.orderId, sessionId: hosted.sessionId, amountMinor: 149900 };
  assert.equal((await deliver(service, order)).state, 'applied');
  assert.equal((await deliver(service, order, 2)).state, 'already_applied');
  assert.deepEqual((await db.query(`select code, available from sc19_commerce.entitlements where company_id=$1`, [A])).rows,
    [{ code: 'package:ASSESSMENT_CENTER', available: 1 }]);
  assert.equal((await db.query('select available from private.sc19_balances where company_id=$1', [A])).rows[0].available, 50);
  assert.equal((await db.query('select count(*)::int n from private.sc19_credit_journal')).rows[0].n, 1);
  await db.query('select private.ac_package_required($1)', [A]); // the R3 gate now passes
  // Paid, nothing else unpaid: buyer data is closed again.
  await assert.rejects(readStripeBuyerCompany(roleQuery, A), e => e.code === 'SC19_PAYMENT_FORBIDDEN');
  const read = await store.readOrder(A, OWNER, hosted.orderId);
  assert.equal(read.status, 'paid'); assert.equal(read.packageCode, 'ASSESSMENT_CENTER');

  // WERYFIKACJA: a second order; the SAME payment id as the AC order is a reused receipt and grants nothing.
  const w = await service.checkout({ companyId: A, offerId: wer.id, termsRevision: wer.termsRevision, requestId: req(4), packageCode: 'WERYFIKACJA' });
  assert.equal(w.amountMinor, 61500);
  assert.equal(buyers.length, 2); assert.deepEqual(buyers[1], { companyName: 'Firma A', nip: '7394002294' });
  await assert.rejects(deliver(service, { id: w.orderId, sessionId: w.sessionId, amountMinor: 61500 }), e => e.code === 'SC19_PAYMENT_REUSED');
  assert.equal((await db.query('select count(*)::int n from sc19_stripe.package_grants')).rows[0].n, 1);
  paymentId = 'pi_fixturewer1';
  assert.equal((await deliver(service, { id: w.orderId, sessionId: w.sessionId, amountMinor: 61500 }, 3)).state, 'applied');
  assert.equal((await db.query(`select available from sc19_commerce.entitlements where company_id=$1 and code='package:WERYFIKACJA'`, [A])).rows[0].available, 1);
  assert.equal((await db.query('select available from private.sc19_balances where company_id=$1', [A])).rows[0].available, 110);

  // Role boundaries.
  const asRole = async (role, sql, values) => {
    await db.query('begin'); await db.query(`set local role ${role}`);
    try { const r = await db.query(sql, values); await db.query('commit'); return r; }
    catch (e) { await db.query('rollback'); throw e; }
  };
  const insert = (mode, amount, credits, code = 'ASSESSMENT_CENTER') => asRole('sc19_p24_checkout', `insert into sc19_stripe.package_orders
    (id,company_id,buyer_id,request_id,package_code,offer_id,offer_revision,terms_revision,amount_minor,currency,credits,provider,account,mode,status,checkout_deadline_ms)
    values (gen_random_uuid(),$1,$2,gen_random_uuid(),$5,'x','x','x',$3,'PLN',$4,'stripe','ktig-consulting',$6,'awaiting_payment',1)`,
    [A, OWNER, amount, credits, code, mode]);
  await assert.rejects(insert('live', 149900, 50), /row-level security/);
  await assert.rejects(insert('test', 100, 50), /package_orders_price_list/);
  await assert.rejects(insert('test', 61500, 120, 'WERYFIKACJA'), /package_orders_price_list/);
  await assert.rejects(asRole('sc19_p24_checkout', 'select * from sc19_stripe.package_grants'), /permission denied/);
  await assert.rejects(asRole('sc19_p24_checkout', 'delete from sc19_stripe.package_orders'), /permission denied/);
  await assert.rejects(asRole('sc19_p24_checkout', 'update sc19_stripe.package_orders set amount_minor=1'), /permission denied/);
  await assert.rejects(asRole('sc19_p24_checkout', `select sc19_stripe.grant_package($1,'k')`, [hosted.orderId]), /stripe_package_grant_invalid/);
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(asRole(role, 'select * from sc19_stripe.package_orders'), /permission denied/);
    await assert.rejects(asRole(role, `select sc19_stripe.grant_package($1,'k')`, [hosted.orderId]), /permission denied/);
  }
  // Paid without a receipt is impossible even for a direct update; a paid order never changes.
  const third = (await db.query(`insert into sc19_stripe.package_orders
    (id,company_id,buyer_id,request_id,package_code,offer_id,offer_revision,terms_revision,amount_minor,currency,credits,provider,account,mode,status,session_id,checkout_url,checkout_deadline_ms)
    values (gen_random_uuid(),$1,$2,gen_random_uuid(),'WERYFIKACJA','x','x','x',61500,'PLN',60,'stripe','ktig-consulting','test','awaiting_payment','cs_test_x','https://checkout.stripe.com/c/pay/cs_test_x',1) returning id`,
    [A, OWNER])).rows[0].id;
  await assert.rejects(db.query(`update sc19_stripe.package_orders set status='paid', payment_id='pi_x' where id=$1`, [third]), /sc19_stripe_package_immutable/);
  await assert.rejects(db.query(`update sc19_stripe.package_orders set status='awaiting_payment', payment_id=null where id=$1`, [hosted.orderId]), /sc19_stripe_package_immutable/);

  // Rollback refuses while orders exist, then undoes everything without touching the erasure signature.
  await assert.rejects(db.query(packagesRollback), /refused/);
  await db.query('rollback').catch(() => {});
  await db.query(`alter table sc19_stripe.package_orders disable trigger package_order_immutable;
   alter table sc19_stripe.package_requests disable trigger package_request_immutable;
   alter table sc19_stripe.package_grants disable trigger package_grant_immutable;
   delete from sc19_stripe.package_grants; delete from sc19_stripe.package_requests; delete from sc19_stripe.package_orders;`);
  await db.query(packagesRollback);
  assert.equal((await db.query(`select to_regclass('sc19_stripe.package_orders') r`)).rows[0].r, null);
  assert.notEqual((await db.query(`select to_regnamespace('sc19_stripe') n`)).rows[0].n, null, 'the R7 checkout schema stays');
  // The buyer lookup is back to the R7 checkout body (PRESELEKCJA orders only), still callable and still closed to the API roles.
  assert.doesNotMatch((await db.query(`select pg_get_functiondef('sc19_stripe.buyer(uuid)'::regprocedure) d`)).rows[0].d, /package_orders/);
  assert.deepEqual(await roleQuery('select * from sc19_stripe.buyer($1)', [A]), []);
  assert.equal((await db.query(`select has_function_privilege('anon','sc19_stripe.buyer(uuid)','execute') r`)).rows[0].r, false);
  assert.equal((await db.query('select private.erasure_schema_signature() s')).rows[0].s, signature);
});
