import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createCheckoutOrders, signCheckout } from '../lib/checkout-orders.ts';
import { createCheckoutService, createP24Client, parseP24Notification, readP24Config, validNip, validateCheckout } from '../lib/p24-checkout.ts';
import { authorizedReconciler, createP24CheckoutHttp } from '../lib/p24-checkout-http.ts';
import { CHECKOUT_PRODUCTS } from '../lib/checkout-catalog.ts';

// Real migration on PGlite + real service/HTTP code against an in-memory
// Przelewy24 sandbox. No network, no money, synthetic keys only.
const MERCHANT = 123456, CRC = 'synthetic-crc-0123', API_KEY = 'synthetic-api-key-0123456789';
const SECRET = 'test-only-checkout-secret-0123456789abcdef';
const ORIGIN = 'https://sandbox.przelewy24.pl', APP = 'https://app.example.test', DEPLOYMENT = 'https://app-git-abc.example.test';
const ENV = { P24_MERCHANT_ID: String(MERCHANT), P24_POS_ID: String(MERCHANT), P24_CRC: CRC, P24_API_KEY: API_KEY, P24_SANDBOX: 'true' };
const config = readP24Config(ENV);
const sha384 = o => createHash('sha384').update(JSON.stringify(o)).digest('hex');
const reply = (status, body) => ({ status, json: async () => structuredClone(body) });
const migration = await readFile(new URL('../supabase/migrations/20261031120000_checkout_orders.sql', import.meta.url), 'utf8');

function fakeP24() {
  const s = { tx: new Map(), registers: [], verifies: [], nextOrder: 700001, rejectVerify: false };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    assert.equal(u.origin, ORIGIN);
    assert.equal(init.headers.authorization, 'Basic ' + Buffer.from(`${MERCHANT}:${API_KEY}`).toString('base64'));
    if (init.method === 'POST' && u.pathname === '/api/v1/transaction/register') {
      const b = JSON.parse(init.body); s.registers.push(b);
      if (b.sign !== sha384({ sessionId: b.sessionId, merchantId: MERCHANT, amount: b.amount, currency: 'PLN', crc: CRC })) return reply(400, { error: 'Incorrect sign' });
      s.tx.set(b.sessionId, { sessionId: b.sessionId, orderId: s.nextOrder++, amount: b.amount, currency: 'PLN', status: 0 });
      return reply(200, { data: { token: 'TOKEN-' + b.sessionId.slice(7, 15) }, responseCode: 0 });
    }
    if (init.method === 'PUT' && u.pathname === '/api/v1/transaction/verify') {
      const b = JSON.parse(init.body); s.verifies.push(b);
      const t = s.tx.get(b.sessionId);
      if (s.rejectVerify || !t || t.status !== 1 || t.orderId !== b.orderId || t.amount !== b.amount ||
          b.sign !== sha384({ sessionId: b.sessionId, orderId: b.orderId, amount: b.amount, currency: 'PLN', crc: CRC })) return reply(400, { error: 'verify failed' });
      t.status = 2;
      return reply(200, { data: { status: 'success' }, responseCode: 0 });
    }
    if (init.method === 'GET' && u.pathname.startsWith('/api/v1/transaction/by/sessionId/')) {
      const t = s.tx.get(decodeURIComponent(u.pathname.split('/').pop()));
      return t ? reply(200, { data: { ...t } }) : reply(404, { error: 'not found' });
    }
    return reply(404, null);
  };
  /** Customer pays on the hosted page; returns the signed urlStatus body Przelewy24 would POST. */
  const pay = (sessionId, { amount, crc = CRC } = {}) => {
    const t = s.tx.get(sessionId); t.status = 1;
    const n = { merchantId: MERCHANT, posId: MERCHANT, sessionId, amount: amount ?? t.amount, originAmount: amount ?? t.amount,
      currency: 'PLN', orderId: t.orderId, methodId: 154, statement: 'p24-A1-B2' };
    return new TextEncoder().encode(JSON.stringify({ ...n, sign: sha384({ ...n, crc }) }));
  };
  return { s, fetchImpl, pay };
}

async function database() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create role service_role; create schema private; create schema extensions;
    create extension pgcrypto with schema extensions; grant usage on schema public to anon, authenticated, service_role;`);
  await db.exec(migration);
  await db.query('select checkout.set_request_secret($1)', [SECRET]);
  // Same calling convention as supabase-js rpc(): named args, executed as the anon role.
  const rpc = async (fn, args) => {
    const names = Object.keys(args);
    const sql = `select * from public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})`;
    try {
      await db.exec('set role anon');
      const { rows } = await db.query(sql, names.map(n => args[n]));
      return { data: ['checkout_read_order', 'checkout_pending_orders'].includes(fn) ? rows : Object.values(rows[0])[0], error: null };
    } catch (e) { return { data: null, error: { message: e.message } }; } finally { await db.exec('reset role'); }
  };
  return { db, rpc };
}

async function setup({ failUpdates = 0 } = {}) {
  const { db, rpc: realRpc } = await database();
  let failures = failUpdates;
  // Simulates a transient store outage on the paid write right after verify.
  const rpc = (fn, args) => fn === 'checkout_update_order' && args.new_status === 'paid' && failures-- > 0
    ? Promise.resolve({ data: null, error: { message: 'fetch failed' } }) : realRpc(fn, args);
  const p = fakeP24();
  const orders = createCheckoutOrders(rpc, SECRET);
  const service = createCheckoutService({ config, orders, p24: createP24Client(config, p.fetchImpl), appOrigin: APP }, async () => {});
  return { db, rpc, p, orders, service, http: createP24CheckoutHttp(service, origin => origin === APP || origin === DEPLOYMENT) };
}
const row = async (db, id) => (await db.query('select * from checkout.orders where id=$1', [id])).rows[0];
const buyer = (o = {}) => ({ product: 'preselekcja', quantity: 2, name: 'Jan Testowy', email: 'Jan@Example.test', phone: '+48 600 100 200',
  company: 'Firma Testowa Sp. z o.o.', nip: '526-000-12-46', terms: true, ...o });
const post = (body, headers = {}) => new Request(`${APP}/api/p24/register`, { method: 'POST',
  headers: { origin: APP, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('configuration only from complete env; sandbox flag must be explicit', () => {
  assert.equal(config.sandbox, true);
  assert.equal(readP24Config({ ...ENV, P24_SANDBOX: 'false' }).sandbox, false);
  for (const broken of [{ P24_SANDBOX: undefined }, { P24_SANDBOX: 'yes' }, { P24_CRC: '' }, { P24_API_KEY: 'short' }, { P24_MERCHANT_ID: 'abc' }])
    assert.equal(readP24Config({ ...ENV, ...broken }), null, JSON.stringify(broken));
});

test('catalog price mirrors the published PRESELEKCJA offer', async () => {
  const offer = await readFile(new URL('../app/components/marketing/preselekcja-offer.ts', import.meta.url), 'utf8');
  assert.equal(CHECKOUT_PRODUCTS.preselekcja.unitGross, Number(offer.match(/grossPln: (\d+),/)[1]) * 100);
  assert.match(CHECKOUT_PRODUCTS.preselekcja.description, new RegExp(`ważne ${offer.match(/validityMonths: (\d+),/)[1]} miesiące`));
  // The analyses count is not frozen in the catalog: /checkout shows the live scope like /preselekcja.
  assert.doesNotMatch(CHECKOUT_PRODUCTS.preselekcja.description, /analiz CV/);
  const page = await readFile(new URL('../app/checkout/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /loadPublicOffer\(\)/); assert.match(page, /sc19PolicyPendingScope/);
});

test('validation: server price, required consent, optional company and NIP checksum', () => {
  const v = validateCheckout(buyer());
  assert.equal(v.amountGross, 60000); assert.equal(v.email, 'jan@example.test'); assert.equal(v.nip, '5260001246');
  assert.equal(validateCheckout(buyer({ company: '', nip: '' })).nip, null);
  assert.ok(validNip('5260001246')); assert.ok(!validNip('5260001247'));
  for (const [field, patch] of [['terms', { terms: 'on' }], ['terms', { terms: false }], ['nip', { nip: '1234567890' }], ['quantity', { quantity: 11 }],
    ['quantity', { quantity: 0 }], ['product', { product: 'gratis' }], ['email', { email: 'x@' }], ['phone', { phone: 'abc' }], ['name', { name: 'J' }]])
    assert.deepEqual(validateCheckout(buyer(patch)), { field }, field);
  // A browser-sent amount is ignored: the price comes from the catalog.
  assert.equal(validateCheckout(buyer({ amount: 1 })).amountGross, 60000);
});

test('end-to-end: register → pay → notify (sign + verify) → paid; return page shows paid', async t => {
  const { db, p, service, http } = await setup(); t.after(() => db.close());
  const res = await http.register(post(buyer()));
  assert.equal(res.status, 200);
  const { orderId, redirectUrl } = await res.json();
  assert.match(redirectUrl, /^https:\/\/sandbox\.przelewy24\.pl\/trnRequest\/TOKEN-/);
  const reg = p.s.registers[0];
  assert.equal(reg.amount, 60000); assert.equal(reg.currency, 'PLN'); assert.equal(reg.sessionId, `sc-ord-${orderId}`);
  assert.equal(reg.urlReturn, `${APP}/checkout/return?order=${orderId}`); assert.equal(reg.urlStatus, `${APP}/api/p24/notify`);
  assert.equal(reg.email, 'jan@example.test');
  let r = await row(db, orderId);
  assert.equal(r.status, 'pending'); assert.equal(r.amount_gross, 60000); assert.equal(r.currency, 'PLN'); assert.equal(r.nip, '5260001246');
  assert.equal((await service.status(orderId)).status, 'pending', 'unpaid transaction stays pending');

  const body = p.pay(reg.sessionId);
  const notify = await http.notify(new Request(`${APP}/api/p24/notify`, { method: 'POST', body }));
  assert.equal(notify.status, 200);
  assert.equal(p.s.verifies.length, 1);
  r = await row(db, orderId);
  assert.equal(r.status, 'paid'); assert.equal(Number(r.p24_order_id), p.s.tx.get(reg.sessionId).orderId); assert.ok(r.paid_at);
  // Repeated notification is idempotent.
  assert.equal((await http.notify(new Request(`${APP}/api/p24/notify`, { method: 'POST', body }))).status, 200);
  assert.deepEqual(await service.status(orderId), { status: 'paid', amountGross: 60000, productCode: 'preselekcja', quantity: 2 });
});

test('return page reconciles a paid transaction when the notification never arrived', async t => {
  const { db, p, service } = await setup(); t.after(() => db.close());
  const { orderId } = await service.start(validateCheckout(buyer({ quantity: 1 })));
  p.pay(`sc-ord-${orderId}`); // urlStatus blocked (e.g. preview protection): no notify
  assert.equal((await service.status(orderId)).status, 'paid');
  assert.equal((await row(db, orderId)).status, 'paid');
});

test('forged, foreign, or tampered notifications never mark an order paid', async t => {
  const { db, p, service, http } = await setup(); t.after(() => db.close());
  const { orderId } = await service.start(validateCheckout(buyer({ quantity: 1 })));
  const sessionId = `sc-ord-${orderId}`;
  const send = body => http.notify(new Request(`${APP}/api/p24/notify`, { method: 'POST', body }));
  assert.equal((await send(p.pay(sessionId, { crc: 'wrong-crc-value' }))).status, 400);
  const good = JSON.parse(new TextDecoder().decode(p.pay(sessionId)));
  assert.equal((await send(JSON.stringify({ ...good, merchantId: 999 }))).status, 400);
  assert.equal((await send(JSON.stringify({ ...good, extra: 1 }))).status, 400);
  assert.equal((await send(p.pay(sessionId, { amount: 100 }))).status, 400, 'amount differs from our order');
  assert.equal((await send('not json')).status, 400);
  p.s.rejectVerify = true;
  assert.equal((await send(p.pay(sessionId))).status, 503, 'verify rejected → P24 retries');
  assert.equal((await row(db, orderId)).status, 'pending');
  assert.throws(() => parseP24Notification(config, new TextEncoder().encode('{}')), e => e.code === 'P24_NOTIFICATION_INVALID');
});

test('register endpoint: origin, content type, field errors, disabled config', async t => {
  const { db, http } = await setup(); t.after(() => db.close());
  assert.equal((await http.register(post(buyer(), { origin: 'https://evil.example' }))).status, 403);
  assert.equal((await http.register(post(buyer(), { 'sec-fetch-site': 'cross-site' }))).status, 403);
  assert.equal((await http.register(post(buyer(), { 'content-type': 'text/plain' }))).status, 415);
  const bad = await http.register(post(buyer({ terms: false })));
  assert.equal(bad.status, 400); assert.deepEqual(await bad.json(), { error: 'CHECKOUT_FIELD', field: 'terms' });
  assert.equal((await createP24CheckoutHttp(null, () => true).register(post(buyer()))).status, 503);
  assert.equal((await http.register(post(buyer(), { origin: DEPLOYMENT }))).status, 200, 'any configured deployment address');
  assert.equal((await createP24CheckoutHttp(null, null).notify(new Request(APP, { method: 'POST', body: '{}' }))).status, 503);
  assert.equal((await db.query('select count(*)::int as n from checkout.orders')).rows[0].n, 1);
});

test('database: no direct table access; RPCs require a fresh valid HMAC; paid is terminal', async t => {
  const { db, rpc } = await database(); t.after(() => db.close());
  const orders = createCheckoutOrders(rpc, SECRET);
  await db.exec('set role anon');
  await assert.rejects(db.query('select * from checkout.orders'), e => e.code === '42501');
  await assert.rejects(db.query("insert into checkout.orders(id) values (gen_random_uuid())"), e => e.code === '42501');
  await assert.rejects(db.query('select * from checkout.settings'), e => e.code === '42501');
  await db.exec('reset role');
  for (const role of ['anon', 'authenticated', 'service_role'])
    for (const rel of ['checkout.orders', 'checkout.settings'])
      assert.equal((await db.query('select has_table_privilege($1,$2,$3) v', [role, rel, 'select'])).rows[0].v, false, `${role} ${rel}`);
  const id = '00000000-0000-4000-8000-000000000001';
  const at = Date.now() * 1000;
  const fields = [id, 'preselekcja', '1', '30000', 'Jan Testowy', 'jan@example.test', '600100200', null, null];
  const args = sig => ({ order_id: id, product_code: 'preselekcja', quantity: 1, amount_gross: 30000, customer_name: 'Jan Testowy',
    customer_email: 'jan@example.test', customer_phone: '600100200', company_name: null, nip: null, issued_at_us: at, request_signature: sig });
  assert.match((await rpc('checkout_create_order', args(signCheckout('create', at, fields, 'x'.repeat(40))))).error.message, /checkout_unauthenticated/);
  // Tampered amount with a signature for another amount.
  assert.match((await rpc('checkout_create_order', { ...args(signCheckout('create', at, fields, SECRET)), amount_gross: 100 })).error.message, /checkout_unauthenticated/);
  const old = at - 10 * 60 * 1_000_000;
  assert.match((await rpc('checkout_create_order', { ...args(signCheckout('create', old, fields, SECRET)), issued_at_us: old })).error.message, /checkout_request_expired/);
  assert.equal((await rpc('checkout_create_order', args(signCheckout('create', at, fields, SECRET)))).data, `sc-ord-${id}`);
  assert.equal((await rpc('checkout_create_order', args(signCheckout('create', at, fields, SECRET)))).data, `sc-ord-${id}`, 'idempotent retry');
  await assert.rejects(orders.update(id, 'paid', 5, 29999), e => e.code === 'CHECKOUT_AMOUNT_MISMATCH');
  assert.equal(await orders.update(id, 'paid', 5, 30000), 'paid');
  assert.equal(await orders.update(id, 'cancelled', null, null), 'paid', 'paid is terminal');
  await assert.rejects(orders.update(id, 'paid', 6, 30000), e => e.code === 'CHECKOUT_P24_ORDER_MISMATCH');
  // Without an installed secret everything is refused.
  await db.exec('update checkout.settings set request_secret = null');
  await assert.rejects(orders.read(id), e => e.code === 'CHECKOUT_DISABLED');
});

test('candidate erasure scope untouched: no new public/private relations', async t => {
  const { db } = await database(); t.after(() => db.close());
  const { rows } = await db.query(`select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind in ('r','p','v','m','f')`);
  assert.deepEqual(rows, [], 'checkout tables live in schema checkout, outside private.erasure_schema_signature');
});

test('paid write is retried after a successful verify (Przelewy24 does not resend)', async t => {
  const { db, p, service, http } = await setup({ failUpdates: 2 }); t.after(() => db.close());
  const { orderId } = await service.start(validateCheckout(buyer({ quantity: 1 })));
  const res = await http.notify(new Request(`${APP}/api/p24/notify`, { method: 'POST', body: p.pay(`sc-ord-${orderId}`) }));
  assert.equal(res.status, 200);
  assert.equal((await row(db, orderId)).status, 'paid');
});

test('reconcile settles a verified payment whose write failed everywhere', async t => {
  const { db, p, service, http } = await setup({ failUpdates: 3 }); t.after(() => db.close());
  const { orderId } = await service.start(validateCheckout(buyer({ quantity: 1 })));
  const res = await http.notify(new Request(`${APP}/api/p24/notify`, { method: 'POST', body: p.pay(`sc-ord-${orderId}`) }));
  assert.equal(res.status, 503);
  assert.equal(p.s.tx.get(`sc-ord-${orderId}`).status, 2, 'money settled at Przelewy24');
  assert.equal((await row(db, orderId)).status, 'pending');
  const secret = 'r'.repeat(40);
  const call = auth => http.reconcile(new Request(`${APP}/api/p24/reconcile`, { headers: auth ? { authorization: auth } : {} }), secret);
  assert.equal((await call()).status, 401);
  assert.equal((await call('Bearer wrong')).status, 401);
  assert.deepEqual(await (await call(`Bearer ${secret}`)).json(), { checked: 0, paid: 0 }, 'too recent for the default window');
  assert.deepEqual(await service.reconcile(0, 10), { checked: 1, paid: 1 });
  assert.equal((await row(db, orderId)).status, 'paid');
  assert.deepEqual(await service.reconcile(0, 10), { checked: 0, paid: 0 });
  assert.ok(!authorizedReconciler(`Bearer ${secret}`, 'short'));
});

test('reconcile rotates through unsettled orders instead of rechecking the same batch', async t => {
  const { db, service, orders } = await setup(); t.after(() => db.close());
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await service.start(validateCheckout(buyer({ quantity: 1, email: `b${i}@example.test` })))).orderId);
  const first = await orders.pending(0, 2), second = await orders.pending(0, 2);
  assert.equal(first.length, 2); assert.ok(second.includes(ids.find(id => !first.includes(id))), 'third order reached in the next batch');
  assert.deepEqual(new Set([...first, ...second]), new Set(ids));
});
