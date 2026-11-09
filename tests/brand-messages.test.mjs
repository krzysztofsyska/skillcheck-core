// SC-020-C — wiadomości do kandydatów w marce klienta: tylko marka klienta,
// stała stopka prawna, escapowanie, walidacja linków, brak wysyłki.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire, Module } from 'node:module';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as brandConfig from '../lib/brand-config.ts';
import * as messages from '../lib/brand-messages.ts';
import { COMPANY } from '../lib/legal.ts';

const { renderBrandMessage, legalFooterLines, disabledTransport, previewMessageInput, BRAND_MESSAGE_KINDS } = messages;
const brand = { ...structuredClone(brandConfig.DEFAULT_BRAND_CONFIG), brandName: 'Acme Kariera',
  colors: { primary: '#0b5d1e', onPrimary: '#ffffff', background: '#ffffff', text: '#111111', accent: '#7a3e00' } };
const input = (overrides = {}) => ({ ...previewMessageInput('competency_invitation', brand, 'Acme Sp. z o.o.'), ...overrides });

test('every message kind renders only the customer brand, with the fixed legal footer', () => {
  for (const kind of BRAND_MESSAGE_KINDS) {
    const result = renderBrandMessage(input({ kind }));
    assert.ok(result.ok, kind);
    const m = result.value;
    assert.equal(m.senderName, 'Acme Kariera');
    assert.match(m.subject, /^Acme Kariera: /);
    for (const part of [m.subject, m.text, m.html]) assert.doesNotMatch(part, /SkillCheck/i, `${kind}: no SkillCheck brand`);
    assert.match(m.html, /background:#0b5d1e/, 'brand colour used');
    const footer = legalFooterLines('Acme Sp. z o.o.');
    assert.equal(m.legalFooter, footer.join('\n'));
    for (const line of footer) {
      assert.ok(m.text.includes(line), `${kind}: footer line in text`);
      assert.ok(m.html.includes(line.replace(/&/g, '&amp;')), `${kind}: footer line in html`);
    }
    assert.match(m.legalFooter, /Administratorem Twoich danych osobowych w tej rekrutacji jest Acme Sp\. z o\.o\./);
    assert.ok(m.legalFooter.includes(COMPANY.name) && m.legalFooter.includes(COMPANY.krs), 'platform operator named');
    assert.match(m.legalFooter, /Decyzje w rekrutacji podejmują ludzie/);
    assert.match(m.legalFooter, /przenoszenia danych, sprzeciwu wobec przetwarzania oraz cofnięcia zgody/);
    assert.match(m.legalFooter, /skontaktuj się z administratorem: Acme Sp\. z o\.o\./);
    assert.doesNotMatch(m.legalFooter, /odpowiedz na tę wiadomość/, 'no assumption about where replies go');
  }
});

test('the legal footer does not depend on brand or message data', () => {
  const plain = renderBrandMessage(input({ brand: null })).value;
  const branded = renderBrandMessage(input()).value;
  const other = renderBrandMessage(input({ kind: 'process_closed', positionTitle: 'Inne', candidateFirstName: null })).value;
  assert.equal(plain.legalFooter, branded.legalFooter);
  assert.equal(other.legalFooter, branded.legalFooter);
  // Without a published brand the sender is the customer company, never SkillCheck.
  assert.equal(plain.senderName, 'Acme Sp. z o.o.');
  assert.doesNotMatch(plain.html + plain.subject, /SkillCheck/i);
  // A brand config cannot carry footer overrides: unknown keys are rejected.
  assert.equal(renderBrandMessage(input({ brand: { ...brand, legalFooter: 'x' } })).ok, false);
});

test('inputs are validated and escaped; only https links are allowed', () => {
  for (const bad of ['javascript:alert(1)', 'http://example.com/x', 'data:text/html,x', 'https://user:pw@example.com/', 'nie-link', '']) {
    const result = renderBrandMessage(input({ actionUrl: bad }));
    assert.equal(result.ok, false, bad);
  }
  assert.equal(renderBrandMessage(input({ deadline: 'jutro' })).ok, false);
  assert.equal(renderBrandMessage(input({ positionTitle: '<script>x</script>' })).ok, false);
  assert.equal(renderBrandMessage(input({ candidateFirstName: 'Ann a' })).ok, false);
  assert.equal(renderBrandMessage(input({ controllerName: '' })).ok, false);
  assert.equal(renderBrandMessage(input({ kind: 'marketing_blast' })).ok, false);
  const quotes = renderBrandMessage(input({ positionTitle: 'R&D "Lead" O\'Neil', actionUrl: 'https://example.com/a?b=1&c="2"' })).value;
  assert.ok(quotes.html.includes('R&amp;D &quot;Lead&quot; O&#39;Neil'));
  assert.ok(quotes.html.includes('href="https://example.com/a?b=1&amp;c=%222%22"'), 'href is normalised and escaped');
  assert.doesNotMatch(quotes.html, /<script|\son[a-z]+=/i);
});

test('the invitation names the deadline in Warsaw time and the process-closed text makes no automated decision', () => {
  const invite = renderBrandMessage(input()).value;
  assert.match(invite.text, /1 grudnia 2026 17:00 \(czasu polskiego\)/);
  assert.match(invite.text, /Rozpocznij zadanie: https:\/\/example\.com\/zadanie/);
  const closed = renderBrandMessage(input({ kind: 'process_closed' })).value;
  assert.match(closed.text, /Decyzję podjął zespół rekrutacyjny/);
  assert.doesNotMatch(closed.text, /automatycznie|algorytm|sztuczna inteligencja/i);
});

test('the only transport never sends and touches no network', async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('network'); };
  try {
    const result = await disabledTransport.send(renderBrandMessage(input()).value, 'kandydat@example.com');
    assert.deepEqual(result, { status: 'not_sent', reason: 'transport_disabled' });
    assert.equal(called, false);
  } finally { globalThis.fetch = original; }
  const source = readFileSync(new URL('../lib/brand-messages.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /fetch\(|resend|nodemailer|smtp|sendgrid|postmark/i, 'no mail provider is wired');
});

test('editor preview shows each message in a fully sandboxed frame', () => {
  const path = fileURLToPath(new URL('../app/components/brand/brand-message-preview.tsx', import.meta.url));
  const mod = new Module(path); mod.filename = path;
  mod.paths = Module._nodeModulePaths(fileURLToPath(new URL('../', import.meta.url)));
  const require = createRequire(path);
  const mocks = { '../../../lib/brand-config': brandConfig, '../../../lib/brand-messages': messages };
  mod.require = id => id in mocks ? mocks[id] : require(id);
  mod._compile(ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, path);
  const html = renderToStaticMarkup(createElement(mod.exports.BrandMessagePreviews, { brand, controllerName: 'Acme Sp. z o.o.' }));
  assert.equal((html.match(/<iframe /g) ?? []).length, BRAND_MESSAGE_KINDS.length);
  assert.equal((html.match(/sandbox=""/g) ?? []).length, BRAND_MESSAGE_KINDS.length, 'no permissions for the preview frame');
  assert.match(html, /Temat:<\/strong> Acme Kariera: zaproszenie/);
});

test('report titles use the published brand, otherwise stay unchanged', async () => {
  for (const file of ['app/dashboard/[companyId]/recruitments/[recruitmentId]/report/page.tsx',
    'app/dashboard/[companyId]/recruitments/[recruitmentId]/applications/[applicationId]/report/page.tsx']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, /brandedTitle\(companyId, 'Raport (preselekcji|kandydata)'\)/);
  }
  // Behaviour: brandedTitle with and without a published brand, via the real loader and a stubbed RLS client.
  const path = fileURLToPath(new URL('../lib/brand-server.ts', import.meta.url));
  const companyId = '11111111-2222-4333-8444-555555555555';
  let rpcResult;
  const mocks = {
    react: { cache: fn => fn },
    './supabase/server': { createClient: async () => ({ rpc: async (name, args) => {
      assert.equal(name, 'brand_published'); assert.deepEqual(args, { target_company: companyId }); return rpcResult; } }) },
    './brand-config': brandConfig,
  };
  const mod = new Module(path); mod.filename = path;
  mod.paths = Module._nodeModulePaths(fileURLToPath(new URL('../', import.meta.url)));
  const require = createRequire(path);
  mod.require = id => id in mocks ? mocks[id] : require(id);
  mod._compile(ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, path);
  const previous = process.env.WHITE_LABEL_ENABLED;
  process.env.WHITE_LABEL_ENABLED = 'true';
  try {
    rpcResult = { data: [{ version_id: 'v', version_no: 1, config: brand, logo_asset_id: null, favicon_asset_id: null }], error: null };
    assert.equal(await mod.exports.brandedTitle(companyId, 'Raport kandydata'), 'Raport kandydata | Acme Kariera');
    rpcResult = { data: [], error: null };
    assert.equal(await mod.exports.brandedTitle(companyId, 'Raport kandydata'), 'Raport kandydata | SkillCheck');
    rpcResult = { data: null, error: { message: 'brand_forbidden' } };
    assert.equal(await mod.exports.brandedTitle(companyId, 'Raport preselekcji'), 'Raport preselekcji | SkillCheck', 'no access -> no brand');
    rpcResult = { data: [{ version_id: 'v', version_no: 1, config: { ...brand, brandName: '<x>' }, logo_asset_id: null, favicon_asset_id: null }], error: null };
    assert.equal(await mod.exports.brandedTitle(companyId, 'Raport kandydata'), 'Raport kandydata | SkillCheck', 'invalid stored config is ignored');
    process.env.WHITE_LABEL_ENABLED = 'false';
    rpcResult = { data: [{ version_id: 'v', version_no: 1, config: brand, logo_asset_id: null, favicon_asset_id: null }], error: null };
    assert.equal(await mod.exports.brandedTitle(companyId, 'Raport kandydata'), 'Raport kandydata | SkillCheck', 'feature off');
  } finally {
    if (previous === undefined) delete process.env.WHITE_LABEL_ENABLED; else process.env.WHITE_LABEL_ENABLED = previous;
  }
});
