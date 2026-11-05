import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { sc19PreviewPaymentConfig } from '../lib/sc19-payment-preview.ts';
import { createPostgresPaymentStore } from '../lib/sc19-payment-postgres.ts';

const ref = 'orbyscrupgnupifzlqxp';
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
