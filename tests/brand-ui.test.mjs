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
