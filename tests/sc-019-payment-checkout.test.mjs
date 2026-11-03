import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Exercise the shipped component and its event handlers with deterministic
// browser I/O. This is a component-contract test, not a browser/processor E2E.
const require = createRequire(import.meta.url);
const source = await readFile(new URL('../app/dashboard/[companyId]/billing/checkout/checkout.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const companyId = '00000000-0000-4000-8000-000000000001';
const offer = (id = 'offer-a') => ({ id, revision: 'revision-v1', amountMinor: 12345,
  currency: 'PLN', credits: 12, termsRevision: 'terms-v1', termsText: 'Synthetic terms',
  validUntilMs: 4102444800000 });
const requestKey = o => `sc19:request:${companyId}:${o.id}:${o.termsRevision}`;
const orderKey = `sc19:order:${companyId}`;
const ok = data => ({ ok: true, json: async () => structuredClone(data) });

async function harness({ offers = [offer()], entries = [], checkout, order, clientNow, storageUnavailable=false, p24CheckoutUrl='', fallbackCredits=60, packagesEnabled=true } = {}) {
  const storage = new Map(entries), posts = [], redirects = [], statusReads = [];
  const hooks = [], effects = [];
  let cursor = 0, sequence = 0, offerReads = 0, tree;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[index].value, next => {
        hooks[index].value = typeof next === 'function' ? next(hooks[index].value) : next;
      }];
    },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!(index in hooks) || deps.some((value, i) => !Object.is(value, hooks[index].deps[i]))) {
        hooks[index]?.cleanup?.();
        hooks[index] = { deps };
        effects.push(() => { hooks[index].cleanup = callback(); });
      }
    },
  };
  const context = {
    exports: {}, Intl, Date:clientNow===undefined?Date:class extends Date {static now(){return clientNow;}}, AbortController, URL,
    // Only the public checkout URL is read; NEXT_PUBLIC_* is inlined in a real build.
    process: { env: { NEXT_PUBLIC_P24_CHECKOUT_URL: p24CheckoutUrl } },
    require(name) {
      if (name === 'react') return react;
      // The component reads the approved package figures from lib/.
      if (name.endsWith('/lib/preselekcja-offer')) return require('../lib/preselekcja-offer.ts');
      return require(name);
    },
    crypto: { randomUUID() { return `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`; } },
    sessionStorage: {
      getItem: key => {if(storageUnavailable)throw Error('blocked');return storage.get(key) ?? null;},
      setItem: (key, value) => {if(storageUnavailable)throw Error('blocked');storage.set(key, value);},
      removeItem: key => {if(storageUnavailable)throw Error('blocked');storage.delete(key);},
    },
    window: { location: { assign: url => redirects.push(url) } },
    async fetch(url, options) {
      if (url.startsWith('/api/billing/offers?')) return ok({ offers:typeof offers==='function'?offers(++offerReads):offers });
      if (url === '/api/billing/checkout') {
        const input = JSON.parse(options.body);
        posts.push(input);
        return checkout(input, posts.length);
      }
      if (url.startsWith('/api/billing/orders/')) {
        statusReads.push(url);
        return order(url);
      }
      throw Error(`Unexpected request: ${url}`);
    },
  };
  runInNewContext(compiled, context);
  function render() {
    cursor = 0;
    tree = context.exports.default({ companyId, fallbackCredits, packagesEnabled });
    for (const effect of effects.splice(0)) effect();
    return tree;
  }
  function elements(node, result = []) {
    if (Array.isArray(node)) { for (const item of node) elements(item, result); return result; }
    if (!node || typeof node !== 'object') return result;
    result.push(node);
    elements(node.props?.children, result);
    return result;
  }
  function find(type, text) {
    render();
    return elements(tree).find(node => node.type === type &&
      (text === undefined || String(node.props.children).includes(text)));
  }
  async function click(label) {
    const button = find('button', label);
    assert.ok(button, `Missing button: ${label}`);
    assert.notEqual(button.props.disabled, true, `Disabled button: ${label}`);
    await button.props.onClick();
    render();
  }
  render();
  // Flush the catalog fetch and its chained callbacks; no real timer/network I/O.
  await new Promise(resolve => setImmediate(resolve));
  render();
  return { storage, posts, redirects, statusReads, find, click,
    uuidCount: () => sequence,
    offerReads: () => offerReads,
    accept() { find('input').props.onChange({ target: { checked: true } }); render(); },
    close() { for (const hook of hooks) hook?.cleanup?.(); },
  };
}

test('uncertain checkout responses reuse the persisted request and cannot start a fresh purchase', async t => {
  const selected = offer();
  const h = await harness({ checkout: async () => { throw Error('Lost HTTP response'); } });
  t.after(h.close);
  h.accept();
  await h.click('Zamawiam');
  await h.click('Zamawiam');
  assert.equal(h.posts.length, 2);
  assert.equal(h.posts[0].requestId, h.posts[1].requestId);
  assert.equal(h.storage.get(requestKey(selected)), h.posts[0].requestId);
  assert.equal(h.uuidCount(), 1);
  assert.equal(h.find('button', 'Kup kolejny'), undefined);
  assert.deepEqual(h.redirects, []);
});

test('server-confirmed payment permits an explicit new purchase with fresh request and renewed terms', async t => {
  const selected = offer();
  const oldRequest = '00000000-0000-4000-8000-000000000099';
  const h = await harness({ entries: [[requestKey(selected), oldRequest], [orderKey, 'paid-order']],
    checkout: async (_input, count) => count === 1
      ? ok({ orderId: 'paid-order', status: 'paid' })
      : ok({ orderId: 'new-order', status: 'awaiting_payment', checkoutUrl: 'https://pay.fixture.invalid/new' }),
    order: async () => ok({ status: 'paid', credits: 12, offerId: selected.id, termsRevision: selected.termsRevision }),
  });
  t.after(h.close);
  h.accept();
  await h.click('Zamawiam');
  assert.equal(h.posts[0].requestId, oldRequest);
  assert.equal(h.statusReads.length, 1);
  assert.equal(h.find('button', 'Zamawiam').props.disabled, true);
  assert.deepEqual(h.redirects, []);
  await h.click('Kup kolejny');
  assert.equal(h.storage.has(requestKey(selected)), false);
  assert.equal(h.storage.has(orderKey), false);
  assert.equal(h.find('input').props.checked, false);
  assert.equal(h.find('button', 'Zamawiam').props.disabled, true);
  h.accept();
  await h.click('Zamawiam');
  assert.notEqual(h.posts[1].requestId, oldRequest);
  assert.equal(h.storage.get(requestKey(selected)), h.posts[1].requestId);
  assert.equal(h.storage.get(orderKey), 'new-order');
  assert.deepEqual(h.redirects, ['https://pay.fixture.invalid/new']);
});

test('reset of paid offer B preserves pending offer A and reuses its original request', async t => {
  const pending = offer('offer-a'), paid = offer('offer-b');
  const pendingRequest = '00000000-0000-4000-8000-000000000098';
  const h = await harness({ offers: [pending, paid], entries: [
    [requestKey(pending), pendingRequest], [requestKey(paid), 'paid-request'], [orderKey, 'paid-order-b'],
  ],
    checkout: async () => ok({ orderId: 'pending-order-a', status: 'awaiting_payment', checkoutUrl: 'https://pay.fixture.invalid/pending-a' }),
    order: async () => ok({ status: 'paid', credits: 12, offerId: paid.id, termsRevision: paid.termsRevision }),
  });
  t.after(h.close);
  assert.equal(h.find('select').props.value, pending.id);
  await h.click('Sprawdź status');
  await h.click('Kup kolejny');
  assert.equal(h.storage.has(requestKey(paid)), false);
  assert.equal(h.storage.get(requestKey(pending)), pendingRequest);
  h.accept();
  await h.click('Zamawiam');
  assert.equal(h.posts[0].offerId, pending.id);
  assert.equal(h.posts[0].requestId, pendingRequest);
  assert.equal(h.uuidCount(), 0);
  assert.deepEqual(h.redirects, ['https://pay.fixture.invalid/pending-a']);
});

for(const clientNow of [0,Date.now()+365*86400000])test(`server-approved offer remains purchasable with client clock ${clientNow===0?'behind':'ahead'}`,async t=>{
 const active={...offer(),validUntilMs:Date.now()+60000};
 const h=await harness({offers:[active],clientNow,checkout:async()=>ok({orderId:'active-order',status:'awaiting_payment',checkoutUrl:'https://pay.fixture.invalid/active'})});
 t.after(h.close);h.accept();await h.click('Zamawiam');
 assert.equal(h.posts.length,1);assert.deepEqual(h.redirects,['https://pay.fixture.invalid/active']);
});

test('server expiry refreshes terms, resets acceptance and never automatically submits a replacement purchase',async t=>{
 const initial=offer(),replacement={...offer('offer-new'),termsRevision:'terms-v2',amountMinor:23456};
 const h=await harness({clientNow:0,offers:read=>read===1?[initial]:[replacement],checkout:async()=>({ok:false,json:async()=>({error:'SC19_PAYMENT_OFFER_UNAVAILABLE'})})});
 t.after(h.close);h.accept();await h.click('Zamawiam');
 assert.equal(h.posts.length,1);assert.deepEqual(h.redirects,[]);
 assert.equal(h.find('select').props.value,replacement.id);
 assert.equal(h.find('input').props.checked,false);assert.equal(h.find('button','Zamawiam').props.disabled,true);
 assert.ok(h.find('p','Oferta wygasła'));
 h.accept();await h.click('Zamawiam');assert.equal(h.posts[1].termsRevision,'terms-v2');
});

test('expired catalog becomes unavailable and a manual refresh requires fresh acceptance',async t=>{
 const h=await harness({offers:read=>read===2?[]:[offer()],checkout:async()=>({ok:false,json:async()=>({error:'SC19_PAYMENT_OFFER_UNAVAILABLE'})})});
 t.after(h.close);h.accept();await h.click('Zamawiam');
 assert.equal(h.find('button','Zamawiam'),undefined);
 await h.click('Odśwież oferty');assert.equal(h.find('input').props.checked,false);
 assert.equal(h.find('button','Zamawiam').props.disabled,true);assert.equal(h.posts.length,1);
});

test('blocked sessionStorage still permits server-guarded checkout and keeps an in-memory retry hint',async t=>{
 const h=await harness({storageUnavailable:true,checkout:async(_input,n)=>{
  if(n===1)throw Error('lost');return ok({orderId:'recovered',status:'awaiting_payment',checkoutUrl:'https://pay.fixture.invalid/recovered'});
 }});
 t.after(h.close);h.accept();await h.click('Zamawiam');await h.click('Zamawiam');
 assert.equal(h.posts[0].requestId,h.posts[1].requestId);
 assert.deepEqual(h.redirects,['https://pay.fixture.invalid/recovered']);
});

test('conflicting unresolved purchase is explained without redirect or automatic retry',async t=>{
 const h=await harness({checkout:async()=>({ok:false,json:async()=>({error:'SC19_PAYMENT_PURCHASE_PENDING'})})});
 t.after(h.close);h.accept();await h.click('Zamawiam');
 assert.equal(h.posts.length,1);assert.deepEqual(h.redirects,[]);assert.ok(h.find('p','nierozliczone zamówienie'));
});

// SC-BUY-001: with the offers API unavailable the screen shows the approved
// package instead of a dead end, and the payment button follows the configured
// Przelewy24 address. The P24 API integration itself is a separate task.
const offersDown = () => { throw Error('offers API unavailable'); };

test('offers API down shows the approved package summary and consent, not a dead end', async t => {
  const h = await harness({ offers: offersDown });
  t.after(h.close);
  assert.equal(h.find('p', 'Płatności nie są jeszcze dostępne'), undefined);
  assert.ok(h.find('h2', '300'), 'gross price shown');
  assert.ok(h.find('p', 'analiz CV'), 'package scope shown');
  assert.ok(h.find('p', '60'), 'package size shown');
  assert.ok(h.find('p', '243,90'), 'net price shown');
  assert.ok(h.find('p', 'miesiące'), 'validity shown');
  assert.ok(h.find('input'), 'terms checkbox shown');
});

test('an unconfigured payment address keeps the button disabled with a clear note', async t => {
  const h = await harness({ offers: offersDown });
  t.after(h.close);
  const button = h.find('button', 'Przejdź do płatności');
  assert.ok(button); assert.equal(button.props.disabled, true);
  assert.ok(h.find('p', 'Płatność Przelewy24 — konfiguracja w toku'));
  h.accept();
  assert.equal(h.find('button', 'Przejdź do płatności').props.disabled, true);
});

test('a configured https address opens only after the terms are accepted', async t => {
  const url = 'https://pay.fixture.invalid/preselekcja';
  const h = await harness({ offers: offersDown, p24CheckoutUrl: url });
  t.after(h.close);
  assert.equal(h.find('button', 'Przejdź do płatności'), undefined);
  const before = h.find('a', 'Przejdź do płatności');
  assert.ok(before); assert.equal(before.props.href, undefined);
  h.accept();
  // No server-side order exists in this mode, so the payment must carry the
  // company reference the operator reconciles it against.
  assert.equal(h.find('a', 'Przejdź do płatności').props.href, `${url}?ref=${companyId}`);
  assert.ok(h.find('strong', companyId), 'the reconciliation reference is shown to the customer');
  assert.ok(h.find('p', 'operator po potwierdzeniu wpłaty'), 'no automatic credit grant is promised');
});

test('an unavailable approved quota blocks the fallback purchase instead of promising a number', async t => {
  const h = await harness({ offers: offersDown, p24CheckoutUrl: 'https://pay.fixture.invalid/x', fallbackCredits: null });
  t.after(h.close);
  assert.equal(h.find('a', 'Przejdź do płatności'), undefined);
  assert.equal(h.find('button', 'Przejdź do płatności').props.disabled, true);
  assert.ok(h.find('p', 'zgodna z zatwierdzoną polityką pakietów'));
});

test('the fallback shows the active policy quota, not a hardcoded one', async t => {
  const h = await harness({ offers: offersDown, fallbackCredits: 45 });
  t.after(h.close);
  assert.ok(h.find('p', '45'), 'live policy quota shown');
  assert.equal(h.find('p', '60'), undefined, 'the marketing figure is not shown as the quota');
});

test('a non-https or malformed payment address is never linked', async t => {
  for (const value of ['http://pay.fixture.invalid/x', 'javascript:alert(1)', 'pay.fixture.invalid', '   ']) {
    const h = await harness({ offers: offersDown, p24CheckoutUrl: value });
    t.after(h.close);
    assert.equal(h.find('a', 'Przejdź do płatności'), undefined, value);
    assert.equal(h.find('button', 'Przejdź do płatności').props.disabled, true, value);
  }
});

test('with packages not launched the screen never offers the automatic payment form', async t => {
  // Manual fulfilment is a decision, not an API failure: the offers endpoint is
  // not even consulted, so the live "Zamawiam i płacę" flow cannot appear.
  const h = await harness({ packagesEnabled: false, offers: () => { throw Error('must not be called'); } });
  t.after(h.close);
  // The decisive assertion: the endpoint is never consulted, so this fails if
  // the flag is ignored and the screen merely falls back on an API error.
  assert.equal(h.offerReads(), 0, 'the offers endpoint is not consulted at all');
  assert.equal(h.find('button', 'Zamawiam'), undefined);
  assert.ok(h.find('h2', '300'), 'the package summary is shown instead');
  assert.ok(h.find('p', 'operator po potwierdzeniu wpłaty'));
});

test('an unapproved policy quota blocks the purchase instead of pairing it with the approved price', async t => {
  const h = await harness({ offers: offersDown, p24CheckoutUrl: 'https://pay.fixture.invalid/x', fallbackCredits: 45 });
  t.after(h.close);
  assert.equal(h.find('a', 'Przejdź do płatności'), undefined);
  assert.equal(h.find('button', 'Przejdź do płatności').props.disabled, true);
  assert.ok(h.find('p', 'różni się od zatwierdzonej oferty'));
});

test('with online payment unconfigured the manual proforma route is offered', async t => {
  const h = await harness({ offers: offersDown });
  t.after(h.close);
  assert.equal(h.find('a', 'Przejdź do płatności'), undefined);
  const mail = h.find('a', 'napisz do nas');
  assert.ok(mail, 'proforma contact offered');
  assert.match(mail.props.href, /^mailto:pomoc@skillcheck\.pl\?subject=/);
  assert.ok(h.find('a', 'formularza kontaktowego'));
});
