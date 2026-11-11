import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import { previewPoolTls } from '../lib/sc19-payment-preview-tls.ts';
import { PGlite } from '@electric-sql/pglite';
import { sc19PreviewPaymentConfig, sc19ProductionSandboxPaymentConfig, sc19SandboxPaymentConfig }
  from '../lib/sc19-payment-preview.ts';
import { PRZELEWY24_ORIGIN } from '../lib/sc19-przelewy24-provider.ts';
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
const env = { VERCEL:'1', VERCEL_ENV:'preview', VERCEL_GIT_COMMIT_REF:'integration',
  VERCEL_BRANCH_URL:'skillcheck-branch.vercel.app', VERCEL_URL:'skillcheck-hash.vercel.app',
  NEXT_PUBLIC_SUPABASE_URL:`https://${ref}.supabase.co`, P24_SANDBOX:'true', P24_MERCHANT_ID:'12345',
  P24_POS_ID:'12346', P24_CRC:'synthetic-crc', P24_API_KEY:'synthetic-test-api-key',
  SC19_P24_PREVIEW_DATABASE_URL:`postgresql://sc19_p24_preview.${ref}:fake@aws-1-eu-west-1.pooler.supabase.com:6543/postgres` };
test('only the integration preview, its Supabase project, dedicated login and trusted Vercel hosts can open checkout', () => {
  assert.equal(sc19PreviewPaymentConfig(env).appOrigin, 'https://' + env.VERCEL_BRANCH_URL);
  assert.equal(sc19PreviewPaymentConfig(env, 'https://' + env.VERCEL_URL).posId, 12346);
  for (const overrides of [{ VERCEL_ENV:'production' }, { VERCEL:'0' }, { VERCEL_GIT_COMMIT_REF:'main' },
    { P24_SANDBOX:'false' }, { P24_API_KEY:'' }, { P24_MERCHANT_ID:'1e4' }, { P24_POS_ID:'0' },
    { NEXT_PUBLIC_SUPABASE_URL:'https://wsvjawuikxfzjyivxgsu.supabase.co' },
    ...['postgres','production','?sslmode=disable','@untrusted.invalid'].map((v,i) => ({
      SC19_P24_PREVIEW_DATABASE_URL: i===0 ? env.SC19_P24_PREVIEW_DATABASE_URL.replace('sc19_p24_preview',v) :
        i===1 ? env.SC19_P24_PREVIEW_DATABASE_URL.replace(ref,v) : env.SC19_P24_PREVIEW_DATABASE_URL + v }))]) {
    assert.equal(sc19PreviewPaymentConfig({...env,...overrides}), null);
  }
  assert.equal(sc19PreviewPaymentConfig(env,'https://other.vercel.app'),null);
  // The shared entry point must leave the preview case exactly as it was, including
  // which of the deployment's own hosts it picks when no request origin is given.
  assert.deepEqual(sc19SandboxPaymentConfig(env),sc19PreviewPaymentConfig(env));
  assert.deepEqual(sc19SandboxPaymentConfig(env,'https://'+env.VERCEL_URL),
    sc19PreviewPaymentConfig(env,'https://'+env.VERCEL_URL));
  assert.equal(sc19SandboxPaymentConfig(env,'https://other.vercel.app'),null);
  // A preview deployment can never reach the production branch of the gate, whatever
  // else its variables say.
  assert.equal(sc19ProductionSandboxPaymentConfig({...env,
    NEXT_PUBLIC_SUPABASE_URL:`https://${productionRef}.supabase.co`,
    NEXT_PUBLIC_SITE_URL:'https://skillcheck.pl',
    SC19_P24_CHECKOUT_DATABASE_URL:
      `postgresql://sc19_p24_checkout.${productionRef}:fake@aws-1-eu-west-1.pooler.supabase.com:6543/postgres`}),null);
});

// SC-P24-SANDBOX-PROD (owner decision, by voice, 2026-11-11): the same SANDBOX
// checkout is served from https://skillcheck.pl so a Przelewy24 verifier can pay
// with test money. Everything stays pinned, and LIVE stays unreachable.
const productionEnv = { VERCEL:'1', VERCEL_ENV:'production', VERCEL_GIT_COMMIT_REF:'main',
  VERCEL_BRANCH_URL:'skillcheck-core-main.vercel.app', VERCEL_URL:'skillcheck-core-hash.vercel.app',
  VERCEL_PROJECT_PRODUCTION_URL:'skillcheck-core.vercel.app',
  NEXT_PUBLIC_SITE_URL:'https://skillcheck.pl',
  NEXT_PUBLIC_SUPABASE_URL:`https://${productionRef}.supabase.co`, P24_SANDBOX:'true',
  P24_MERCHANT_ID:'12345', P24_POS_ID:'12346', P24_CRC:'synthetic-crc', P24_API_KEY:'synthetic-test-api-key',
  SC19_P24_CHECKOUT_DATABASE_URL:
    `postgresql://sc19_p24_checkout.${productionRef}:fake@aws-1-eu-west-1.pooler.supabase.com:6543/postgres` };
test('the production sandbox checkout resolves only on the real site origin, in sandbox mode, with its own restricted login', () => {
  for (const resolve of [sc19ProductionSandboxPaymentConfig, sc19SandboxPaymentConfig]) {
    const config = resolve(productionEnv);
    // The callback and return origin is the site's own address, never a deployment
    // host and never anything a header could suggest.
    assert.equal(config.appOrigin,'https://skillcheck.pl');
    assert.equal(config.merchantId,12345);
    assert.equal(config.posId,12346);
    assert.equal(config.databaseUrl,productionEnv.SC19_P24_CHECKOUT_DATABASE_URL);
    assert.equal(resolve(productionEnv,'https://skillcheck.pl').appOrigin,'https://skillcheck.pl');
    assert.equal(resolve({...productionEnv,NEXT_PUBLIC_SITE_URL:'https://skillcheck.pl/'}).appOrigin,
      'https://skillcheck.pl');
    for (const origin of ['https://www.skillcheck.pl','https://skillcheck-core.vercel.app',
      'https://skillcheck.pl.evil.example','http://skillcheck.pl','https://skillcheck.pl/dashboard']) {
      assert.equal(resolve(productionEnv,origin),null,origin);
    }
    for (const overrides of [
      { VERCEL:'0' }, { VERCEL:undefined },
      { VERCEL_ENV:'preview' }, { VERCEL_ENV:'development' }, { VERCEL_ENV:undefined },
      { VERCEL_GIT_COMMIT_REF:'integration' }, { VERCEL_GIT_COMMIT_REF:undefined },
      { P24_SANDBOX:undefined }, { P24_SANDBOX:'false' }, { P24_SANDBOX:'TRUE' }, { P24_SANDBOX:'1' },
      { NEXT_PUBLIC_SUPABASE_URL:`https://${ref}.supabase.co` },
      { NEXT_PUBLIC_SUPABASE_URL:undefined },
      { NEXT_PUBLIC_SITE_URL:undefined }, { NEXT_PUBLIC_SITE_URL:'https://www.skillcheck.pl' },
      { NEXT_PUBLIC_SITE_URL:'https://skillcheck.pl/app' }, { NEXT_PUBLIC_SITE_URL:'http://skillcheck.pl' },
      { P24_MERCHANT_ID:undefined }, { P24_MERCHANT_ID:'0' }, { P24_POS_ID:'1e4' },
      { P24_CRC:'short' }, { P24_API_KEY:'too-short' }, { P24_API_KEY:undefined },
      { SC19_P24_CHECKOUT_DATABASE_URL:undefined },
      // The restricted login is validated exactly as the preview one is: the role
      // name, the project ref, the pooler host, the port, the path, and no query
      // or fragment. A preview login, the `postgres` superuser-ish account or a
      // weakened connection string must all be refused.
      ...['sc19_p24_preview','postgres','sc19_p24_checkout2'].map(user => ({
        SC19_P24_CHECKOUT_DATABASE_URL:
          productionEnv.SC19_P24_CHECKOUT_DATABASE_URL.replace('sc19_p24_checkout',user) })),
      { SC19_P24_CHECKOUT_DATABASE_URL:
        productionEnv.SC19_P24_CHECKOUT_DATABASE_URL.replace(productionRef,ref) },
      { SC19_P24_CHECKOUT_DATABASE_URL:
        productionEnv.SC19_P24_CHECKOUT_DATABASE_URL.replace(':6543',':5432') },
      { SC19_P24_CHECKOUT_DATABASE_URL:
        productionEnv.SC19_P24_CHECKOUT_DATABASE_URL.replace('aws-1-eu-west-1.pooler.supabase.com','db.wsvjawuikxfzjyivxgsu.supabase.co') },
      { SC19_P24_CHECKOUT_DATABASE_URL:
        productionEnv.SC19_P24_CHECKOUT_DATABASE_URL.replace(':fake@','@') },
      { SC19_P24_CHECKOUT_DATABASE_URL:
        productionEnv.SC19_P24_CHECKOUT_DATABASE_URL.replace('/postgres','/other') },
      { SC19_P24_CHECKOUT_DATABASE_URL: productionEnv.SC19_P24_CHECKOUT_DATABASE_URL+'?sslmode=disable' },
      { SC19_P24_CHECKOUT_DATABASE_URL: productionEnv.SC19_P24_CHECKOUT_DATABASE_URL+'#x' },
      { SC19_P24_CHECKOUT_DATABASE_URL:
        productionEnv.SC19_P24_CHECKOUT_DATABASE_URL.replace('postgresql://','postgres://') },
    ]) {
      assert.equal(resolve({...productionEnv,...overrides}),null,JSON.stringify(overrides));
    }
  }
});

test('nothing in the sandbox gate or its runtime can reach Przelewy24 LIVE', async () => {
  // Without the sandbox flag there is no runtime at all, on either deployment, so
  // the live host can never be the checkout target by omission.
  for (const value of [undefined,'false','true ','yes']) {
    assert.equal(sc19SandboxPaymentConfig({...productionEnv,P24_SANDBOX:value}),null);
    assert.equal(sc19SandboxPaymentConfig({...env,P24_SANDBOX:value}),null);
  }
  assert.equal(PRZELEWY24_ORIGIN.test,'https://sandbox.przelewy24.pl');
  assert.equal(PRZELEWY24_ORIGIN.live,'https://secure.przelewy24.pl');
  // The only runtime composition in the repository pins the test mode, refuses the
  // live approval and accepts the sandbox checkout origin only. A future live
  // switch is a separate reviewed change; this asserts none has been half-wired.
  const runtime = await sql('../lib/sc19-payment-preview-runtime.ts');
  assert.match(runtime,/mode: 'test'/);
  assert.match(runtime,/checkoutOrigins: \[PRZELEWY24_ORIGIN\.test\]/);
  assert.match(runtime,/liveApproved: false/);
  assert.doesNotMatch(runtime,/'live'|PRZELEWY24_ORIGIN\.live|liveApproved: true/);
  const gate = await sql('../lib/sc19-payment-preview.ts');
  assert.doesNotMatch(gate,/secure\.przelewy24\.pl/);
  // Both deployments are sandbox-only by construction: each branch of the gate
  // tests P24_SANDBOX for the exact string 'true'.
  assert.equal(gate.match(/P24_SANDBOX !== 'true'/g).length,2);
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
