// SC-020-A — wygląd w marce klienta: wyłącznie marka klienta, stała stopka
// prawna, kolory tylko ze zwalidowanej konfiguracji, treść klienta escapowana.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire, Module } from 'node:module';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHash } from 'node:crypto';
import * as brandConfig from '../lib/brand-config.ts';
import * as legal from '../lib/legal.ts';

function loadComponent(file, mocks) {
  const path = fileURLToPath(new URL(`../${file}`, import.meta.url));
  const mod = new Module(path); mod.filename = path;
  mod.paths = Module._nodeModulePaths(fileURLToPath(new URL('../', import.meta.url)));
  const require = createRequire(path);
  mod.require = id => id in mocks ? mocks[id] : require(id);
  mod._compile(ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, path);
  return mod.exports;
}
const frame = loadComponent('app/components/brand/brand-frame.tsx', {
  '../../../lib/brand-config': brandConfig, '../../../lib/legal': legal, './brand-frame.module.css': new Proxy({}, { get: (_, k) => String(k) }),
});
const config = {
  ...structuredClone(brandConfig.DEFAULT_BRAND_CONFIG), brandName: 'Acme & Synowie',
  candidatePanel: { headline: 'Witamy w Acme', intro: 'Opis "zadania"' },
};

test('branded recruiter frame shows only the customer brand plus the fixed legal notice', () => {
  const html = renderToStaticMarkup(createElement(frame.BrandFrame, {
    config, controllerName: 'Acme Sp. z o.o.', homeHref: '/dashboard/x', logoHref: '/dashboard/x/marka/zasob/y',
  }, createElement('main', null, 'Treść')));
  assert.match(html, /Acme &amp; Synowie/);
  assert.match(html, /--brand-primary:#1f3a5f/);
  assert.match(html, /<img[^>]+src="\/dashboard\/x\/marka\/zasob\/y"/);
  assert.match(html, /data-legal-notice/);
  assert.match(html, /Administratorem danych osobowych kandydatów jest Acme Sp. z o.o./);
  assert.ok(html.includes(legal.COMPANY.name), 'platform operator is always named');
  assert.doesNotMatch(html, /SkillCheck/i, 'no SkillCheck brand inside the white-label frame');
  assert.match(html, /<main>Treść<\/main>/);
});

test('candidate panel preview uses the customer copy, escaped, with the same legal notice', () => {
  const html = renderToStaticMarkup(createElement(frame.CandidatePanelPreview, {
    config: { ...config, candidatePanel: { headline: '<script>x</script>', intro: '' } }, controllerName: 'Acme', logoHref: null,
  }));
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /data-legal-notice/);
  assert.doesNotMatch(html, /SkillCheck/i);
  assert.doesNotMatch(html, /<img/, 'no logo element without a logo');
});

test('a config that bypassed validation cannot inject CSS through colours', () => {
  const bad = { ...config, colors: { ...config.colors, primary: 'red;background:url(//evil.example)' } };
  assert.throws(() => renderToStaticMarkup(createElement(frame.BrandFrame, {
    config: bad, controllerName: 'Acme', homeHref: '/', logoHref: null,
  }, null)));
});

test('the company layout and asset route keep the documented safety properties', () => {
  const layout = readFileSync(new URL('../app/dashboard/[companyId]/layout.tsx', import.meta.url), 'utf8');
  assert.match(layout, /if \(!brand\) return children;/, 'no published brand = unchanged panel');
  const route = readFileSync(new URL('../app/dashboard/[companyId]/marka/zasob/[assetId]/route.ts', import.meta.url), 'utf8');
  assert.match(route, /validateBrandAsset\(bytes/, 'served bytes are re-validated');
  assert.match(route, /createHash\("sha256"\)/, 'served bytes match the registered hash');
  assert.doesNotMatch(route + layout, /service_role|SERVICE_ROLE/);
  const actions = readFileSync(new URL('../app/dashboard/[companyId]/marka/actions.ts', import.meta.url), 'utf8');
  assert.match(actions, /validateBrandAsset\(bytes, kind\)[\s\S]*storage\.from\(BRAND_ASSET_BUCKET\)\.upload/, 'validate before upload');
  assert.match(actions, /upsert: false/);
  const server = readFileSync(new URL('../lib/brand-server.ts', import.meta.url), 'utf8');
  assert.match(server, /parseBrandConfig\(row\.config\)/, 'published config is validated again on read');
});

test('asset route serves only re-validated bytes that match the registration, with sandbox headers', async () => {
  const companyId = '11111111-2222-4333-8444-555555555555', assetId = '66666666-7777-4888-8999-000000000000';
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
  const evil = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  let scenario;
  const client = {
    auth: { getUser: async () => ({ data: { user: scenario.user === false ? null : { id: 'u' } } }) },
    rpc: async (name, args) => {
      assert.equal(name, 'brand_asset'); assert.deepEqual(args, { target_company: companyId, target_asset: assetId });
      return scenario.rpc ?? { data: [{ object_path: `${companyId}/logo/${assetId}.svg`, mime: scenario.mime ?? 'image/svg+xml', kind: 'logo',
        byte_size: scenario.size ?? scenario.bytes.length, sha256: scenario.sha ?? sha(scenario.bytes) }], error: null };
    },
    storage: { from: bucket => { assert.equal(bucket, 'brand-assets');
      return { download: async () => ({ data: new Blob([scenario.bytes]), error: null }) }; } },
  };
  const route = loadComponent('app/dashboard/[companyId]/marka/zasob/[assetId]/route.ts', {
    '../../../../../../lib/brand-config': brandConfig,
    '../../../../../../lib/supabase/server': { createClient: async () => client },
  });
  const previous = process.env.WHITE_LABEL_ENABLED;
  process.env.WHITE_LABEL_ENABLED = 'true';
  try {
    const call = (company = companyId, asset = assetId) => route.GET(new Request('https://x.test/'), { params: Promise.resolve({ companyId: company, assetId: asset }) });
    scenario = { bytes: svg };
    const ok = await call();
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/svg+xml');
    assert.match(ok.headers.get('content-security-policy'), /sandbox/);
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(new Uint8Array(await ok.arrayBuffer()), svg);
    for (const bad of [
      { bytes: evil },                                   // unsafe content stored directly in Storage
      { bytes: svg, sha: 'a'.repeat(64) },               // content differs from the registration
      { bytes: svg, size: svg.length + 1 },              // size differs
      { bytes: svg, mime: 'image/png' },                 // registered type differs from the content
      { bytes: svg, user: false },                       // no session
      { bytes: svg, rpc: { data: null, error: { message: 'brand_forbidden' } } }, // not a member
      { bytes: svg, rpc: { data: [], error: null } },    // asset of another company
    ]) {
      scenario = bad;
      assert.equal((await call()).status, 404, JSON.stringify({ ...bad, bytes: bad.bytes.length }));
    }
    scenario = { bytes: svg };
    assert.equal((await call('../x', assetId)).status, 404);
    assert.equal((await call(companyId, 'x')).status, 404);
    process.env.WHITE_LABEL_ENABLED = 'false';
    assert.equal((await call()).status, 404, 'feature off -> nothing served');
  } finally {
    if (previous === undefined) delete process.env.WHITE_LABEL_ENABLED; else process.env.WHITE_LABEL_ENABLED = previous;
  }
});
