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
const packagesMigration = readFileSync(new URL('../supabase/migrations/20261121150000_r7_stripe_packages.sql', import.meta.url), 'utf8');
const packagesRollback = readFileSync(new URL('../supabase/rollbacks/20261121150000_r7_stripe_packages_down.sql', import.meta.url), 'utf8');
const gateSource = readFileSync(new URL('../supabase/migrations/20261121090000_r3_ac_package_gate.sql', import.meta.url), 'utf8');
const gateStart = gateSource.indexOf('create function private.ac_package_required');
const gateFn = gateSource.slice(gateStart, gateSource.indexOf('end;$$;', gateStart) + 'end;$$;'.length);
// The REAL catalog order function as the SC-019 catalog migration created it (the
// R7 packages migration redefines it; Codex P2, PR #563).
const catalogSource = readFileSync(new URL('../supabase/migrations/20261107164252_sc019_catalog_orders.sql', import.meta.url), 'utf8');
const catalogStart = catalogSource.indexOf('create function public.sc19_create_catalog_order(');
const catalogOrderFn = catalogSource.slice(catalogStart, catalogSource.indexOf('end;$$;', catalogStart) + 'end;$$;'.length);
const CATALOG_QUOTE = { kind: 'service', code: 'fixture-service', packageCode: null, quantity: 1,
  versionId: '00000000-0000-4000-8000-000000000301', termsRevision: 'terms-fixture', termsText: 'Warunki.',
  cvCredits: 0, serviceCode: 'fixture-service', serviceUnits: 1, grossMinor: 10000 };
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
 create table sc19_commerce.orders(id uuid primary key default gen_random_uuid(), company_id uuid not null, buyer_id uuid,
  request_id uuid, version_id uuid, kind text, code text, package_code text, quantity integer, gross_minor integer,
  cv_credits integer, service_code text, service_units integer, terms_revision text, terms_text text,
  status text not null default 'pending');
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
 -- Stand-ins for what the REAL catalog order function (appended below) calls.
 create schema auth;
 create function auth.uid() returns uuid language sql stable as $f$ select '00000000-0000-4000-8000-000000000002'::uuid $f$;
 create function sc19_commerce.authorize(target_company uuid, purchase boolean default false) returns void language plpgsql as $f$ begin end $f$;
 create function private.sc19_lock_company(target_company uuid) returns void language plpgsql as $f$ begin end $f$;
 create function sc19_commerce.quote(target_company uuid, kind text, code text, package_code text, quantity integer) returns jsonb
  language sql as $f$ select '${JSON.stringify(CATALOG_QUOTE)}'::jsonb $f$;
` + catalogOrderFn + `
 revoke all on function public.sc19_create_catalog_order(uuid,uuid,jsonb,boolean) from public,anon,authenticated;
 grant execute on function public.sc19_create_catalog_order(uuid,uuid,jsonb,boolean) to authenticated;
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

// Codex P2 (PR #566): a Przelewy24 TEST order left unpaid ('awaiting_payment')
// before the switch to Stripe must not block a Stripe purchase. Przelewy24
// settlement no longer exists, so such an order can never be paid; it stays
// exactly as it is (never deleted or changed) and never grants anything.
test('R7: a stale unpaid Przelewy24 order neither blocks a Stripe purchase nor grants anything',
  { skip: !url && 'SC19_TEST_DATABASE_URL required' }, async t => {
  const { createSc19Payments } = await import('../lib/sc19-payments.ts');
  const { createPostgresPaymentStore } = await import('../lib/sc19-payment-postgres.ts');
  const { stripePackageExtension, STRIPE_PACKAGE_OFFERS } = await import('../lib/sc19-stripe-packages.ts');
  const u = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw Error('Disposable loopback database required');
  const root = new pg.Client({ connectionString: u.href }); await root.connect();
  const name = 'r7stalep24_' + randomBytes(6).toString('hex');
  await root.query(`create database "${name}"`); u.pathname = '/' + name;
  const db = new pg.Client({ connectionString: u.href }); await db.connect();
  const pool = new pg.Pool({ connectionString: u.href, max: 3 });
  t.after(async () => { await pool.end(); await db.end(); await root.query(`drop database "${name}"`); await root.end(); });
  await db.query(fullFixture);
  await db.query(migration);
  const A = '00000000-0000-4000-8000-000000000001', OWNER = '00000000-0000-4000-8000-000000000002';
  // The stale Przelewy24 order, with a bound sandbox session, as the old adapter left it.
  const stale = (await db.query(`insert into private.sc19_payment_orders
    (id,company_id,buyer_id,request_id,offer_id,offer_revision,terms_revision,amount_minor,currency,credits,provider,account,mode,status,
     session_id,checkout_url,checkout_deadline_ms)
    values (gen_random_uuid(),$1,$2,gen_random_uuid(),'preselekcja-60-2026-11-r3','preselekcja-60-v3','preselekcja-terms-2026-11-v3',
     30000,'PLN',60,'przelewy24','sandbox-merchant','test','awaiting_payment','p24_stale_token',
     'https://sandbox.przelewy24.pl/trnRequest/p24_stale_token',1) returning id`, [A, OWNER])).rows[0].id;
  const rolePool = { async connect() { const c = await pool.connect(); await c.query('set role sc19_p24_checkout'); return c; } };
  const scope = { provider: 'stripe', account: 'ktig-consulting', mode: 'test' };
  let paymentId = 'pi_fixturestale1';
  const provider = {
    async createCheckout(order) {
      const sid = `cs_test_${order.id.replace(/-/g, '')}`;
      return { orderId: order.id, sessionId: sid, url: `https://checkout.stripe.com/c/pay/${sid}`, scope,
        amountMinor: order.amountMinor, currency: 'PLN', paymentKind: 'one_time' };
    },
    async lookupCheckout() { return null; },
    async verifyAndRetrieve(raw) {
      const order = JSON.parse(new TextDecoder().decode(raw));
      return { eventId: 'evt_stale' + order.n, orderId: order.id, sessionId: order.sessionId, paymentId, scope,
        amountMinor: order.amountMinor, currency: 'PLN', status: 'paid' };
    },
  };
  const service = createSc19Payments({ store: createPostgresPaymentStore(rolePool, stripePackageExtension), provider, scope,
    checkoutOrigins: ['https://checkout.stripe.com'], enabled: true, liveApproved: false, authenticate: async () => ({ userId: OWNER }) });
  const req = n => `00000000-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`;
  const deliver = (order, n) => service.notification(new TextEncoder().encode(JSON.stringify({ ...order, n })), 'sig');
  const wer = STRIPE_PACKAGE_OFFERS.find(o => o.plan === 'WERYFIKACJA');
  const preselekcja = n => service.checkout({ companyId: A, offerId: 'preselekcja-60-2026-11-r3',
    termsRevision: 'preselekcja-terms-2026-11-v3', requestId: req(n), packageCode: 'PRESELEKCJA' });

  // Pre-migration schema (company-wide index): the stale order still answers
  // „purchase pending”, never a unique-index failure.
  await assert.rejects(preselekcja(9), e => e.code === 'SC19_PAYMENT_PURCHASE_PENDING');
  const signature = (await db.query('select private.erasure_schema_signature() s')).rows[0].s;
  await db.query(packagesMigration);
  assert.equal((await db.query('select private.erasure_schema_signature() s')).rows[0].s, signature, 'erasure signature unchanged');

  // A package purchase (separate order table) opens next to the stale order.
  const w = await service.checkout({ companyId: A, offerId: wer.id, termsRevision: wer.termsRevision, requestId: req(1), packageCode: 'WERYFIKACJA' });
  assert.equal(w.amountMinor, 61500);
  // Still at most one unresolved Stripe purchase per company, across both order tables.
  await assert.rejects(preselekcja(2), e => e.code === 'SC19_PAYMENT_PURCHASE_PENDING');
  assert.equal((await deliver({ id: w.orderId, sessionId: w.sessionId, amountMinor: 61500 }, 1)).state, 'applied');
  // PRESELEKCJA through Stripe also opens next to the stale order (same order table, same unique index).
  paymentId = 'pi_fixturestale2';
  const pre = await preselekcja(3);
  assert.equal(pre.amountMinor, 30000);
  // The database itself still allows one unresolved non-Przelewy24 order per company.
  await assert.rejects(db.query(`insert into private.sc19_payment_orders
    (id,company_id,buyer_id,request_id,offer_id,offer_revision,terms_revision,amount_minor,currency,credits,provider,account,mode,status,checkout_deadline_ms)
    values (gen_random_uuid(),$1,$2,gen_random_uuid(),'preselekcja-60-2026-11-r3','x','x',30000,'PLN',60,'stripe','ktig-consulting','test','awaiting_payment',1)`,
    [A, OWNER]), e => e.code === '23505' && e.constraint === 'sc19_payment_one_unresolved');
  assert.equal((await deliver({ id: pre.orderId, sessionId: pre.sessionId, amountMinor: 30000 }, 2)).state, 'applied');
  // The stale order can never be settled through Stripe, stays exactly as it was and grants nothing.
  paymentId = 'pi_fixturestale3';
  await assert.rejects(deliver({ id: stale, sessionId: 'p24_stale_token', amountMinor: 30000 }, 3), e => e.code === 'SC19_PAYMENT_SCOPE_MISMATCH');
  assert.deepEqual((await db.query('select status, session_id, payment_id from private.sc19_payment_orders where id=$1', [stale])).rows,
    [{ status: 'awaiting_payment', session_id: 'p24_stale_token', payment_id: null }]);
  assert.equal((await db.query('select available from private.sc19_balances where company_id=$1', [A])).rows[0].available, 120);
  assert.equal((await db.query('select count(*)::int n from private.sc19_credit_journal')).rows[0].n, 2);
  assert.equal((await db.query('select count(*)::int n from private.sc19_payment_grants where order_id=$1', [stale])).rows[0].n, 0);

  // Rollback: refused while a company holds a Przelewy24 order AND another unresolved
  // order (the company-wide index could not be rebuilt); otherwise restores it.
  await db.query(`alter table sc19_stripe.package_orders disable trigger package_order_immutable;
   alter table sc19_stripe.package_requests disable trigger package_request_immutable;
   alter table sc19_stripe.package_grants disable trigger package_grant_immutable;
   delete from sc19_stripe.package_grants; delete from sc19_stripe.package_requests; delete from sc19_stripe.package_orders;`);
  paymentId = 'pi_fixturestale4';
  await preselekcja(4);
  await assert.rejects(db.query(packagesRollback), /r7_stripe_packages_rollback_refused_unresolved_orders/);
  await db.query('rollback').catch(() => {});
  await db.query('delete from private.sc19_payment_orders where id=$1', [stale]);
  await db.query(packagesRollback);
  assert.match((await db.query(`select pg_get_indexdef('private.sc19_payment_one_unresolved'::regclass) d`)).rows[0].d,
    /\(company_id\) WHERE \(status = 'awaiting_payment'::text\)$/);
});

// Codex P2 (PR #563): public.sc19_create_catalog_order must not open a catalog
// order next to an unpaid WERYFIKACJA / ASSESSMENT CENTER Stripe order. Fails on
// the pre-fix body (it checked only PRESELEKCJA payment orders and catalog orders).
test('R7: an unpaid package order blocks a new catalog order; a stale Przelewy24 order does not; rollback restores the old body',
  { skip: !url && 'SC19_TEST_DATABASE_URL required' }, async t => {
  const u = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw Error('Disposable loopback database required');
  const root = new pg.Client({ connectionString: u.href }); await root.connect();
  const name = 'r7catalog_' + randomBytes(6).toString('hex');
  await root.query(`create database "${name}"`); u.pathname = '/' + name;
  const db = new pg.Client({ connectionString: u.href }); await db.connect();
  t.after(async () => { await db.end(); await root.query(`drop database "${name}"`); await root.end(); });
  await db.query(fullFixture);
  await db.query(migration);
  const fn = 'public.sc19_create_catalog_order(uuid,uuid,jsonb,boolean)';
  const meta = async () => (await db.query(`select prosecdef definer, proconfig config,
    has_function_privilege('anon',oid,'execute') anon, has_function_privilege('authenticated',oid,'execute') staff,
    pg_get_functiondef(oid) ~ 'package_orders' package_guard from pg_proc where oid=$1::regprocedure`, [fn])).rows[0];
  assert.deepEqual(await meta(), { definer: true, config: ['search_path=""'], anon: false, staff: true, package_guard: false });
  const signature = (await db.query('select private.erasure_schema_signature() s')).rows[0].s;
  await db.query(packagesMigration);
  assert.equal((await db.query('select private.erasure_schema_signature() s')).rows[0].s, signature, 'erasure signature unchanged');
  // Same signature, security definer, empty search_path and grants; now with the package guard.
  assert.deepEqual(await meta(), { definer: true, config: ['search_path=""'], anon: false, staff: true, package_guard: true });

  const A = '00000000-0000-4000-8000-000000000001', OWNER = '00000000-0000-4000-8000-000000000002';
  const catalog = () => db.query(`select public.sc19_create_catalog_order($1,gen_random_uuid(),$2::jsonb,true) id`,
    [A, JSON.stringify(CATALOG_QUOTE)]);
  const pending = e => e.code === '23505' && /commerce_pending_order/.test(e.message);
  // An unpaid TEST-mode package order: no catalog order next to it.
  const pkg = (await db.query(`insert into sc19_stripe.package_orders
    (id,company_id,buyer_id,request_id,package_code,offer_id,offer_revision,terms_revision,amount_minor,currency,credits,provider,account,mode,status,session_id,checkout_url,checkout_deadline_ms)
    values (gen_random_uuid(),$1,$2,gen_random_uuid(),'WERYFIKACJA','x','x','x',61500,'PLN',60,'stripe','ktig-consulting','test','awaiting_payment',
     'cs_test_catalog','https://checkout.stripe.com/c/pay/cs_test_catalog',1) returning id`, [A, OWNER])).rows[0].id;
  await assert.rejects(catalog(), pending);
  assert.equal((await db.query('select count(*)::int n from sc19_commerce.orders')).rows[0].n, 0);
  // Once paid, it no longer blocks; a stale unpaid Przelewy24 order never does.
  await db.query(`alter table sc19_stripe.package_orders disable trigger package_order_immutable;
   update sc19_stripe.package_orders set status='paid', payment_id='pi_fixturecatalog1' where id='${pkg}';
   alter table sc19_stripe.package_orders enable trigger package_order_immutable;`);
  await db.query(`insert into private.sc19_payment_orders
    (id,company_id,buyer_id,request_id,offer_id,offer_revision,terms_revision,amount_minor,currency,credits,provider,account,mode,status,checkout_deadline_ms)
    values (gen_random_uuid(),$1,$2,gen_random_uuid(),'preselekcja-60-2026-11-r3','x','x',30000,'PLN',60,'przelewy24','sandbox-merchant','test','awaiting_payment',1)`,
    [A, OWNER]);
  const created = (await catalog()).rows[0].id;
  assert.deepEqual((await db.query('select company_id, status from sc19_commerce.orders where id=$1', [created])).rows, [{ company_id: A, status: 'pending' }]);
  // The open catalog order blocks the next one, as before.
  await assert.rejects(catalog(), pending);
  // An unpaid Stripe PRESELEKCJA order still blocks too.
  await db.query(`update sc19_commerce.orders set status='cancelled'`);
  await db.query(`insert into private.sc19_payment_orders
    (id,company_id,buyer_id,request_id,offer_id,offer_revision,terms_revision,amount_minor,currency,credits,provider,account,mode,status,checkout_deadline_ms)
    values (gen_random_uuid(),$1,$2,gen_random_uuid(),'preselekcja-60-2026-11-r3','x','x',30000,'PLN',60,'stripe','ktig-consulting','test','awaiting_payment',1)`,
    [A, OWNER]);
  await assert.rejects(catalog(), pending);

  // Rollback restores the SC-019 body (no reference to the dropped table), same grants.
  await db.query(`delete from private.sc19_payment_orders;
   alter table sc19_stripe.package_orders disable trigger package_order_immutable; delete from sc19_stripe.package_orders;`);
  await db.query(packagesRollback);
  assert.deepEqual(await meta(), { definer: true, config: ['search_path=""'], anon: false, staff: true, package_guard: false });
  assert.equal((await db.query(`select prosrc from pg_proc where oid=$1::regprocedure`, [fn])).rows[0].prosrc,
    catalogOrderFn.slice(catalogOrderFn.indexOf('$$') + 2, catalogOrderFn.lastIndexOf('$$')));
});

// R7 (issue #367, R7-STRIPE-EXPIRED-SESSION): an expired, unpaid Stripe session
// closes its order without any grant, through the REAL orchestration, Postgres store,
// package extension, the real order guards (sc19_order_immutable from the SC-019
// migration, package_order_immutable) and the payment adapter's restricted role.
const expiredMigration = readFileSync(new URL('../supabase/migrations/20261121180000_r7_stripe_expired_session.sql', import.meta.url), 'utf8');
const expiredRollback = readFileSync(new URL('../supabase/rollbacks/20261121180000_r7_stripe_expired_session_down.sql', import.meta.url), 'utf8');
test('R7: an expired unpaid session closes PRESELEKCJA and package orders without granting; buying again works; late payment never grants; rollback',
  { skip: !url && 'SC19_TEST_DATABASE_URL required' }, async t => {
  const { createSc19Payments } = await import('../lib/sc19-payments.ts');
  const { createPostgresPaymentStore } = await import('../lib/sc19-payment-postgres.ts');
  const { stripePackageExtension, STRIPE_PACKAGE_OFFERS } = await import('../lib/sc19-stripe-packages.ts');
  const { readStripeBuyerCompany } = await import('../lib/sc19-stripe-provider.ts');
  const u = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw Error('Disposable loopback database required');
  const root = new pg.Client({ connectionString: u.href }); await root.connect();
  const name = 'r7expired_' + randomBytes(6).toString('hex');
  await root.query(`create database "${name}"`); u.pathname = '/' + name;
  const db = new pg.Client({ connectionString: u.href }); await db.connect();
  const pool = new pg.Pool({ connectionString: u.href, max: 3 });
  t.after(async () => { await pool.end(); await db.end(); await root.query(`drop database "${name}"`); await root.end(); });
  await db.query(fullFixture);
  await db.query(guardFn); await db.query(guardTrigger);
  await db.query(gateFn);
  await db.query(migration);
  await db.query(packagesMigration);
  const A = '00000000-0000-4000-8000-000000000001', OWNER = '00000000-0000-4000-8000-000000000002';
  const rolePool = { async connect() { const c = await pool.connect(); await c.query('set role sc19_p24_checkout'); return c; } };
  const roleQuery = async (sql, values) => { const c = await rolePool.connect(); try { return (await c.query(sql, values)).rows; } finally { c.release(); } };
  const scope = { provider: 'stripe', account: 'ktig-consulting', mode: 'test' };
  const expired = new Set(); let paymentId = 'pi_fixtureexp1';
  const provider = {
    async createCheckout(order) {
      const sid = `cs_test_${order.id.replace(/-/g, '')}`;
      return { orderId: order.id, sessionId: sid, url: `https://checkout.stripe.com/c/pay/${sid}`, scope,
        amountMinor: order.amountMinor, currency: 'PLN', paymentKind: 'one_time' };
    },
    async lookupCheckout() { return null; },
    async expiredSession(order) { return expired.has(order.sessionId); },
    async verifyAndRetrieve(raw) {
      const e = JSON.parse(new TextDecoder().decode(raw));
      return { eventId: 'evt_exp' + e.n, orderId: e.id, sessionId: e.sessionId, paymentId: e.status === 'expired' ? e.sessionId : paymentId,
        scope, amountMinor: e.amountMinor, currency: 'PLN', status: e.status ?? 'paid' };
    },
  };
  const store = createPostgresPaymentStore(rolePool, stripePackageExtension);
  const service = createSc19Payments({ store, provider, scope, checkoutOrigins: ['https://checkout.stripe.com'],
    enabled: true, liveApproved: false, authenticate: async () => ({ userId: OWNER }) });
  const req = n => `00000000-0000-4000-8000-0000000003${String(n).padStart(2, '0')}`;
  const deliver = (o, n, status) => service.notification(new TextEncoder().encode(JSON.stringify({ ...o, n, status })), 'sig');
  const preselekcja = n => service.checkout({ companyId: A, offerId: 'preselekcja-60-2026-11-r3',
    termsRevision: 'preselekcja-terms-2026-11-v3', requestId: req(n), packageCode: 'PRESELEKCJA' });
  const ac = STRIPE_PACKAGE_OFFERS.find(o => o.plan === 'ASSESSMENT_CENTER');
  const wer = STRIPE_PACKAGE_OFFERS.find(o => o.plan === 'WERYFIKACJA');
  const pkg = (o, n) => service.checkout({ companyId: A, offerId: o.id, termsRevision: o.termsRevision, requestId: req(n), packageCode: o.plan });
  const count = async sql => (await db.query(sql)).rows[0].n;

  // Pre-migration schema: an expired session keeps the old answer.
  const p0 = await preselekcja(1);
  expired.add(p0.sessionId);
  await assert.rejects(preselekcja(1), e => e.code === 'SC19_PAYMENT_RECONCILIATION_REQUIRED');

  // Migration: erasure signature unchanged, not re-runnable; rollback before any closure restores the old state.
  const signature = (await db.query('select private.erasure_schema_signature() s')).rows[0].s;
  await db.query(expiredMigration);
  assert.equal((await db.query('select private.erasure_schema_signature() s')).rows[0].s, signature, 'erasure signature unchanged');
  await assert.rejects(db.query(expiredMigration), /already_installed/);
  await db.query('rollback');
  await db.query(expiredRollback);
  assert.equal((await db.query(`select to_regclass('sc19_stripe.order_closures') r`)).rows[0].r, null);
  assert.doesNotMatch((await db.query(`select pg_get_functiondef('private.sc19_payment_immutable()'::regprocedure) d`)).rows[0].d, /order_closures/);
  assert.doesNotMatch((await db.query(`select pg_get_functiondef('sc19_stripe.buyer(uuid)'::regprocedure) d`)).rows[0].d, /sc19:expired/);
  assert.equal((await db.query('select private.erasure_schema_signature() s')).rows[0].s, signature);
  await db.query(expiredMigration);

  // Grants: only the adapter role may close; nobody reads the closures directly.
  assert.equal((await db.query(`select has_function_privilege('sc19_p24_checkout','sc19_stripe.close_expired_order(uuid,text)','execute') r`)).rows[0].r, true);
  for (const role of ['anon', 'authenticated', 'sc19_p24_checkout'])
    assert.equal((await db.query(`select has_table_privilege($1,'sc19_stripe.order_closures','select') r`, [role])).rows[0].r, false, role);
  for (const role of ['anon', 'authenticated'])
    assert.equal((await db.query(`select has_function_privilege($1,'sc19_stripe.close_expired_order(uuid,text)','execute') r`, [role])).rows[0].r, false, role);
  const fn = (await db.query(`select prosecdef, proconfig from pg_proc where oid='sc19_stripe.close_expired_order(uuid,text)'::regprocedure`)).rows[0];
  assert.equal(fn.prosecdef, true); assert.deepEqual(fn.proconfig, ['search_path=""']);

  // PRESELEKCJA: the expired order closes without credits; same request id is told to start again.
  await assert.rejects(preselekcja(1), e => e.code === 'SC19_PAYMENT_SESSION_EXPIRED');
  assert.deepEqual((await db.query('select status, session_id, checkout_url, payment_id from private.sc19_payment_orders where id=$1', [p0.orderId])).rows,
    [{ status: 'awaiting_payment', session_id: p0.sessionId, checkout_url: 'sc19:expired', payment_id: null }]);
  assert.deepEqual((await db.query('select order_source, session_id, reason from sc19_stripe.order_closures')).rows,
    [{ order_source: 'preselekcja', session_id: p0.sessionId, reason: 'session_expired' }]);
  assert.equal((await store.readOrder(A, OWNER, p0.orderId)).status, 'expired');
  await assert.rejects(preselekcja(1), e => e.code === 'SC19_PAYMENT_SESSION_EXPIRED');
  assert.equal(await count('select count(*)::int n from private.sc19_credit_journal'), 0);
  assert.equal(await count('select count(*)::int n from private.sc19_payment_grants'), 0);
  // A closed order holds no buyer data and blocks no catalog order.
  await assert.rejects(readStripeBuyerCompany(roleQuery, A), e => e.code === 'SC19_PAYMENT_FORBIDDEN');
  const catalogId = (await db.query(`select public.sc19_create_catalog_order($1,gen_random_uuid(),$2::jsonb,true) id`,
    [A, JSON.stringify(CATALOG_QUOTE)])).rows[0].id;
  await db.query(`update sc19_commerce.orders set status='paid' where id=$1`, [catalogId]);
  // A late "paid" for the closed order never grants: refused, and the database refuses too.
  await assert.rejects(deliver({ id: p0.orderId, sessionId: p0.sessionId, amountMinor: 30000 }, 1), e => e.code === 'SC19_PAYMENT_ORDER_CLOSED_REVIEW');
  await assert.rejects(db.query(`update private.sc19_payment_orders set status='paid', payment_id='pi_x', checkout_url='https://checkout.stripe.com/c/pay/x' where id=$1`, [p0.orderId]), /sc19_order_immutable/);
  await assert.rejects(db.query(`update private.sc19_payment_orders set status='paid', payment_id='pi_x' where id=$1`, [p0.orderId]), /sc19_order_immutable/);
  // The webhook "expired" for it again: already closed, nothing else happens.
  assert.equal((await deliver({ id: p0.orderId, sessionId: p0.sessionId, amountMinor: 30000 }, 2, 'expired')).state, 'already_closed');

  // A new purchase opens (the slot is free) and is granted exactly once.
  const p1 = await preselekcja(2);
  assert.notEqual(p1.orderId, p0.orderId);
  assert.deepEqual(await readStripeBuyerCompany(roleQuery, A), { companyName: 'Firma A', nip: '7394002294' });
  // An open session is never closed, by the checkout path or the database function.
  assert.equal((await preselekcja(2)).sessionId, p1.sessionId);
  await assert.rejects(roleQuery('select sc19_stripe.close_expired_order($1,$2)', [p1.orderId, 'cs_test_other']), /stripe_order_close_invalid/);
  // A direct closing update without the closure row is refused (the role cannot even read the closures).
  await assert.rejects(roleQuery(`update private.sc19_payment_orders set checkout_url='sc19:expired' where id=$1`, [p1.orderId]), /permission denied|sc19_order_immutable/);
  await assert.rejects(db.query(`update private.sc19_payment_orders set checkout_url='sc19:expired' where id=$1`, [p1.orderId]), /sc19_order_immutable/);
  assert.equal((await deliver({ id: p1.orderId, sessionId: p1.sessionId, amountMinor: 30000 }, 3)).state, 'applied');
  assert.equal((await db.query('select available from private.sc19_balances where company_id=$1', [A])).rows[0].available, 60);
  // A paid order is never closed.
  await assert.rejects(roleQuery('select sc19_stripe.close_expired_order($1,$2)', [p1.orderId, p1.sessionId]), /stripe_order_close_invalid/);
  expired.add(p1.sessionId);
  assert.deepEqual(await preselekcja(2), { orderId: p1.orderId, paid: true });

  // ASSESSMENT CENTER: closed by the signed expired event; nothing granted; WERYFIKACJA then opens.
  paymentId = 'pi_fixtureexp2';
  const a0 = await pkg(ac, 10);
  assert.equal((await deliver({ id: a0.orderId, sessionId: a0.sessionId, amountMinor: 149900 }, 4, 'expired')).state, 'closed');
  assert.equal((await db.query('select status from sc19_stripe.package_orders where id=$1', [a0.orderId])).rows[0].status, 'expired');
  assert.equal(await count('select count(*)::int n from sc19_commerce.entitlements'), 0);
  await assert.rejects(roleQuery(`select sc19_stripe.grant_package($1,'k')`, [a0.orderId]), /stripe_package_grant_invalid/);
  await assert.rejects(deliver({ id: a0.orderId, sessionId: a0.sessionId, amountMinor: 149900 }, 5), e => e.code === 'SC19_PAYMENT_ORDER_CLOSED_REVIEW');
  await assert.rejects(db.query(`update sc19_stripe.package_orders set status='awaiting_payment' where id=$1`, [a0.orderId]), /sc19_stripe_package_immutable/);
  await assert.rejects(pkg(ac, 10), e => e.code === 'SC19_PAYMENT_SESSION_EXPIRED');
  const w0 = await pkg(wer, 11);
  expired.add(w0.sessionId);
  await assert.rejects(pkg(wer, 11), e => e.code === 'SC19_PAYMENT_SESSION_EXPIRED');
  assert.equal((await db.query('select status from sc19_stripe.package_orders where id=$1', [w0.orderId])).rows[0].status, 'expired');
  // A direct expired update without a closure row is refused.
  const w1 = await pkg(wer, 12);
  await assert.rejects(db.query(`update sc19_stripe.package_orders set status='expired' where id=$1`, [w1.orderId]), /sc19_stripe_package_immutable/);
  paymentId = 'pi_fixtureexp3';
  assert.equal((await deliver({ id: w1.orderId, sessionId: w1.sessionId, amountMinor: 61500 }, 6)).state, 'applied');
  assert.deepEqual((await db.query(`select code, available from sc19_commerce.entitlements where company_id=$1`, [A])).rows,
    [{ code: 'package:WERYFIKACJA', available: 1 }]);
  assert.equal((await db.query('select available from private.sc19_balances where company_id=$1', [A])).rows[0].available, 120);
  assert.equal(await count('select count(*)::int n from sc19_stripe.order_closures'), 3);
  await assert.rejects(db.query('delete from sc19_stripe.order_closures'), /sc19_stripe_package_immutable/);
  await assert.rejects(db.query(`update sc19_stripe.order_closures set reason='session_expired'`), /sc19_stripe_package_immutable/);

  // Rollback refuses once an order has been closed.
  await assert.rejects(db.query(expiredRollback), /rollback_refused/);
  await db.query('rollback').catch(() => {});
  assert.equal((await db.query('select private.erasure_schema_signature() s')).rows[0].s, signature);
});

const overageMigration = readFileSync(new URL('../supabase/migrations/20261121190000_r7_stripe_package_cv_overage.sql', import.meta.url), 'utf8');
const overageRollback = readFileSync(new URL('../supabase/rollbacks/20261121190000_r7_stripe_package_cv_overage_down.sql', import.meta.url), 'utf8');
test('R7: WERYFIKACJA / ASSESSMENT CENTER CV pool above the base — the database pins the engine amount; paid grants the chosen pool; rollback',
  { skip: !url && 'SC19_TEST_DATABASE_URL required' }, async t => {
  const { createSc19Payments } = await import('../lib/sc19-payments.ts');
  const { createPostgresPaymentStore } = await import('../lib/sc19-payment-postgres.ts');
  const { stripePackageExtension, STRIPE_PACKAGE_OFFERS } = await import('../lib/sc19-stripe-packages.ts');
  const { stripePoolQuote } = await import('../lib/stripe-catalog.ts');
  const u = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw Error('Disposable loopback database required');
  const root = new pg.Client({ connectionString: u.href }); await root.connect();
  const name = 'r7overage_' + randomBytes(6).toString('hex');
  await root.query(`create database "${name}"`); u.pathname = '/' + name;
  const db = new pg.Client({ connectionString: u.href }); await db.connect();
  const pool = new pg.Pool({ connectionString: u.href, max: 3 });
  t.after(async () => { await pool.end(); await db.end(); await root.query(`drop database "${name}"`); await root.end(); });
  await db.query(fullFixture);
  await db.query(guardFn); await db.query(guardTrigger);
  await db.query(gateFn);
  await db.query(migration);
  await db.query(packagesMigration);
  await db.query(expiredMigration);
  const A = '00000000-0000-4000-8000-000000000001', OWNER = '00000000-0000-4000-8000-000000000002';
  const rolePool = { async connect() { const c = await pool.connect(); await c.query('set role sc19_p24_checkout'); return c; } };
  const scope = { provider: 'stripe', account: 'ktig-consulting', mode: 'test' };
  let paymentId = 'pi_fixtureover1';
  const provider = {
    async createCheckout(order) {
      const sid = `cs_test_${order.id.replace(/-/g, '')}`;
      return { orderId: order.id, sessionId: sid, url: `https://checkout.stripe.com/c/pay/${sid}`, scope,
        amountMinor: order.amountMinor, currency: 'PLN', paymentKind: 'one_time' };
    },
    async lookupCheckout() { return null; },
    async verifyAndRetrieve(raw) {
      const e = JSON.parse(new TextDecoder().decode(raw));
      return { eventId: 'evt_over' + e.n, orderId: e.id, sessionId: e.sessionId, paymentId, scope,
        amountMinor: e.amountMinor, currency: 'PLN', status: 'paid' };
    },
  };
  const store = createPostgresPaymentStore(rolePool, stripePackageExtension);
  const service = createSc19Payments({ store, provider, scope, checkoutOrigins: ['https://checkout.stripe.com'],
    enabled: true, liveApproved: false, cvPoolEnabled: true, authenticate: async () => ({ userId: OWNER }) });
  const req = n => `00000000-0000-4000-8000-0000000004${String(n).padStart(2, '0')}`;
  const deliver = (o, n) => service.notification(new TextEncoder().encode(JSON.stringify({ ...o, n })), 'sig');
  const wer = STRIPE_PACKAGE_OFFERS.find(o => o.plan === 'WERYFIKACJA');
  const ac = STRIPE_PACKAGE_OFFERS.find(o => o.plan === 'ASSESSMENT_CENTER');
  const pkg = (o, n, cvCount) => service.checkout({ companyId: A, offerId: o.id, termsRevision: o.termsRevision, requestId: req(n),
    packageCode: o.plan, cvCount });
  // One insert through the adapter role inside a transaction that is always rolled back.
  const tryInsert = async (code, amount, credits) => {
    const c = await rolePool.connect();
    try {
      await c.query('begin');
      await c.query(`insert into sc19_stripe.package_orders
        (id,company_id,buyer_id,request_id,package_code,offer_id,offer_revision,terms_revision,amount_minor,currency,credits,provider,account,mode,status,checkout_deadline_ms)
        values (gen_random_uuid(),$1,$2,gen_random_uuid(),$3,'x','x','x',$4,'PLN',$5,'stripe','ktig-consulting','test','awaiting_payment',1)`,
        [A, OWNER, code, amount, credits]);
    } finally { await c.query('rollback'); c.release(); }
  };

  // Pre-migration schema: an above-base order is refused by the old price list; nothing is stored or charged.
  await assert.rejects(pkg(wer, 1, 100), /package_orders_price_list/);
  assert.equal((await db.query('select count(*)::int n from sc19_stripe.package_orders')).rows[0].n, 0);

  // Migration: erasure signature unchanged, not re-runnable; rollback with base orders only restores the old rule.
  const signature = (await db.query('select private.erasure_schema_signature() s')).rows[0].s;
  await db.query(overageMigration);
  assert.equal((await db.query('select private.erasure_schema_signature() s')).rows[0].s, signature, 'erasure signature unchanged');
  await assert.rejects(db.query(overageMigration), /already_installed/);
  await db.query('rollback');
  await db.query(overageRollback);
  await assert.rejects(tryInsert('WERYFIKACJA', 62287, 100), /package_orders_price_list/);
  await db.query(overageMigration);

  // The database accepts exactly the engine amount for every allowed pool, and nothing else.
  for (const [code, base] of [['WERYFIKACJA', 60], ['ASSESSMENT_CENTER', 50]])
    for (let cv = base; cv <= 150; cv += 5) {
      const q = stripePoolQuote(code, cv);
      await tryInsert(code, q.grossMinor, cv);
      await assert.rejects(tryInsert(code, q.grossMinor + 1, cv), /package_orders_price_list/, `${code} ${cv} +1`);
      await assert.rejects(tryInsert(code, q.grossMinor - 1, cv), /package_orders_price_list/, `${code} ${cv} -1`);
    }
  for (const [code, amount, credits] of [
    ['WERYFIKACJA', 62300, 100], ['WERYFIKACJA', 61500, 55], ['WERYFIKACJA', 61500, 62],
    ['WERYFIKACJA', stripePoolQuote('WERYFIKACJA', 150).grossMinor + 98, 155],
    ['ASSESSMENT_CENTER', 149900, 45], ['ASSESSMENT_CENTER', 61500, 60],
  ]) await assert.rejects(tryInsert(code, amount, credits), /package_orders_price_list/, `${code} ${amount} ${credits}`);
  assert.equal((await db.query('select count(*)::int n from sc19_stripe.package_orders')).rows[0].n, 0);

  // The real flow: WERYFIKACJA with 100 CV = 62287 gr, granted 100 CV and the package once.
  const w = await pkg(wer, 3, 100);
  assert.equal(w.amountMinor, 62287);
  assert.deepEqual((await db.query('select amount_minor, credits, package_code from sc19_stripe.package_orders where id=$1', [w.orderId])).rows,
    [{ amount_minor: 62287, credits: 100, package_code: 'WERYFIKACJA' }]);
  assert.equal((await pkg(wer, 3, 100)).orderId, w.orderId);
  assert.equal((await deliver({ id: w.orderId, sessionId: w.sessionId, amountMinor: 62287 }, 1)).state, 'applied');
  assert.equal((await deliver({ id: w.orderId, sessionId: w.sessionId, amountMinor: 62287 }, 1)).state, 'already_applied');
  assert.equal((await db.query('select available from private.sc19_balances where company_id=$1', [A])).rows[0].available, 100);
  assert.deepEqual((await db.query(`select code, available from sc19_commerce.entitlements where company_id=$1`, [A])).rows,
    [{ code: 'package:WERYFIKACJA', available: 1 }]);
  // A paid pool order never changes.
  await assert.rejects(db.query('update sc19_stripe.package_orders set credits=150, amount_minor=$2 where id=$1',
    [w.orderId, stripePoolQuote('WERYFIKACJA', 150).grossMinor]), /sc19_stripe_package_immutable/);
  // ASSESSMENT CENTER with 55 CV.
  paymentId = 'pi_fixtureover2';
  const a = await pkg(ac, 4, 55);
  assert.equal(a.amountMinor, stripePoolQuote('ASSESSMENT_CENTER', 55).grossMinor);
  assert.equal((await deliver({ id: a.orderId, sessionId: a.sessionId, amountMinor: a.amountMinor }, 2)).state, 'applied');
  assert.equal((await db.query('select available from private.sc19_balances where company_id=$1', [A])).rows[0].available, 155);

  // Rollback refuses while any above-base order exists.
  await assert.rejects(db.query(overageRollback), /rollback_refused_pool_orders_exist/);
  await db.query('rollback').catch(() => {});
  assert.equal((await db.query('select private.erasure_schema_signature() s')).rows[0].s, signature);
});

const liveMigration = readFileSync(new URL('../supabase/migrations/20261122090000_r7_stripe_live_invoices.sql', import.meta.url), 'utf8');
const liveRollback = readFileSync(new URL('../supabase/rollbacks/20261122090000_r7_stripe_live_invoices_down.sql', import.meta.url), 'utf8');
test('R7 live: LIVE PRESELEKCJA orders through the adapter role (packages stay TEST), one invoice row per payment, refunds only grow, accounting rows immutable; rollback',
  { skip: !url && 'SC19_TEST_DATABASE_URL required' }, async t => {
  const { createSc19Payments } = await import('../lib/sc19-payments.ts');
  const { createPostgresPaymentStore, orderRow } = await import('../lib/sc19-payment-postgres.ts');
  const { stripeLivePackageExtension, STRIPE_PACKAGE_OFFERS } = await import('../lib/sc19-stripe-packages.ts');
  const { issueOrderInvoice, handleRefund, postgresInvoiceStore } = await import('../lib/sc19-stripe-invoices.ts');
  const { createFakturowniaClient } = await import('../lib/fakturownia-client.ts');
  const u = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw Error('Disposable loopback database required');
  const root = new pg.Client({ connectionString: u.href }); await root.connect();
  const name = 'r7live_' + randomBytes(6).toString('hex');
  await root.query(`create database "${name}"`); u.pathname = '/' + name;
  const db = new pg.Client({ connectionString: u.href }); await db.connect();
  const pool = new pg.Pool({ connectionString: u.href, max: 4 });
  t.after(async () => { await pool.end(); await db.end(); await root.query(`drop database "${name}"`); await root.end(); });
  await db.query(fullFixture);
  await db.query(guardFn); await db.query(guardTrigger);
  await db.query(gateFn);
  for (const m of [migration, packagesMigration, expiredMigration, overageMigration]) await db.query(m);
  const A = '00000000-0000-4000-8000-000000000001', OWNER = '00000000-0000-4000-8000-000000000002';
  const rolePool = { async connect() { const c = await pool.connect(); await c.query('set role sc19_p24_checkout'); return c; } };
  const roleQuery = async (sql, values) => { const c = await rolePool.connect(); try { return (await c.query(sql, values)).rows; } finally { await c.query('reset role'); c.release(); } };
  const live = { provider: 'stripe', account: 'ktig-consulting', mode: 'live' };
  const provider = {
    async createCheckout(order) {
      const sid = `cs_live_${order.id.replace(/-/g, '')}`;
      return { orderId: order.id, sessionId: sid, url: `https://checkout.stripe.com/c/pay/${sid}`, scope: live,
        amountMinor: order.amountMinor, currency: 'PLN', paymentKind: 'one_time' };
    },
    async lookupCheckout() { return null; },
    async verifyAndRetrieve(raw) {
      const e = JSON.parse(new TextDecoder().decode(raw));
      return { eventId: 'evt_live' + e.n, orderId: e.id, sessionId: e.sessionId, paymentId: 'pi_fakelive1', scope: live,
        amountMinor: e.amountMinor, currency: 'PLN', status: 'paid' };
    },
  };
  const make = () => createSc19Payments({ store: createPostgresPaymentStore(rolePool, stripeLivePackageExtension), provider, scope: live,
    checkoutOrigins: ['https://checkout.stripe.com'], enabled: true, liveApproved: true, authenticate: async () => ({ userId: OWNER }) });
  const req = n => `00000000-0000-4000-8000-0000000005${String(n).padStart(2, '0')}`;

  // Pre-migration schema: a LIVE order is refused by the TEST-only policy, nothing is stored.
  await assert.rejects(make().checkout({ companyId: A, offerId: 'preselekcja-60-2026-11-r3', termsRevision: 'preselekcja-terms-2026-11-v3',
    requestId: req(1), packageCode: 'PRESELEKCJA' }));
  assert.equal((await db.query("select count(*)::int n from private.sc19_payment_orders where mode='live'")).rows[0].n, 0);

  const signature = (await db.query('select private.erasure_schema_signature() s')).rows[0].s;
  await db.query(liveMigration);
  assert.equal((await db.query('select private.erasure_schema_signature() s')).rows[0].s, signature, 'erasure signature unchanged');
  await assert.rejects(db.query(liveMigration), /already_installed/);
  await db.query('rollback');

  // LIVE PRESELEKCJA: created, granted once. LIVE packages: not offered, and the database refuses them anyway.
  const service = make();
  const hosted = await service.checkout({ companyId: A, offerId: 'preselekcja-60-2026-11-r3', termsRevision: 'preselekcja-terms-2026-11-v3',
    requestId: req(2), packageCode: 'PRESELEKCJA' });
  const deliver = n => service.notification(new TextEncoder().encode(JSON.stringify({ id: hosted.orderId, sessionId: hosted.sessionId, amountMinor: 30000, n })), 'sig');
  assert.equal((await deliver(1)).state, 'applied');
  assert.equal((await deliver(2)).state, 'already_applied');
  assert.equal((await db.query('select available from private.sc19_balances where company_id=$1', [A])).rows[0].available, 60);
  const ac = STRIPE_PACKAGE_OFFERS.find(o => o.plan === 'ASSESSMENT_CENTER');
  await assert.rejects(service.checkout({ companyId: A, offerId: ac.id, termsRevision: ac.termsRevision, requestId: req(3),
    packageCode: 'ASSESSMENT_CENTER' }), e => e.code === 'SC19_PAYMENT_OFFER_UNAVAILABLE');
  await assert.rejects(roleQuery(`insert into sc19_stripe.package_orders(id,company_id,buyer_id,request_id,package_code,offer_id,offer_revision,
    terms_revision,amount_minor,currency,credits,provider,account,mode,status,checkout_deadline_ms) values (gen_random_uuid(),$1,$2,gen_random_uuid(),
    'ASSESSMENT_CENTER',$3,'r','t',149900,'PLN',50,'stripe','ktig-consulting','live','awaiting_payment',1)`, [A, OWNER, ac.id]), /row-level security/);
  // LIVE customers and the compare-and-set replacement.
  await roleQuery(`insert into sc19_stripe.customers(company_id,mode,customer_id) values ($1,'live','cus_fakelive1')`, [A]);
  assert.equal((await roleQuery(`select sc19_stripe.replace_customer($1,'live','cus_fakelive1','cus_fakelive2') c`, [A]))[0].c, 'cus_fakelive2');
  await assert.rejects(roleQuery(`select sc19_stripe.replace_customer($1,'prod','cus_fakelive2','cus_fakelive3')`, [A]), /stripe_customer_invalid/);

  // Invoice buyer: name and NIP only for a PAID LIVE order; never for anon/authenticated.
  assert.deepEqual(await roleQuery('select * from sc19_stripe.invoice_buyer($1)', [hosted.orderId]), [{ company_name: 'Firma A', nip: '7394002294' }]);
  assert.deepEqual(await roleQuery('select * from sc19_stripe.invoice_buyer($1)', [req(99)]), []);
  for (const role of ['anon', 'authenticated'])
    assert.equal((await db.query(`select has_function_privilege($1,'sc19_stripe.invoice_buyer(uuid)','execute') r`, [role])).rows[0].r, false);

  // The real invoice store on the adapter role. The fixture company has the seller's NIP: a control purchase.
  const order = orderRow((await db.query('select * from private.sc19_payment_orders where id=$1', [hosted.orderId])).rows[0]);
  const store = postgresInvoiceStore(roleQuery, orderRow);
  // A paid order is not awaiting settlement; an unknown id neither (Codex P2, PR #591).
  assert.equal(await store.awaitingSettlement(hosted.orderId), false);
  assert.equal(await store.awaitingSettlement(req(98)), false);
  const posts = [];
  const fakturownia = createFakturowniaClient({ account: 'ktig', token: 'synthetic-token-123' }, async (_u, init) => {
    const { invoice } = JSON.parse(init.body); posts.push(invoice);
    return { ok: true, status: 201, json: async () => ({ id: 500 + posts.length, kind: invoice.kind, status: 'paid', number: `FV ${posts.length}`,
      oid: invoice.oid, price_gross: invoice.positions[0].total_price_gross, paid: invoice.paid, currency: 'PLN' }) };
  });
  const facts = async () => ({ paymentIntentId: 'pi_fakelive1', amountMinor: 30000, paidAtMs: Date.now(), method: 'p24',
    email: 'a@example.test', address: { street: 'ul. A 1', postCode: '00-001', city: 'Warszawa' } });
  const deps = { fakturownia, store, paymentFacts: facts };
  assert.equal(await issueOrderInvoice(order, deps), 'skipped');
  assert.equal(await issueOrderInvoice(order, deps), 'skipped');
  assert.equal(await handleRefund({ paymentIntentId: 'pi_fakelive1', orderId: order.id, refundedTotal: 10000 }, deps), 'skipped');
  assert.equal(posts.length, 0, 'no document for the seller itself');
  assert.deepEqual((await db.query('select status, error_code from sc19_stripe.invoices')).rows, [{ status: 'skipped', error_code: 'SELLER_CONTROL_PURCHASE' }]);
  // A buyer with another NIP: one invoice, then one correction per cumulative total.
  await db.query(`update private.sc19_trial_approvals set nip='5260250274' where company_id=$1`, [A]);
  await db.query('alter table sc19_stripe.invoices disable trigger invoice_guard');
  await db.query('delete from sc19_stripe.invoices'); // test-only reset of the skipped row
  await db.query('alter table sc19_stripe.invoices enable trigger invoice_guard');
  // Two concurrent attempts: one claim, the other busy.
  const [c1, c2] = await Promise.all([store.claim(order, Date.now(), 60_000), store.claim(order, Date.now(), 60_000)]);
  assert.deepEqual([c1, c2].sort(), [1, 'busy']);
  await store.failed(order.id, 'FAKTUROWNIA_UNAVAILABLE', Date.now());
  assert.equal(await issueOrderInvoice(order, deps), 'issued');
  assert.equal(await issueOrderInvoice(order, deps), 'already_issued');
  assert.equal(posts.length, 1); assert.equal(posts[0].payment_type, 'Przelewy24'); assert.equal(posts[0].buyer_tax_no, '5260250274');
  const row = (await db.query('select status, attempts, fakturownia_id, payment_method from sc19_stripe.invoices')).rows[0];
  assert.deepEqual(row, { status: 'issued', attempts: 2, fakturownia_id: '501', payment_method: 'p24' });
  assert.equal(await handleRefund({ paymentIntentId: 'pi_fakelive1', orderId: order.id, refundedTotal: 20000 }, deps), 'issued');
  assert.equal(await handleRefund({ paymentIntentId: 'pi_fakelive1', orderId: order.id, refundedTotal: 20000 }, deps), 'already_issued');
  assert.equal(await handleRefund({ paymentIntentId: 'pi_fakelive1', orderId: order.id, refundedTotal: 30000 }, deps), 'issued');
  assert.deepEqual(posts.map(p => [p.kind, p.positions[0].total_price_gross]), [['vat', '300.00'], ['correction', '-200.00'], ['correction', '-100.00']]);
  assert.equal((await db.query('select refunded_total from sc19_stripe.refunds')).rows[0].refunded_total, 30000);
  // Refunds only grow; issued documents never change and nothing is deleted; the role gets no delete.
  await store.recordRefund(order, 5000, Date.now());
  assert.equal((await db.query('select refunded_total from sc19_stripe.refunds')).rows[0].refunded_total, 30000);
  await assert.rejects(db.query('update sc19_stripe.refunds set refunded_total=1'), /stripe_invoice_immutable/);
  await assert.rejects(db.query(`update sc19_stripe.invoices set number='X'`), /stripe_invoice_immutable/);
  await assert.rejects(db.query(`update sc19_stripe.invoice_corrections set number='X'`), /stripe_invoice_immutable/);
  await assert.rejects(db.query('delete from sc19_stripe.invoice_corrections'), /stripe_invoice_immutable/);
  await assert.rejects(roleQuery('delete from sc19_stripe.invoices'), /permission denied/);
  await assert.rejects(db.query(`insert into sc19_stripe.invoices(order_id,company_id,payment_id,mode) values (gen_random_uuid(),$1,'pi_faketest1','test')`, [A]), /check constraint/);
  for (const role of ['anon', 'authenticated'])
    assert.equal((await db.query(`select has_table_privilege($1,'sc19_stripe.invoices','select') r`, [role])).rows[0].r, false);
  // No CV analysis was taken back by the refund (the operator corrects a pool by hand).
  assert.equal((await db.query('select available from private.sc19_balances where company_id=$1', [A])).rows[0].available, 60);

  // Rollback: refused while accounting records exist.
  await assert.rejects(db.query(liveRollback), /rollback_refused/);
  await db.query('rollback');
});

test('R7 live: rollback on a database without live records restores the TEST-only behaviour',
  { skip: !url && 'SC19_TEST_DATABASE_URL required' }, async t => {
  const u = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw Error('Disposable loopback database required');
  const root = new pg.Client({ connectionString: u.href }); await root.connect();
  const name = 'r7liverb_' + randomBytes(6).toString('hex');
  await root.query(`create database "${name}"`); u.pathname = '/' + name;
  const db = new pg.Client({ connectionString: u.href }); await db.connect();
  t.after(async () => { await db.end(); await root.query(`drop database "${name}"`); await root.end(); });
  await db.query(fullFixture);
  await db.query(guardFn); await db.query(guardTrigger);
  await db.query(gateFn);
  for (const m of [migration, packagesMigration, expiredMigration, overageMigration, liveMigration]) await db.query(m);
  await db.query(liveRollback);
  assert.equal((await db.query("select to_regclass('sc19_stripe.invoices') r")).rows[0].r, null);
  const A = '00000000-0000-4000-8000-000000000001';
  await db.query('begin'); await db.query('set local role sc19_p24_checkout');
  await assert.rejects(db.query(`insert into sc19_stripe.customers(company_id,mode,customer_id) values ($1,'live','cus_fakelive9')`, [A]), /row-level security/);
  await db.query('rollback');
  await assert.rejects(db.query(`select sc19_stripe.replace_customer($1,'live','cus_a','cus_fakelive9')`, [A]), /stripe_customer_invalid/);
  // Applying it again works (the rollback left nothing behind).
  await db.query(liveMigration);
});

const windowMigration = readFileSync(new URL('../supabase/migrations/20261122110000_r7_invoice_attempt_window.sql', import.meta.url), 'utf8');
const windowRollback = readFileSync(new URL('../supabase/rollbacks/20261122110000_r7_invoice_attempt_window_down.sql', import.meta.url), 'utf8');
test('R7 live (Codex P2 on #594): attempt times are recorded through the adapter role only when the columns exist; rollback',
  { skip: !url && 'SC19_TEST_DATABASE_URL required' }, async t => {
  const { postgresInvoiceStore } = await import('../lib/sc19-stripe-invoices.ts');
  const { orderRow } = await import('../lib/sc19-payment-postgres.ts');
  const u = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw Error('Disposable loopback database required');
  const root = new pg.Client({ connectionString: u.href }); await root.connect();
  const name = 'r7window_' + randomBytes(6).toString('hex');
  await root.query(`create database "${name}"`); u.pathname = '/' + name;
  const db = new pg.Client({ connectionString: u.href }); await db.connect();
  const pool = new pg.Pool({ connectionString: u.href, max: 3 });
  t.after(async () => { await pool.end(); await db.end(); await root.query(`drop database "${name}"`); await root.end(); });
  await db.query(fullFixture);
  await db.query(guardFn); await db.query(guardTrigger);
  await db.query(gateFn);
  for (const m of [migration, packagesMigration, expiredMigration, overageMigration, liveMigration]) await db.query(m);
  const A = '00000000-0000-4000-8000-000000000001';
  const roleQuery = async (sql, values) => { const c = await pool.connect(); try { await c.query('set role sc19_p24_checkout'); return (await c.query(sql, values)).rows; } finally { await c.query('reset role'); c.release(); } };
  const order = (n) => ({ id: `00000000-0000-4000-8000-0000000006${String(n).padStart(2, '0')}`, companyId: A, paymentId: `pi_fakewin${n}x` });
  // Before the migration: claims work, no window is known.
  const before = postgresInvoiceStore(roleQuery, orderRow);
  assert.equal(await before.claim(order(1), Date.UTC(2026, 10, 20), 60_000), 1);
  assert.deepEqual(await before.invoiceWindow(order(1).id), { firstAttemptMs: null, lastAttemptMs: null });
  const signature = (await db.query('select private.erasure_schema_signature() s')).rows[0].s;
  await db.query(windowMigration);
  assert.equal((await db.query('select private.erasure_schema_signature() s')).rows[0].s, signature);
  await assert.rejects(db.query(windowMigration), /already_installed/);
  await db.query('rollback');
  const store = postgresInvoiceStore(roleQuery, orderRow);
  const t1 = Date.UTC(2026, 10, 20, 10), t2 = Date.UTC(2026, 10, 21, 10);
  assert.equal(await store.claim(order(2), t1, 60_000), 1);
  await store.failed(order(2).id, 'FAKTUROWNIA_UNAVAILABLE', t1);
  assert.equal(await store.claim(order(2), t2, 60_000), 2);
  assert.deepEqual(await store.invoiceWindow(order(2).id), { firstAttemptMs: t1, lastAttemptMs: t2 });
  // Codex P2 on #595: a row attempted before the columns existed keeps first_attempt_at null.
  await store.failed(order(1).id, 'FAKTUROWNIA_UNAVAILABLE', t1);
  assert.equal(await store.claim(order(1), t2, 60_000), 2);
  assert.deepEqual(await store.invoiceWindow(order(1).id), { firstAttemptMs: null, lastAttemptMs: t2 });
  // Corrections (row references the invoice row).
  assert.equal(await store.startCorrection(order(2).id, 10000, t1), 1);
  await store.correctionFailed(order(2).id, 10000, 'FAKTUROWNIA_TIMEOUT', t1);
  assert.equal(await store.startCorrection(order(2).id, 10000, t2), 2);
  assert.deepEqual(await store.corrections(order(2).id), [{ refundedTotal: 10000, status: 'pending', firstAttemptMs: t1, lastAttemptMs: t2 }]);
  // Rollback refused while attempt times are recorded; on a clean database it removes the columns.
  await assert.rejects(db.query(windowRollback), /rollback_refused/);
  await db.query('rollback');
  await db.query('update sc19_stripe.invoice_corrections set first_attempt_at=null, last_attempt_at=null');
  await db.query('update sc19_stripe.invoices set first_attempt_at=null, last_attempt_at=null');
  await db.query(windowRollback);
  assert.equal((await db.query(`select count(*)::int n from information_schema.columns where table_schema='sc19_stripe' and column_name='first_attempt_at'`)).rows[0].n, 0);
});
