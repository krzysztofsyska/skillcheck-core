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

function billingAccess({ userId = ownerId, balance = null, error = null } = {}) {
  const calls = [];
  const client = {
    async rpc(name, args) {
      calls.push({ name, args });
      return { data: balance, error };
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
  }).default;
}

function billingAction(access) {
  return load('app/dashboard/[companyId]/billing/actions.ts', {
    'next/cache': { revalidatePath() {} },
    'next/navigation': { redirect },
    '../../../../lib/company-access': access,
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
    assert.match(ownerHtml, /href="\/rozmowa"/);
    assert.deepEqual(owner.calls, [{ name: 'sc19_get_balance', args: { target_company: companyId } }]);

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

    for (const [code, status] of [['23505', 'taken'], ['22023', 'invalid'], ['42501', 'verify'], ['XX000', 'failed']]) {
      const fx = billingAccess({ error: { code, message: 'PRIVATE nip secret' } });
      const url = await redirected(billingAction(fx.access), form('526-104-08-28'));
      assert.equal(url, `/dashboard/${companyId}/billing?status=${status}`);
      assert.deepEqual(fx.calls, [{ name: 'sc19_claim_trial', args: { target_company: companyId, supplied_nip: '526-104-08-28' } }]);
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
