import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Exercise the shipped component and its event handlers with deterministic
// browser I/O. This is a component-contract test, not a browser/processor E2E.
// Resolve the component's own relative imports from its real directory, so the
// shipped shared net/VAT module is exercised rather than a test double.
const require = createRequire(new URL('../app/dashboard/[companyId]/billing/checkout/checkout.tsx', import.meta.url));
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

async function harness({ offers = [offer()], entries = [], checkout, order, clientNow, storageUnavailable=false,
  checkoutAvailable = true, offersResponse, sandbox = false, search = '', statusOnly = false,
  recruitmentId, currentCompany = companyId } = {}) {
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
    exports: {}, Intl, URLSearchParams, Date:clientNow===undefined?Date:class extends Date {static now(){return clientNow;}}, AbortController,
    // Node resolves a TypeScript source only with its extension; Next adds it.
    require(name) { return name === 'react' ? react : require(name.startsWith('.') ? name + '.ts' : name); },
    crypto: { randomUUID() { return `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`; } },
    sessionStorage: {
      getItem: key => {if(storageUnavailable)throw Error('blocked');return storage.get(key) ?? null;},
      setItem: (key, value) => {if(storageUnavailable)throw Error('blocked');storage.set(key, value);},
      removeItem: key => {if(storageUnavailable)throw Error('blocked');storage.delete(key);},
    },
    window: { location: { search, assign: url => redirects.push(url) } },
    async fetch(url, options) {
      if (url.startsWith('/api/billing/offers?')) {
        offerReads++;
        if (offersResponse) return offersResponse(offerReads);
        return ok({ checkoutAvailable, offers:typeof offers==='function'?offers(offerReads):offers });
      }
      if (url === '/api/billing/checkout') {
        const input = JSON.parse(options.body);
        posts.push(input);
        return checkout(input, posts.length);
      }
      if (url.startsWith('/api/billing/orders/')) {
        statusReads.push(url);
        return order(url,options);
      }
      throw Error(`Unexpected request: ${url}`);
    },
  };
  runInNewContext(compiled, context);
  function render() {
    cursor = 0;
    tree = context.exports.default({ companyId: currentCompany, recruitmentId, sandbox, statusOnly });
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

test('offers load without a provider: full summary with net/VAT/gross and a disabled pay button',async t=>{
 const h=await harness({checkoutAvailable:false,checkout:async()=>{throw Error('must not POST while checkout is unavailable');}});
 t.after(h.close);
 const amounts=h.find('table');
 assert.ok(amounts,'the order summary is rendered');
 const rows=JSON.stringify(amounts);
 // 12345 gross = 10037 net + 2308 VAT at 23%; gross is never recomputed.
 for(const expected of ['Pakiet','PRESELEKCJA','Liczba analiz CV','100,37','23,08','123,45'])
  assert.ok(rows.includes(expected),`summary is missing ${expected}`);
 assert.ok(h.find('details'),'the terms text is rendered');
 assert.ok(h.find('input'),'the terms-acceptance checkbox is rendered');
 const button=h.find('button','Zamawiam');
 assert.ok(button,'the pay button is rendered');
 assert.equal(button.props.disabled,true,'the pay button is disabled while payment is being activated');
 h.accept();
 assert.equal(h.find('button','Zamawiam').props.disabled,true,'accepting the terms does not enable it');
 await h.find('button','Zamawiam').props.onClick();
 assert.equal(h.posts.length,0,'no checkout is ever posted while payment is unavailable');
 assert.deepEqual(h.redirects,[]);
 assert.ok(h.find('p','w trakcie uruchamiania'),'a clear Polish explanation is shown');
});

test('a missing checkoutAvailable flag is treated as unavailable and never as a working payment',async t=>{
 const h=await harness({offersResponse:()=>ok({offers:[offer()]}),checkout:async()=>{throw Error('must not POST');}});
 t.after(h.close);h.accept();
 assert.equal(h.find('button','Zamawiam').props.disabled,true);
 assert.equal(h.posts.length,0);
});

test('a server that answers SC19_PAYMENTS_DISABLED closes the button without losing the summary',async t=>{
 const h=await harness({checkout:async()=>({ok:false,json:async()=>({error:'SC19_PAYMENTS_DISABLED'})})});
 t.after(h.close);h.accept();
 assert.equal(h.find('button','Zamawiam').props.disabled,false,'the flag said checkout was available');
 await h.click('Zamawiam');
 assert.equal(h.posts.length,1);
 assert.deepEqual(h.redirects,[]);
 assert.equal(h.find('button','Zamawiam').props.disabled,true);
 assert.ok(h.find('table'),'the price and summary stay visible');
 assert.ok(h.find('p','w trakcie uruchamiania'));
});

// The offer READ itself can be refused: no provider and no catalog, which is what
// /api/billing/offers answers while SC19_PACKAGES_ENABLED is off. That is not a
// transport failure, so the page must say payments are being switched on rather
// than invite a pointless retry, and must never show a priced order form.
test('an offer read refused with SC19_PAYMENTS_DISABLED is explained, not reported as a load failure',async t=>{
 const h=await harness({offersResponse:()=>({ok:false,status:503,json:async()=>({error:'SC19_PAYMENTS_DISABLED'})}),
  checkout:async()=>{throw Error('must not POST');}});
 t.after(h.close);
 assert.ok(h.find('p','w trakcie uruchamiania'),'the switching-on explanation is shown');
 assert.equal(h.find('p','Nie udało się wczytać oferty'),undefined,'not presented as a failed load');
 assert.equal(h.find('table'),undefined,'no priced order summary without an offer');
 assert.equal(h.find('button','Zamawiam'),undefined);
 assert.equal(h.posts.length,0);
});

test('a company still awaiting verification is told so, not asked to retry',async t=>{
 // A brand-new company has no approval row, so the offer read is refused with
 // 403. Refreshing can never fix that, and the copy must not suggest it can.
 const h=await harness({offersResponse:()=>({ok:false,status:403,json:async()=>({error:'SC19_PAYMENT_FORBIDDEN'})}),
  checkout:async()=>{throw Error('must not POST');}});
 t.after(h.close);
 assert.ok(h.find('p','czeka na weryfikację'),'the real next step is named');
 assert.ok(h.find('p','pomoc@skillcheck.pl'),'a way to ask for it is given');
 assert.equal(h.find('p','Nie udało się wczytać oferty'),undefined,'not presented as a failed load');
 assert.equal(h.find('button','Zamawiam'),undefined);
 assert.equal(h.posts.length,0);
});

test('an offer read that fails for any other reason still asks the visitor to retry',async t=>{
 const h=await harness({offersResponse:()=>({ok:false,status:503,json:async()=>({error:'SC19_PAYMENT_RETRY'})}),
  checkout:async()=>{throw Error('must not POST');}});
 t.after(h.close);
 assert.ok(h.find('p','Nie udało się wczytać oferty'));
 assert.equal(h.find('button','Zamawiam'),undefined);
});

test('an available checkout still renders the breakdown and keeps working',async t=>{
 const h=await harness({checkout:async()=>ok({orderId:'order-a',status:'awaiting_payment',checkoutUrl:'https://pay.fixture.invalid/a'})});
 t.after(h.close);
 assert.ok(JSON.stringify(h.find('table')).includes('123,45'));
 assert.ok(!h.find('p','w trakcie uruchamiania'));
 h.accept();await h.click('Zamawiam');
 assert.deepEqual(h.redirects,['https://pay.fixture.invalid/a']);
});

test('net and VAT sent by the server are displayed instead of being recomputed in the browser',async t=>{
 const served={...offer(),amountMinor:30000,netMinor:24390,vatMinor:5610,vatBasisPoints:2300};
 const h=await harness({offers:[served],checkoutAvailable:false});
 t.after(h.close);
 const rows=JSON.stringify(h.find('table'));
 for(const expected of ['243,90','56,10','300,00'])assert.ok(rows.includes(expected),`missing ${expected}`);
});

test('return from the sandbox requests the authenticated order status and cannot claim success from the URL', async t => {
  const id = '00000000-0000-4000-8000-000000000003';
  let method;
  const h = await harness({ sandbox:true, search:`?p24=${id}&success=true`, order:async (url,options) => {
    assert.ok(url.includes(id)); method=options.method; return ok({status:'awaiting_payment'});
  } });
  t.after(h.close);
  assert.equal(method,'POST');
  assert.equal(h.statusReads.length,1);
  assert.equal(h.find('button','Kup kolejny'),undefined);
});

test('flag-off sandbox return reads the pending order without loading offers or selling a new package', async t => {
  const id = '00000000-0000-4000-8000-000000000003';
  const h = await harness({ sandbox:true, statusOnly:true, search:`?p24=${id}`,
    offersResponse:()=>assert.fail('status-only must not load offers'), order:async()=>ok({status:'paid',credits:60}) });
  t.after(h.close);
  assert.equal(h.statusReads.length,1);
  assert.equal(h.find('button','Zamawiam'),undefined);
  assert.equal(h.find('button','Kup kolejny'),undefined);
  assert.ok(h.find('button','Sprawdź status'));
});

const recruitment = 'bbbbbbbb-1111-4222-8333-444444444444';
const returnOrder = 'aaaaaaaa-1111-4222-8333-444444444444';
const returnKey = (company = companyId, id = returnOrder) => `sc19:recruitment:${company}:${id}`;

test('checkout remembers a recruitment per order and restores navigation after the external return', async t => {
  const departing = await harness({ recruitmentId: recruitment.toUpperCase(), checkout: async () =>
    ok({orderId:returnOrder,status:'awaiting_payment',checkoutUrl:'https://pay.fixture.invalid/order'}) });
  t.after(departing.close);
  departing.accept(); await departing.click('Zamawiam');
  assert.equal(departing.storage.get(returnKey()), recruitment);
  assert.deepEqual(departing.redirects, ['https://pay.fixture.invalid/order']);
  assert.deepEqual(Object.keys(departing.posts[0]).sort(), ['companyId','offerId','requestId','termsRevision']);
  const returned = await harness({ sandbox:true, search:`?p24=${returnOrder}`, entries:[...departing.storage],
    order:async()=>ok({status:'awaiting_payment'}) });
  t.after(returned.close);
  assert.equal(returned.find('a','Wróć do rekrutacji').props.href, `/dashboard/${companyId}/recruitments/${recruitment}`);
  assert.equal(returned.statusReads.length, 1);
  assert.ok(returned.find('p','Czekamy na potwierdzenie'));
  assert.ok(returned.find('p','Powrót ze strony operatora nie jest potwierdzeniem'));
  assert.equal(returned.find('button','Kup kolejny'), undefined);
});

test('return navigation works with packages off without loading offers', async t => {
  const h = await harness({ sandbox:true,statusOnly:true,search:`?p24=${returnOrder}`,
    entries:[[returnKey(),recruitment]],offersResponse:()=>assert.fail('no offers'),
    order:async()=>ok({status:'awaiting_payment'}) });
  t.after(h.close);
  assert.equal(h.find('a','Wróć do rekrutacji').props.href, `/dashboard/${companyId}/recruitments/${recruitment}`);
  assert.equal(h.find('button','Zamawiam'),undefined);
});

test('return navigation never crosses company or order scopes', async t => {
  for (const entries of [
    [[returnKey('cccccccc-1111-4222-8333-444444444444'),recruitment]],
    [[returnKey(companyId,'dddddddd-1111-4222-8333-444444444444'),recruitment]],
  ]) {
    const h=await harness({sandbox:true,search:`?p24=${returnOrder}`,entries,order:async()=>ok({status:'awaiting_payment'})});
    t.after(h.close); assert.equal(h.find('a','Wróć do rekrutacji'),undefined);
  }
});

test('missing, malformed or inaccessible return hints fall back without affecting order status', async t => {
  for(const saved of [null,'','https://evil.example','//evil.example','../operator',recruitment+'/../operator',JSON.stringify([recruitment])]) {
    const h=await harness({sandbox:true,search:`?p24=${returnOrder}`,entries:saved===null?[]:[[returnKey(),saved]],
      order:async()=>ok({status:'awaiting_payment'})});
    t.after(h.close); assert.equal(h.find('a','Wróć do rekrutacji'),undefined); assert.equal(h.statusReads.length,1);
  }
  const h=await harness({sandbox:true,search:`?p24=${returnOrder}`,storageUnavailable:true,
    order:async()=>ok({status:'awaiting_payment'})});
  t.after(h.close); assert.equal(h.find('a','Wróć do rekrutacji'),undefined); assert.equal(h.statusReads.length,1);
});

test('blocked storage or invalid recruitment hints cannot prevent a checkout redirect', async t => {
  for(const options of [{recruitmentId:recruitment,storageUnavailable:true},{recruitmentId:'https://evil.example'},
    {recruitmentId:[recruitment]},{recruitmentId:undefined}]) {
    const h=await harness({...options,checkout:async()=>ok({orderId:returnOrder,status:'awaiting_payment',checkoutUrl:'https://pay.fixture.invalid/order'})});
    t.after(h.close);h.accept();await h.click('Zamawiam');
    assert.deepEqual(h.redirects,['https://pay.fixture.invalid/order']);
    assert.equal(h.storage.has(returnKey()),false);
  }
});

test('stored context alone never creates a return link without a sandbox order return', async t => {
  for(const options of [{sandbox:false,search:`?p24=${returnOrder}`},{sandbox:true,search:''},{sandbox:true,search:'?p24=invalid'}]) {
    const h=await harness({...options,entries:[[returnKey(),recruitment]]});
    t.after(h.close);assert.equal(h.find('a','Wróć do rekrutacji'),undefined);assert.equal(h.statusReads.length,0);
  }
});

// The paragraph below the accepted offer terms must say the same thing the terms
// say. Until PR #413 it claimed the operator's confirmation was the only trigger
// ("Analizy przyznajemy po potwierdzeniu płatności przez operatora, zwykle w
// ciągu kilku minut."), which is false for a traditional transfer (Regulamin
// § 7.3) and contradicted the corrected terms rendered one line above it, both
// under a single acceptance checkbox.
test('the delivery sentence under the terms is true for both payment branches', async t => {
  const h = await harness({ checkoutAvailable: false, checkout: async () => { throw Error('must not POST'); } });
  t.after(h.close);
  const paragraph = h.find('p', 'Płatność online obsługuje Przelewy24');
  assert.ok(paragraph, 'the payment paragraph is rendered under the terms');
  const text = String(paragraph.props.children);
  // Regulamin § 7.3: online — operator confirmation; transfer — our account credited.
  // Regulamin § 8.1: granted "niezwłocznie po potwierdzeniu płatności".
  assert.ok(text.includes('Analizy przyznajemy niezwłocznie po potwierdzeniu płatności'),
    'the § 8.1 trigger is stated');
  assert.ok(text.includes('po zaksięgowaniu wpłaty na naszym rachunku'),
    'the bank-transfer branch of § 7.3 is not left out');
  assert.ok(text.includes('przy płatności online — po jej potwierdzeniu przez operatora'),
    'the online branch of § 7.3 stays, with the operator named');
  assert.ok(text.includes('Zasady reklamacji i odstąpienia opisuje'), 'the § 10–11 pointer stays');
  // The old sentence made the operator the only trigger. It must not come back,
  // in this file or anywhere else the checkout screen renders.
  assert.ok(!source.includes('Analizy przyznajemy po potwierdzeniu płatności przez operatora'),
    'the operator-only delivery claim is gone from the checkout source');
  // And the regulation it has to agree with still says what the sentence claims.
  const regulamin = await readFile(new URL('../docs/legal/v1.0/01_Regulamin_SkillCheck.md', import.meta.url), 'utf8');
  assert.ok(regulamin.includes('niezwłocznie po potwierdzeniu płatności'), 'Regulamin § 8.1 unchanged');
  assert.ok(regulamin.includes('albo z chwilą uznania rachunku bankowego Usługodawcy'),
    'Regulamin § 7.3 still covers the transfer branch');
});

// The sandbox now also runs on the production domain (owner decision 2026-11-11),
// where a test payment grants REAL analyses on the real account. That is the point
// of the verifier's walk, so the screen must say both halves of it plainly: nothing
// is charged, and the analyses are granted anyway. It must promise no payment
// method of its own beyond what the operator offers.
test('the sandbox notice says that nothing is charged AND that the analyses are still granted', async t => {
  const sandbox = await harness({ sandbox:true });
  t.after(sandbox.close);
  const note = sandbox.find('p','Sandboxie Przelewy24');
  assert.ok(note,'the sandbox notice is shown');
  const text = String(note.props.children);
  assert.match(text,/żadne pieniądze nie zostaną pobrane/);
  assert.match(text,/Analizy CV zostaną jednak przyznane na tym koncie/);
  assert.doesNotMatch(text,/proforma|faktur|kart[ąay]|BLIK|przelewem/i);
  const live = await harness({ sandbox:false });
  t.after(live.close);
  assert.equal(live.find('p','Sandboxie Przelewy24'),undefined,'not shown outside the sandbox');
});

// A buyer who abandons an unpaid payment can be left with an order whose provider
// session can no longer be opened; `checkout()` then answers
// SC19_PAYMENT_RECONCILIATION_REQUIRED and the one-unresolved-order rule blocks the
// next purchase. Retrying cannot clear it, so the screen must not invite a retry.
test('an order that can no longer be reconciled is named as such, not offered a retry', async t => {
  const h = await harness({ checkout: async () => ({ ok:false,
    json: async () => ({ error:'SC19_PAYMENT_RECONCILIATION_REQUIRED' }) }) });
  t.after(h.close);
  h.accept();
  await h.click('Zamawiam');
  const message = String(h.find('p','pomoc@skillcheck.pl').props.children);
  assert.match(message,/Ponawianie nie pomoże/);
  assert.equal(h.redirects.length,0);
});

// SC-P24-UNBLOCK-001: the server names a Przelewy24 failure with a fixed code in
// `detail`. The screen shows it next to the generic code so support can tell a
// wrong key from an outage; anything not in the fixed format is never rendered.
test('a named Przelewy24 failure shows its code; anything else in detail is ignored', async t => {
  const failing = detail => harness({ checkout: async () => ({ ok:false, status:503,
    json: async () => ({ error:'SC19_PAYMENT_RETRY', ...(detail === undefined ? {} : { detail }) }) }) });
  const named = await failing('P24_UNAUTHORIZED');
  t.after(named.close);
  named.accept();
  await named.click('Zamawiam');
  assert.match(String(named.find('p','pomoc@skillcheck.pl').props.children), /kod: SC19_PAYMENT_RETRY \/ P24_UNAUTHORIZED\./);
  for (const detail of [undefined, '<b>P24_UNAUTHORIZED</b>', 'Incorrect CRC value', 'P24_unauthorized', 42]) {
    const h = await failing(detail);
    t.after(h.close);
    h.accept();
    await h.click('Zamawiam');
    const message = String(h.find('p','pomoc@skillcheck.pl').props.children);
    assert.match(message, /kod: SC19_PAYMENT_RETRY\.$/, String(detail));
    assert.equal(h.redirects.length, 0);
  }
});

// A lost Przelewy24 answer leaves a session behind: retrying cannot help, so the
// screen says so and names the code instead of the generic "Ponów próbę".
test('an existing Przelewy24 session says that retrying will not help', async t => {
  const h = await harness({ checkout: async () => ({ ok:false, status:503,
    json: async () => ({ error:'SC19_PAYMENT_RETRY', detail:'P24_SESSION_EXISTS' }) }) });
  t.after(h.close);
  h.accept();
  await h.click('Zamawiam');
  const message = String(h.find('p','pomoc@skillcheck.pl').props.children);
  assert.match(message, /Ponawianie nie pomoże/);
  assert.match(message, /kod: P24_SESSION_EXISTS\./);
  assert.doesNotMatch(message, /Ponów próbę/);
  assert.equal(h.redirects.length, 0);
});
