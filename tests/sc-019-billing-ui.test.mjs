import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const companyId = '00000000-0000-4000-8000-000000000011';
const ownerId = '00000000-0000-4000-8000-000000000001';
const memberId = '00000000-0000-4000-8000-000000000002';

function load(file, mocks = {}) {
  const path = new URL('../' + file, import.meta.url).pathname;
  const mod = new Module(path);
  mod.filename = path;
  mod.paths = Module._nodeModulePaths(new URL('../', import.meta.url).pathname);
  const req = createRequire(path);
  mod.require = id => id in mocks ? mocks[id] : req(id);
  mod._compile(ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, path);
  return mod.exports;
}

function redirect(url) {
  const error = new Error('NEXT_REDIRECT');
  error.url = url;
  throw error;
}

function query(result) {
  const builder = {
    select() { return builder; },
    eq() { return builder; },
    order() { return builder; },
    limit() { return builder; },
    maybeSingle: async () => result,
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
  };
  return builder;
}

function withFlag(value, run) {
  const previous = process.env.SC19_PACKAGES_ENABLED;
  if (value === undefined) delete process.env.SC19_PACKAGES_ENABLED;
  else process.env.SC19_PACKAGES_ENABLED = value;
  return Promise.resolve(run()).finally(() => {
    if (previous === undefined) delete process.env.SC19_PACKAGES_ENABLED;
    else process.env.SC19_PACKAGES_ENABLED = previous;
  });
}

function billingAccess({ userId = ownerId, balance = null, error = null, catalog = [{ plan: 'FREE', credits: 3 }, { plan: 'PRESELEKCJA', credits: 12 }], catalogError = null } = {}) {
  const calls = [];
  const client = {
    async rpc(name, args) {
      calls.push({ name, args });
      return name === 'sc19_package_sizes' ? { data: catalog, error: catalogError } : { data: balance, error };
    },
  };
  const access = {
    companyAccess: async () => ({
      client,
      company: { owner_id: ownerId, name: 'Acme' },
      user: { id: userId },
    }),
  };
  return { calls, client, access };
}

function billingPage(access) {
  return load('app/dashboard/[companyId]/billing/page.tsx', {
    'next/link': ({ children, href }) => React.createElement('a', { href }, children),
    '../../../../lib/company-access': access,
    './actions': { activateSc19Free() {} },
    '../../../../lib/sc19-package-sizes': load('lib/sc19-package-sizes.ts'),
  }).default;
}

function billingAction(access) {
  // SC-FREE-AUTO-001: the action now goes through the automatic-FREE flow. Only
  // the thin 'server-only' adapter is substituted, so the real flow code runs.
  // No SC19_TRIAL_AUTO_SECRET is set here, so the register is never consulted
  // and the behaviour is the pre-automation one: claim, otherwise manual review.
  const flow = load('lib/sc19-trial-auto-flow.ts');
  return load('app/dashboard/[companyId]/billing/actions.ts', {
    'next/cache': { revalidatePath() {} },
    'next/navigation': { redirect },
    '../../../../lib/company-access': access,
    '../../../../lib/sc19-trial-auto-server': { activateFreeWithWhitelist: flow.activateFreeWithWhitelist, trialStore: flow.trialStore },
  }).activateSc19Free;
}

async function redirected(action, form) {
  try {
    await action(form);
  } catch (error) {
    if (error.url) return error.url;
    throw error;
  }
  assert.fail('expected a redirect');
}

function form(nip = '5261040828') {
  const data = new FormData();
  data.set('companyId', companyId);
  data.set('nip', nip);
  return data;
}

test('billing page stays closed and does not read a balance while packages are off', async () => {
  await withFlag(undefined, async () => {
    const fx = billingAccess();
    const html = renderToStaticMarkup(await billingPage(fx.access)({
      params: Promise.resolve({ companyId }),
      searchParams: Promise.resolve({}),
    }));
    assert.match(html, /przygotowywane/);
    assert.doesNotMatch(html, /name="nip"|Aktywuj FREE/);
    assert.equal(fx.calls.length, 0);
    const url = await redirected(billingAction(fx.access), form());
    assert.equal(url, '/dashboard');
    assert.equal(fx.calls.length, 0);
  });
});

test('billing page shows the owner form only to the owner and hides it once a balance exists', async () => {
  await withFlag('true', async () => {
    const owner = billingAccess();
    const ownerHtml = renderToStaticMarkup(await billingPage(owner.access)({
      params: Promise.resolve({ companyId }),
      searchParams: Promise.resolve({ status: 'taken' }),
    }));
    assert.match(ownerHtml, /name="nip"/);
    assert.match(ownerHtml, /Aktywuj FREE/);
    assert.match(ownerHtml, /Darmowa pula została już przypisana/);
    // The FREE copy now explains the automatic VAT-register check instead of
    // sending the company to the contact form for a manual verification.
    assert.match(ownerHtml, /wykazie podatników VAT/);
    // But the MANUAL PATH MUST STAY REACHABLE FROM THE FREE BLOCK (bot review
    // finding, kept asserted): when the register does not confirm or does not
    // answer, the company must have somewhere to go. Asserted on the FREE part
    // of the page only, so the PRESELEKCJA block's own link cannot satisfy it.
    const freeBlock = ownerHtml.slice(ownerHtml.indexOf('FREE —'), ownerHtml.indexOf('PRESELEKCJA'));
    assert.ok(freeBlock.length > 100, 'the FREE block must be on the page to assert about it');
    assert.match(freeBlock, /href="\/rozmowa"/);
    assert.deepEqual(owner.calls, [{ name: 'sc19_package_sizes', args: undefined }, { name: 'sc19_get_balance', args: { target_company: companyId } }]);
    assert.match(ownerHtml, /FREE — 3 analiz CV/);
    assert.match(ownerHtml, /PRESELEKCJA — 12 analiz CV/);
    assert.doesNotMatch(ownerHtml, /5 analiz CV|60 analiz CV/);

    const member = billingAccess({ userId: memberId });
    const memberHtml = renderToStaticMarkup(await billingPage(member.access)({
      params: Promise.resolve({ companyId }),
      searchParams: Promise.resolve({}),
    }));
    assert.match(memberHtml, /FREE może aktywować właściciel firmy/);
    assert.doesNotMatch(memberHtml, /name="nip"/);

    const funded = billingAccess({ balance: [{ plan: 'FREE', available: 4 }] });
    const fundedHtml = renderToStaticMarkup(await billingPage(funded.access)({
      params: Promise.resolve({ companyId }),
      searchParams: Promise.resolve({ status: 'not-a-status' }),
    }));
    assert.match(fundedHtml, /FREE/);
    assert.match(fundedHtml, /4/);
    assert.match(fundedHtml, /analiz CV do wykorzystania/);
    assert.doesNotMatch(fundedHtml, /name="nip"|not-a-status/);
  });
});

test('FREE activation maps the owner, the NIP and the RPC error without calling the database for a rejected form', async () => {
  await withFlag('true', async () => {
    const badId = billingAccess();
    const wrong = new FormData();
    wrong.set('companyId', 'not-a-company');
    wrong.set('nip', '5261040828');
    assert.equal(await redirected(billingAction(badId.access), wrong), '/dashboard');
    assert.equal(badId.calls.length, 0);

    const member = billingAccess({ userId: memberId });
    assert.equal(await redirected(billingAction(member.access), form()), `/dashboard/${companyId}/billing?status=forbidden`);
    assert.equal(member.calls.length, 0);

    const longNip = billingAccess();
    assert.equal(await redirected(billingAction(longNip.access), form('1'.repeat(21))), `/dashboard/${companyId}/billing?status=invalid`);
    assert.equal(longNip.calls.length, 0);

    // 42501 now has two meanings and they must not be confused: a company that
    // is simply not verified yet goes to manual review (the automatic path would
    // take over here if it were configured), while any other refusal is a real
    // anomaly and must not claim the company was queued for review.
    const cases = [
      ['23505', 'PRIVATE nip secret', 'taken'],
      ['22023', 'PRIVATE nip secret', 'invalid'],
      ['42501', 'sc19_trial_requires_verified_company', 'manual'],
      ['42501', 'PRIVATE nip secret', 'failed'],
      ['XX000', 'PRIVATE nip secret', 'failed'],
    ];
    for (const [code, message, status] of cases) {
      const fx = billingAccess({ error: { code, message } });
      const url = await redirected(billingAction(fx.access), form('526-104-08-28'));
      assert.equal(url, `/dashboard/${companyId}/billing?status=${status}`, `${code} ${message}`);
      // Every call carries the CANONICAL ten digits, never the separators the
      // field accepts: the database normalizes before it rebuilds the signed
      // payload, so signing the raw input made every formatted NIP fail.
      for (const call of fx.calls) assert.equal(call.args.supplied_nip, '5261040828', `${code} ${message}`);
      // No network call, and no signed RPC: without the server secret nothing
      // past the unsigned precheck is attempted, so behaviour is unchanged.
      const expected = status === 'manual'
        ? ['sc19_claim_trial', 'sc19_auto_free_precheck']
        : ['sc19_claim_trial'];
      assert.deepEqual(fx.calls.map(call => call.name), expected, `${code} ${message}`);
    }

    const ok = billingAccess();
    assert.equal(await redirected(billingAction(ok.access), form()), `/dashboard/${companyId}/billing?status=activated`);
    assert.deepEqual(ok.calls[0].args, { target_company: companyId, supplied_nip: '5261040828' });
  });
});

test('company dashboard links to billing only while the package flag is on', async () => {
  const access = {
    companyAccess: async () => ({
      client: { from: () => query({ data: [], error: null, count: 0 }) },
      company: { name: 'Acme', owner_id: ownerId },
      canEdit: true,
    }),
  };
  const page = load('app/dashboard/[companyId]/page.tsx', {
    'next/link': ({ children, href }) => React.createElement('a', { href }, children),
    '../../../lib/company-access': access,
    './forms': { ProfileForm() { return null; }, RecruitmentForm() { return null; } },
  }).default;
  await withFlag(undefined, async () => {
    const html = renderToStaticMarkup(await page({ params: Promise.resolve({ companyId }) }));
    assert.doesNotMatch(html, /\/billing/);
  });
  await withFlag('true', async () => {
    const html = renderToStaticMarkup(await page({ params: Promise.resolve({ companyId }) }));
    assert.match(html, new RegExp(`/dashboard/${companyId}/billing`));
  });
});


test('billing never presents a grant form with an unavailable or invalid policy', async () => {
  await withFlag('true', async () => {
    for (const options of [
      {catalog: null}, {catalog: []}, {catalogError: {code:'PGRST202'}},
      {catalog:[{plan:'FREE',credits:0},{plan:'PRESELEKCJA',credits:12}]},
      {catalog:[{plan:'FREE',credits:3},{plan:'PRESELEKCJA',credits:12.5}]},
    ]) {
      const fx=billingAccess(options);
      await assert.rejects(billingPage(fx.access)({params:Promise.resolve({companyId}),searchParams:Promise.resolve({})}), /Nie można odczytać wielkości pakietów/);
      assert.deepEqual(fx.calls,[{name:'sc19_package_sizes',args:undefined}]);
    }
  });
});


// U1 z przeglądu 6c12d2d: operator podejmuje decyzję na podstawie powodu odmowy,
// więc każdy kod, który potrafi trafić do jego raportu, musi mieć polską treść.
// Bez tego fallback pokazuje mu surowy kod (`powód: NIP_RELEASED`) dokładnie tam,
// gdzie jest potrzebna jego decyzja. Kody zbieramy ze źródeł, nie z listy ręcznej,
// żeby nowy kod w migracji albo w kliencie wykazu wymusił tu tłumaczenie.
test('every automatic-check refusal code the operator can see has Polish copy', () => {
  const sources = [
    'supabase/migrations/20261103090000_sc19_auto_trial_marketing_consent.sql',
    'lib/sc19-trial-auto.ts',
    'lib/sc19-trial-auto-flow.ts',
  ].map(f => readFileSync(new URL('../' + f, import.meta.url), 'utf8')).join('\n');
  const codes = new Set(
    [...sources.matchAll(/'((?:NIP|WHITELIST|STATUS|AUTO|NO_SERVER)_[A-Z_]+|COOLDOWN|IN_FLIGHT|ANOTHER_NIP_TRIED)'/g)]
      .map(m => m[1]),
  );
  assert.ok(codes.has('NIP_RELEASED'), 'the release guard code is among the sources');
  assert.ok(codes.size >= 12, `expected the known refusal codes, found ${codes.size}`);
  const page = readFileSync(new URL('../app/operator/billing/page.tsx', import.meta.url), 'utf8');
  const block = page.match(/const autoReasons: Record<string, string> = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'the operator page still carries the refusal-code dictionary');
  const translated = new Set([...block[1].matchAll(/^\s*([A-Z_]+):/gm)].map(m => m[1]));
  const missing = [...codes].filter(c => !translated.has(c)).sort();
  assert.deepEqual(missing, [], `refusal codes without Polish copy: ${missing.join(', ')}`);
});
