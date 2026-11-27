// SC-019a (docs/ROADMAP.md R7): test końcowy sklepu w core na fikcyjnych firmach.
// Dla PRESELEKCJI, WERYFIKACJI i ASSESSMENT CENTER: zakup (tryb testowy Stripe) →
// zapłata (podpisane zdarzenie webhooka checkout.session.completed) → otwarty
// właściwy pakiet i limity → wykorzystanie; bez zakupu (i przed zapłatą) dostępu nie ma.
//
// Co jest prawdziwe: pełny łańcuch migracji na natywnym PostgreSQL 16/17, oferta
// PRESELEKCJI z seeda Preview, rola adaptera płatności (sc19_p24_checkout) z jej
// uprawnieniami i RLS, warstwa HTTP (lib/sc19-payment-http.ts), orkiestracja
// (lib/sc19-payments.ts), magazyn Postgres z rozszerzeniem pakietów Stripe, adapter
// Stripe (lib/sc19-stripe-provider.ts) z prawdziwą weryfikacją podpisu Stripe-Signature,
// bramka sesji AC (R3) i zużycie analizy CV z puli.
// Co jest atrapą: API Stripe (wstrzyknięty fetch, bez sieci), logowanie (stały
// użytkownik), klucze (losowe, w formacie testowym, tworzone w trakcie testu — żadnych
// kluczy w kodzie ani w środowisku). Brak faktur: tryb testowy nie wystawia faktur.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { setupRankingDatabase } from './helpers/screening-ranking-fixture.mjs';
import { bootMigrationDatabase, applyPreviewSeeds, paymentUsers } from './helpers/sc19-migration-fixture.mjs';
import { composeSc19PaymentRuntime } from '../lib/sc19-payment-runtime.ts';
import { createSc19PaymentHttp } from '../lib/sc19-payment-http.ts';
import { createStripeProvider, readStripeBuyerCompany, STRIPE_CHECKOUT_ORIGIN } from '../lib/sc19-stripe-provider.ts';
import { stripePackageExtension } from '../lib/sc19-stripe-packages.ts';
import { STRIPE_CATALOG } from '../lib/stripe-catalog.ts';

const ORIGIN = 'https://app.fixture.invalid';
const alnum = n => randomBytes(n).toString('hex');
// Synthetic test-mode credentials generated per run (never a real key).
const SECRET = 'sk_test_' + alnum(16);
const WHSEC = 'whsec_' + alnum(16);

// Fake Stripe API: only the calls the adapter makes for a test-mode Checkout.
function fakeStripe() {
  const s = { customers: new Map(), sessions: new Map(), seq: 0, calls: [] };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const missing = () => json({ error: { code: 'resource_missing' } }, 404);
  s.fetch = async (url, init) => {
    assert.equal(init.headers.Authorization, `Bearer ${SECRET}`);
    const u = new URL(url), method = init.method, path = u.pathname;
    const body = Object.fromEntries(new URLSearchParams(init.body ?? ''));
    s.calls.push({ method, path });
    let m;
    if (method === 'GET' && path === '/v1/customers/search') {
      const company = /company_id'\]:'([^']+)'/.exec(u.searchParams.get('query'))[1];
      return json({ data: [...s.customers.values()].filter(c => c.metadata.company_id === company) });
    }
    if (method === 'POST' && path === '/v1/customers') {
      const c = { id: `cus_fake${++s.seq}x`, object: 'customer', name: body.name, email: body.email,
        metadata: { app: body['metadata[app]'], company_id: body['metadata[company_id]'] } };
      s.customers.set(c.id, c); return json(c);
    }
    if ((m = /^\/v1\/customers\/(cus_[A-Za-z0-9]+)$/.exec(path))) {
      const c = s.customers.get(m[1]); if (!c) return missing();
      if (method === 'POST') Object.assign(c, { name: body.name, email: body.email });
      return json(c);
    }
    // No Price objects on the fake account: the adapter falls back to inline price data from the code catalog.
    if (method === 'GET' && path === '/v1/prices') return json({ data: [] });
    if (method === 'POST' && path === '/v1/checkout/sessions') {
      const metadata = {};
      for (const [k, v] of Object.entries(body)) { const mm = /^metadata\[(.+)\]$/.exec(k); if (mm) metadata[mm[1]] = v; }
      const sid = `cs_test_fake${++s.seq}session`;
      const session = { id: sid, object: 'checkout.session', mode: body.mode, currency: body.currency, livemode: false,
        customer: body.customer, client_reference_id: body.client_reference_id, metadata,
        amount_total: Number(body['line_items[0][price_data][unit_amount]']) * Number(body['line_items[0][quantity]']),
        url: `${STRIPE_CHECKOUT_ORIGIN}/c/pay/${sid}`, status: 'open', payment_status: 'unpaid', payment_intent: null };
      s.sessions.set(sid, session); return json(session);
    }
    if (method === 'GET' && path === '/v1/checkout/sessions')
      return json({ has_more: false, data: [...s.sessions.values()].filter(x => x.customer === u.searchParams.get('customer')) });
    if (method === 'GET' && (m = /^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(path))) {
      const x = s.sessions.get(m[1]); return x ? json(x) : missing();
    }
    return json({ error: { code: 'unexpected_call' } }, 500);
  };
  // The buyer pays on the hosted page (test card): Stripe marks the session complete and paid.
  s.pay = sid => Object.assign(s.sessions.get(sid), { status: 'complete', payment_status: 'paid',
    payment_intent: `pi_fake${sid.replace(/[^A-Za-z0-9]/g, '').slice(-16)}`, url: null });
  return s;
}

function signedEvent(session, secret = WHSEC) {
  const event = { id: 'evt_fake' + alnum(6), type: 'checkout.session.completed', livemode: false,
    data: { object: { id: session.id, metadata: { ...session.metadata } } } };
  const raw = JSON.stringify(event), t = Math.floor(Date.now() / 1000);
  return { raw, header: `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}` };
}

test('SC-019a: purchase in Stripe test mode → signed webhook → the right package and limits → usage; no purchase, no access',
  async t => {
    const env = await bootMigrationDatabase(t), { db } = env;
    const h = await setupRankingDatabase(db, { throughMigration: null });
    await applyPreviewSeeds(db); // the one purchasable PRESELEKCJA offer, as on Preview
    for (const id of Object.values(paymentUsers)) await db.query('insert into auth.users values($1)', [id]);

    // Four fictional companies with a confirmed NIP (purchase precondition) and no package at all.
    const firm = {};
    const nips = { P: '1000000001', W: '1000000002', A: '1000000003', N: '1000000004' };
    const owners = { P: paymentUsers.owner, W: paymentUsers.otherOwner, A: paymentUsers.recruiter, N: paymentUsers.viewer };
    for (const key of Object.keys(nips)) {
      firm[key] = await h.seed(owners[key], `sc019a-${key}`);
      await h.asAdmin();
      await db.query('insert into private.sc19_trial_approvals(company_id,nip,proof_reference) values($1,$2,$3)',
        [firm[key].companyId, nips[key], `synthetic-sc019a-proof-${key}`]);
    }

    // The payment adapter runs as its own restricted role, as the Stripe runtime does.
    const pool = env.pool();
    const rolePool = { async connect() { const c = await pool.connect(); await c.query('set role sc19_p24_checkout'); return c; } };
    const roleQuery = async (sql, values) => {
      const c = await rolePool.connect();
      try { return (await c.query(sql, values)).rows; } finally { c.release(); }
    };
    const stripe = fakeStripe();
    const scope = { provider: 'stripe', account: 'ktig-consulting', mode: 'test' };
    const customers = {
      async find(companyId, mode) {
        return (await roleQuery('select customer_id from sc19_stripe.customers where company_id=$1 and mode=$2', [companyId, mode]))[0]?.customer_id ?? null;
      },
      async save(companyId, mode, customerId) {
        await roleQuery('insert into sc19_stripe.customers(company_id,mode,customer_id) values($1,$2,$3) on conflict (company_id,mode) do nothing',
          [companyId, mode, customerId]);
        return this.find(companyId, mode);
      },
      async replace() { throw Error('not expected in this test'); },
    };
    let actor = null;
    const provider = createStripeProvider({ secretKey: SECRET, webhookSecret: WHSEC, mode: 'test', appOrigin: ORIGIN, scope,
      customers, fetch: stripe.fetch,
      async buyer(order) {
        assert.equal(order.buyerId, actor);
        return { email: 'buyer@example.invalid', ...await readStripeBuyerCompany(roleQuery, order.companyId) };
      } });
    const paidHook = [];
    const http = createSc19PaymentHttp(composeSc19PaymentRuntime({
      pool: rolePool, provider, scope, appOrigin: ORIGIN, signatureHeader: 'stripe-signature',
      checkoutOrigins: [STRIPE_CHECKOUT_ORIGIN], storeExtension: stripePackageExtension,
      enabled: true, liveApproved: false, onPaid: async order => { paidHook.push(order.id); },
      authenticate: async () => actor ? { userId: actor } : null,
    }));

    const offersOf = async key => {
      actor = owners[key];
      const response = await http.offers(new Request(`${ORIGIN}/api/billing/offers?companyId=${firm[key].companyId}`));
      assert.equal(response.status, 200);
      return (await response.json()).offers;
    };
    const buy = async (key, offer) => {
      actor = owners[key];
      const response = await http.checkout(new Request(`${ORIGIN}/api/billing/checkout`, {
        method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ companyId: firm[key].companyId, offerId: offer.id, termsRevision: offer.termsRevision,
          requestId: randomUUID(), packageCode: offer.packageCode }),
      }));
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.status, 'awaiting_payment');
      assert.ok(result.checkoutUrl.startsWith(`${STRIPE_CHECKOUT_ORIGIN}/c/pay/cs_test_`), 'test-mode hosted Stripe page');
      const session = [...stripe.sessions.values()].find(s => s.metadata.order_id === result.orderId);
      assert.ok(session);
      return { orderId: result.orderId, session };
    };
    const webhook = async (event, header = event.header) => http.webhook(new Request(`${ORIGIN}/api/billing/webhook`, {
      method: 'POST', headers: { 'stripe-signature': header }, body: event.raw }));
    const state = async key => {
      await h.asAdmin();
      const id = firm[key].companyId;
      const balance = (await db.query('select available from private.sc19_balances where company_id=$1', [id])).rows[0]?.available ?? 0;
      const packages = (await db.query(`select code, available from sc19_commerce.entitlements where company_id=$1 order by code`, [id])).rows
        .filter(r => r.available > 0).map(r => r.code);
      return { balance: Number(balance), packages };
    };
    const analyse = async key => {
      const candidate = await h.candidate(firm[key], `sc019a-${key}-${randomUUID().slice(0, 8)}`);
      const started = await h.start(candidate);
      const claimed = await h.claim(started);
      await h.finishClaim(started, claimed, Array(claimed.criteria_snapshot.length).fill('meets'));
      await h.asAdmin();
      return started;
    };
    const createAcSession = async key => {
      await h.asUser(owners[key]);
      try {
        return (await db.query("select public.ac_session_create($1,'Sesja finalistów SC-019a',array['Analiza']) id",
          [firm[key].recruitment.id])).rows[0].id;
      } finally { await h.asAdmin(); }
    };
    const quotaExhausted = e => e.code === 'PT402' && /sc19_quota_exhausted/.test(e.message);
    const acPackageRequired = e => e.code === 'PT402' && e.message === 'Assessment Center package required';
    const orderStatus = async orderId =>
      (await db.query(`select status from private.sc19_payment_orders where id=$1
        union all select status from sc19_stripe.package_orders where id=$1`, [orderId])).rows[0]?.status;

    await t.test('without any purchase: no CV pool, no package, no analysis, no Assessment Center session', async () => {
      for (const key of Object.keys(firm)) assert.deepEqual(await state(key), { balance: 0, packages: [] }, key);
      const candidate = await h.candidate(firm.N, 'sc019a-N-no-access');
      await assert.rejects(h.start(candidate), quotaExhausted);
      await assert.rejects(createAcSession('N'), acPackageRequired);
      await h.asAdmin();
      assert.equal((await db.query('select count(*)::int n from private.ac_sessions where company_id=$1', [firm.N.companyId])).rows[0].n, 0);
    });

    await t.test('the shop offers exactly the three packages at docs/cennik-2026-11-02.md prices', async () => {
      const offers = await offersOf('N');
      assert.deepEqual(offers.map(o => [o.packageCode, o.amountMinor, o.credits]),
        [['PRESELEKCJA', 30000, 60], ['WERYFIKACJA', 61500, 60], ['ASSESSMENT_CENTER', 149900, 50]]);
      for (const o of offers) assert.equal(o.amountMinor, STRIPE_CATALOG[o.packageCode].grossMinor);
    });

    const cases = [
      { key: 'P', code: 'PRESELEKCJA', credits: 60, packages: [] },
      { key: 'W', code: 'WERYFIKACJA', credits: 60, packages: ['package:WERYFIKACJA'] },
      { key: 'A', code: 'ASSESSMENT_CENTER', credits: 50, packages: ['package:ASSESSMENT_CENTER'] },
    ];
    for (const c of cases) {
      await t.test(`${c.code}: checkout → unpaid gives nothing → bad signature refused → paid webhook opens the package once → usage`, async () => {
        const offer = (await offersOf(c.key)).find(o => o.packageCode === c.code);
        const { orderId, session } = await buy(c.key, offer);
        assert.equal(session.amount_total, STRIPE_CATALOG[c.code].grossMinor, 'Stripe charges the price-list amount');
        assert.equal(session.metadata.package_code, c.code);
        assert.equal(await orderStatus(orderId), 'awaiting_payment');

        // Checkout created but not paid: still no access.
        assert.deepEqual(await state(c.key), { balance: 0, packages: [] });
        await assert.rejects(h.start(await h.candidate(firm[c.key], `sc019a-${c.key}-unpaid`)), quotaExhausted);
        await assert.rejects(createAcSession(c.key), acPackageRequired);

        // A completed event before Stripe confirms payment grants nothing.
        assert.equal((await webhook(signedEvent(session))).status, 200);
        assert.deepEqual(await state(c.key), { balance: 0, packages: [] });

        stripe.pay(session.id);
        // A forged signature (wrong endpoint secret) is refused and grants nothing.
        const forged = signedEvent(session, 'whsec_' + alnum(16));
        assert.equal((await webhook(forged)).status, 400);
        assert.deepEqual(await state(c.key), { balance: 0, packages: [] });

        // The signed paid event opens exactly this package and its CV limit, once.
        const paid = signedEvent(session);
        const first = await webhook(paid);
        assert.equal(first.status, 200); assert.equal((await first.json()).state, 'applied');
        const again = await webhook(signedEvent(session));
        assert.equal(again.status, 200); assert.equal((await again.json()).state, 'already_applied');
        assert.equal(await orderStatus(orderId), 'paid');
        assert.deepEqual(await state(c.key), { balance: c.credits, packages: c.packages });
        assert.equal(paidHook.filter(id => id === orderId).length, 1, 'post-payment hook runs once');

        // Usage: one CV analysis takes one credit from the paid pool.
        await analyse(c.key);
        assert.equal((await state(c.key)).balance, c.credits - 1);
        // Only ASSESSMENT CENTER opens an Assessment Center session; the package is not used up by it.
        if (c.code === 'ASSESSMENT_CENTER') {
          assert.ok(await createAcSession(c.key));
          assert.deepEqual((await db.query(`select available, used from sc19_commerce.entitlements
            where company_id=$1 and code='package:ASSESSMENT_CENTER'`, [firm[c.key].companyId])).rows[0], { available: 1, used: 0 });
        } else {
          await assert.rejects(createAcSession(c.key), acPackageRequired);
        }
      });
    }

    // Gap found by SC-019a (issue #634): the WERYFIKACJA layer itself (competency test) is not
    // tied to a WERYFIKACJA purchase. Migration 20261121150000 grants no skill-test units and
    // sc19_commerce.settings.skill_test_metering stays off, so a company with PRESELEKCJA only
    // (or a FREE trial) can still send a competency test. Product decision, not fixed here.
    await t.test('WERYFIKACJA: a competency test needs a paid WERYFIKACJA package', { todo: 'issue #634: competency test not tied to the WERYFIKACJA purchase' }, () => {});

    await t.test('one company\'s purchase never opens anything for another; the company without a purchase still has no access', async () => {
      assert.deepEqual(await state('N'), { balance: 0, packages: [] });
      await assert.rejects(h.start(await h.candidate(firm.N, 'sc019a-N-after')), quotaExhausted);
      await assert.rejects(createAcSession('N'), acPackageRequired);
      await h.asAdmin();
      // Every grant is one journal row with a settlement reference, one per paid order.
      const byCompany = rows => rows.sort((a, b) => a[0].localeCompare(b[0]));
      assert.deepEqual(byCompany((await db.query(`select company_id::text, delta from private.sc19_credit_journal
        where reason='paid_grant' and reference like 'settlement:%'`)).rows.map(r => [r.company_id, r.delta])),
      byCompany([[firm.A.companyId, 50], [firm.P.companyId, 60], [firm.W.companyId, 60]]));
      assert.equal((await db.query(`select count(*)::int n from private.sc19_credit_journal where reason='paid_grant'`)).rows[0].n, 3);
      assert.equal(paidHook.length, 3);
      // Test mode only: no live order exists.
      assert.equal((await db.query(`select count(*)::int n from (select mode from private.sc19_payment_orders
        union all select mode from sc19_stripe.package_orders) o where mode<>'test'`)).rows[0].n, 0);
    });
  });
