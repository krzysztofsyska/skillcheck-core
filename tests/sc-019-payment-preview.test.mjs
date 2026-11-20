import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import { previewPoolTls } from '../lib/sc19-payment-preview-tls.ts';
import { PGlite } from '@electric-sql/pglite';
import { publicShape, restrictedDatabaseUrl } from '../lib/sc19-payment-preview.ts';
import { createPostgresPaymentStore } from '../lib/sc19-payment-postgres.ts';

const ref = 'orbyscrupgnupifzlqxp';
const productionRef = 'wsvjawuikxfzjyivxgsu';
test('the preview payment pool verifies TLS using the two official hosted database roots', () => {
  assert.equal(previewPoolTls.rejectUnauthorized, true);
  assert.doesNotThrow(() => createSecureContext(previewPoolTls));
  const certs = previewPoolTls.ca.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  assert.deepEqual(certs.map(pem => new X509Certificate(pem).fingerprint256), [
    '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA',
    '5F:9B:77:95:1A:7A:A1:30:3F:9B:58:EE:A9:BF:A8:9E:35:8C:FD:C1:5F:97:86:FF:10:D4:93:0A:72:2C:9A:E2',
  ]);
});
// R7: the Przelewy24 sandbox gate was removed. What stays in
// lib/sc19-payment-preview.ts is the restricted-login check and the shape hint the
// Stripe gate (lib/sc19-stripe-config.ts) uses; both must stay as strict as before.
const previewUrl = `postgresql://sc19_p24_preview.${ref}:fake@aws-1-eu-west-1.pooler.supabase.com:6543/postgres`;
test('the restricted payment login accepts only <role>.<ref> on the transaction pooler and names wrong parts, never values', () => {
  assert.deepEqual(restrictedDatabaseUrl(previewUrl, 'sc19_p24_preview', ref), { url: previewUrl, shape: 'ok' });
  assert.deepEqual(restrictedDatabaseUrl(undefined, 'sc19_p24_preview', ref), { url: null, shape: 'missing' });
  assert.deepEqual(restrictedDatabaseUrl('', 'sc19_p24_preview', ref), { url: null, shape: 'empty' });
  assert.deepEqual(restrictedDatabaseUrl('not a url secret', 'sc19_p24_preview', ref), { url: null, shape: 'not_a_url,length:16' });
  for (const [value, wrong] of [
    [previewUrl.replace('sc19_p24_preview', 'postgres'), 'username'],
    [previewUrl.replace(ref, productionRef), 'username'],
    [previewUrl + '?sslmode=disable', 'query'],
    [previewUrl.replace(':fake@', '@'), 'password'],
    [previewUrl.replace('aws-1-eu-west-1.pooler.supabase.com', 'untrusted.invalid'), 'host'],
    [previewUrl.replace(':6543', ':5432'), 'port'],
    [previewUrl.replace('/postgres', '/other'), 'path'],
    [previewUrl.replace('postgresql:', 'postgres:'), 'protocol'],
  ]) {
    const result = restrictedDatabaseUrl(value, 'sc19_p24_preview', ref);
    assert.equal(result.url, null, value);
    assert.match(result.shape, new RegExp(`^wrong:.*${wrong}`), value);
    assert.doesNotMatch(result.shape, /fake|untrusted|sslmode/);
  }
  // The production login is a different role on a different project.
  assert.equal(restrictedDatabaseUrl(previewUrl, 'sc19_p24_checkout', productionRef).url, null);
});
test('the shape hint echoes short public values only, never anything long enough to be a key', () => {
  assert.equal(publicShape(undefined), 'missing');
  assert.equal(publicShape(''), 'empty');
  assert.equal(publicShape('preview'), 'value:preview');
  assert.equal(publicShape('x'.repeat(65)), 'length:65');
  assert.equal(publicShape('true', 2), 'length:4');
  assert.equal(publicShape('zażółć'), 'length:6');
});

const sql = path => readFile(new URL(path,import.meta.url),'utf8');
test('dedicated preview role runs the actual order store and cannot edit companies, prices or LIVE orders', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon; create role authenticated; create schema private; create schema auth;
    create function auth.uid() returns uuid language sql as $$select null::uuid$$;
    create table public.companies(id uuid primary key, owner_id uuid not null);
    alter table public.companies enable row level security;
    create table public.screening_analysis_versions(id uuid primary key,company_id uuid references public.companies,execution_status text,stale_at timestamptz);
    create function private.touch_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now(); return new; end$$;
    create function private.is_company_owner(uuid) returns boolean language sql as $$select false$$;
    create function private.has_company_access(uuid,boolean) returns boolean language sql as $$select false$$;
  `);
  await db.exec(await sql('../docs/prototypes/sc-019-mvp-credits.sql'));
  await db.exec(await sql('../docs/prototypes/sc19-payment-storage.sql'));
  const setup = await sql('../supabase/preview-setup/sc19-p24-runtime.sql');
  const expand = value => setup.replace(":'sc19_seed_target_ref'", "'" + value + "'");
  await assert.rejects(db.exec(expand('wsvjawuikxfzjyivxgsu')), /Sandbox database required/);
  await db.exec('rollback');
  await assert.rejects(db.exec(expand(ref)), /Unexpected database cluster/);
  await db.exec('rollback');
  assert.equal((await db.query("select 1 from pg_roles where rolname='sc19_p24_preview'")).rows.length,0);
  const cluster = (await db.query('select system_identifier::text as id from pg_control_system()')).rows[0].id;
  await db.exec(expand(ref).replace('7692130048193495360',cluster));
  const company='00000000-0000-4000-8000-000000000001', user='00000000-0000-4000-8000-000000000002';
  const orderId='00000000-0000-4000-8000-000000000003';
  await db.query('insert into public.companies values ($1,$2)',[company,user]);
  await db.query("insert into private.sc19_trial_approvals(company_id,nip,proof_reference) values ($1,'1234563218','sandbox-fixture')",[company]);
  await db.exec(`insert into private.sc19_payment_offers(id,revision,plan,active,approved,amount_minor,currency,credits,
    terms_revision,terms_text,valid_until_ms) values('sandbox','v1','PRESELEKCJA',true,true,30000,'PLN',60,'v1','Sandbox',4102444800000)`);
  await db.exec('set role sc19_p24_preview');
  const pool = { async connect() { return { release() {}, async query(q,params) {
    const r = await db.query(q,params); return {rows:r.rows,rowCount:r.affectedRows};
  } }; } };
  const store=createPostgresPaymentStore(pool);
  const [offer]=await store.listOffers(company,user);
  assert.equal(offer.credits,60);
  assert.equal(await store.readOrder(company,user,orderId),null);
  await assert.rejects(store.listOffers(company,orderId), /FORBIDDEN/);
  const order = { id:orderId, companyId:company, buyerId:user, requestId:orderId, offerId:offer.id,
    offerRevision:offer.revision, termsRevision:offer.termsRevision, amountMinor:offer.amountMinor, currency:'PLN',
    credits:offer.credits, scope:{provider:'przelewy24',mode:'test',account:'12345'},status:'awaiting_payment',
    sessionId:null, checkoutUrl:null,paymentId:null,checkoutDeadlineMs:Date.now()+600000 };
  await assert.rejects(store.transaction(tx=>tx.insertOrder({...order,scope:{...order.scope,mode:'live'}})),/row-level security/);
  await store.transaction(async tx=>{
    await tx.insertOrder(order); await tx.bindRequest(company,orderId,orderId);
    assert.equal((await tx.orderByRequest(company,orderId)).id,orderId);
    assert.equal((await tx.offer(offer.id)).id,offer.id);
    assert.equal((await tx.unresolvedOrder(company)).id,orderId);
    assert.equal((await tx.order(orderId)).id,orderId);
    assert.equal(await tx.grantOnce('synthetic-receipt',order),null);
    assert.equal(await tx.grantOnce('synthetic-receipt',order),orderId);
    await tx.saveOrder({...order,status:'paid',paymentId:'p24-fixture',sessionId:'session',checkoutUrl:'https://sandbox.przelewy24.pl/trnRequest/fixture'});
  });
  assert.equal((await store.readOrder(company,user,orderId)).status,'paid');
  assert.equal((await db.query('select available from private.sc19_balances')).rows[0].available,60);
  for (const query of ['update public.companies set id=id','update private.sc19_payment_offers set active=false',
    'update private.sc19_trial_approvals set company_id=company_id','select nip from private.sc19_trial_approvals']) {
    await assert.rejects(db.exec(query),/permission denied|row-level security/);
  }
});

test('the production checkout role, as the migration grants it, runs the order store and can do nothing else', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon; create role authenticated; create schema private; create schema auth;
    create function auth.uid() returns uuid language sql as $$select null::uuid$$;
    create table public.companies(id uuid primary key, owner_id uuid not null);
    alter table public.companies enable row level security;
    create table public.screening_analysis_versions(id uuid primary key,company_id uuid references public.companies,execution_status text,stale_at timestamptz);
    create function private.touch_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now(); return new; end$$;
    create function private.is_company_owner(uuid) returns boolean language sql as $$select false$$;
    create function private.has_company_access(uuid,boolean) returns boolean language sql as $$select false$$;
  `);
  await db.exec(await sql('../docs/prototypes/sc-019-mvp-credits.sql'));
  await db.exec(await sql('../docs/prototypes/sc19-payment-storage.sql'));
  const migration = await sql('../supabase/migrations/20261111140000_sc19_p24_checkout_role.sql');
  // No password, and nothing that could set one, may ever be in this file. The
  // comments explain the owner's own step, so only the executable text is checked.
  const statements = migration.replace(/^\s*--.*$/gm,'');
  assert.doesNotMatch(statements,/password|valid until|alter\s+role/i);
  assert.match(statements,/create role sc19_p24_checkout nologin /);
  await db.exec(migration);
  // Applying it twice is the Preview-resync case and must be a no-op.
  await db.exec(migration);
  const role = (await db.query(`select rolcanlogin,rolinherit,rolbypassrls,rolsuper,rolcreaterole,rolcreatedb,rolreplication
    from pg_roles where rolname='sc19_p24_checkout'`)).rows;
  assert.deepEqual(role,[{rolcanlogin:false,rolinherit:false,rolbypassrls:false,rolsuper:false,
    rolcreaterole:false,rolcreatedb:false,rolreplication:false}],'created without LOGIN and without any wider attribute');
  // The privileges are the preview role's, column for column: the two sandbox
  // deployments run the same adapter under the same restrictions, and this
  // equivalence is what makes "mirror the preview role, no wider" checkable rather
  // than a claim in a comment. The preview provisioning file is installed here
  // only as that reference (its cluster guard is satisfied with this database's
  // own identifier, exactly as in the test above).
  const setup = await sql('../supabase/preview-setup/sc19-p24-runtime.sql');
  const cluster = (await db.query('select system_identifier::text as id from pg_control_system()')).rows[0].id;
  await db.exec(setup.replace(":'sc19_seed_target_ref'","'"+ref+"'").replace('7692130048193495360',cluster));
  const privileges = async who => (await db.query(`select c.relname,a.attname,p.privilege_type,
      has_column_privilege($1,c.oid,a.attnum,p.privilege_type) allowed
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
    cross join unnest(array['SELECT','INSERT','UPDATE','REFERENCES']) p(privilege_type)
    where n.nspname in ('public','private') and c.relkind='r'
    order by c.relname,a.attname,p.privilege_type`,[who])).rows;
  assert.deepEqual(await privileges('sc19_p24_checkout'),await privileges('sc19_p24_preview'),
    'the production role holds exactly the preview role’s column privileges');
  for (const table of ['sc19_payment_orders','sc19_payment_requests','sc19_payment_grants',
    'sc19_credit_journal','sc19_balances']) {
    for (const privilege of ['DELETE','TRUNCATE']) {
      assert.equal((await db.query('select has_table_privilege($1,$2,$3) allowed',
        ['sc19_p24_checkout','private.'+table,privilege])).rows[0].allowed,false,`no ${privilege} on ${table}`);
    }
  }
  const company='00000000-0000-4000-8000-000000000001', user='00000000-0000-4000-8000-000000000002';
  const orderId='00000000-0000-4000-8000-000000000003';
  await db.query('insert into public.companies values ($1,$2)',[company,user]);
  await db.query("insert into private.sc19_trial_approvals(company_id,nip,proof_reference) values ($1,'1234563218','sandbox-fixture')",[company]);
  await db.exec(`insert into private.sc19_payment_offers(id,revision,plan,active,approved,amount_minor,currency,credits,
    terms_revision,terms_text,valid_until_ms) values('sandbox','v1','PRESELEKCJA',true,true,30000,'PLN',60,'v1','Sandbox',4102444800000)`);
  await db.exec('set role sc19_p24_checkout');
  const pool = { async connect() { return { release() {}, async query(q,params) {
    const r = await db.query(q,params); return {rows:r.rows,rowCount:r.affectedRows};
  } }; } };
  const store=createPostgresPaymentStore(pool);
  const [offer]=await store.listOffers(company,user);
  assert.equal(offer.credits,60);
  const order = { id:orderId, companyId:company, buyerId:user, requestId:orderId, offerId:offer.id,
    offerRevision:offer.revision, termsRevision:offer.termsRevision, amountMinor:offer.amountMinor, currency:'PLN',
    credits:offer.credits, scope:{provider:'przelewy24',mode:'test',account:'12345'},status:'awaiting_payment',
    sessionId:null, checkoutUrl:null,paymentId:null,checkoutDeadlineMs:Date.now()+600000 };
  // A LIVE order is impossible at the database, not only in the application.
  await assert.rejects(store.transaction(tx=>tx.insertOrder({...order,scope:{...order.scope,mode:'live'}})),/row-level security/);
  await assert.rejects(store.transaction(tx=>tx.insertOrder({...order,scope:{...order.scope,provider:'other'}})),/row-level security/);
  await store.transaction(async tx=>{
    await tx.insertOrder(order); await tx.bindRequest(company,orderId,orderId);
    assert.equal((await tx.orderByRequest(company,orderId)).id,orderId);
    assert.equal((await tx.offer(offer.id)).id,offer.id);
    assert.equal((await tx.unresolvedOrder(company)).id,orderId);
    assert.equal(await tx.grantOnce('synthetic-receipt',order),null);
    assert.equal(await tx.grantOnce('synthetic-receipt',order),orderId);
    await tx.saveOrder({...order,status:'paid',paymentId:'p24-fixture',sessionId:'session',checkoutUrl:'https://sandbox.przelewy24.pl/trnRequest/fixture'});
  });
  assert.equal((await store.readOrder(company,user,orderId)).status,'paid');
  assert.equal((await db.query('select available from private.sc19_balances')).rows[0].available,60);
  for (const query of ['update public.companies set id=id','update public.companies set owner_id=id',
    'update private.sc19_payment_offers set active=false','update private.sc19_payment_offers set amount_minor=1',
    'update private.sc19_trial_approvals set company_id=company_id','select nip from private.sc19_trial_approvals',
    'delete from private.sc19_payment_grants','update private.sc19_payment_grants set order_id=order_id',
    'select * from private.sc19_credit_journal','update private.sc19_payment_orders set amount_minor=1',
    "insert into private.sc19_credit_journal(company_id,reason,delta,reference) values ('"+company+"','paid_grant',1,'bogus')"]) {
    await assert.rejects(db.exec(query),/permission denied|row-level security/,query);
  }
});
