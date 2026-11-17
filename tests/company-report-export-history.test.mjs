// SC-015-D3 — historia eksportów raportów na poziomie firmy (warstwa aplikacji).
// Dane są fikcyjne; żadnego prawdziwego kandydata, CV ani firmy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPANY_EXPORT_HISTORY_MAX, COMPANY_EXPORT_HISTORY_PAGE, companyExportHistoryEmptyMessage, companyExportHistoryErrorMessage,
  companyExportHistoryView, loadCompanyReportExportHistory, parseCompanyExportCursor,
} from '../lib/company-report-export-history.ts';

const company = '11111111-1111-4111-8111-111111111111';
const recruitment = '33333333-3333-4333-8333-333333333333';
const application = '44444444-4444-4444-8444-444444444444';
const actor = '77777777-7777-4777-8777-777777777777';
const exportId = n => `55555555-5555-4555-8555-${String(n).padStart(12, '0')}`;
const row = (overrides = {}) => ({
  export_id: exportId(1), exported_at: '2026-11-16T10:00:00.123456+00:00', actor_id: actor, actor_role: 'recruiter',
  is_me: false, recruitment_id: recruitment, application_id: application, ...overrides,
});
function client(rpc) {
  const calls = [];
  return { calls, rpc: async (name, args) => { calls.push({ name, args }); return rpc(name, args); } };
}

test('odczyt przez list_company_report_exports: firma małymi literami, strona 100, bez kursora', async () => {
  const fake = client(() => ({ data: [row({ is_me: true, actor_role: 'owner' }), row({ export_id: exportId(2) })], error: null }));
  const history = await loadCompanyReportExportHistory(fake, company.toUpperCase());
  assert.deepEqual(fake.calls, [{ name: 'list_company_report_exports', args: { target_company: company, row_limit: 100 } }]);
  assert.equal(history.ok, true);
  assert.equal(history.next, null);
  const view = companyExportHistoryView(company, history, new Map([[recruitment, 'Kurier — listopad']]));
  assert.equal(view.kind, 'list');
  assert.equal(view.nextHref, null);
  assert.deepEqual(view.items.map(item => item.who), ['Ty (właściciel konta firmy)', 'Rekruter']);
  assert.match(view.items[0].when, /11:00:00/, 'czas w strefie Warszawy');
  assert.equal(view.items[0].recruitmentName, 'Kurier — listopad');
  assert.equal(view.items[0].recruitmentHref, `/dashboard/${company}/recruitments/${recruitment}`);
  assert.equal(view.items[0].reportHref, `/dashboard/${company}/recruitments/${recruitment}/applications/${application}/report`);
  assert.ok(!JSON.stringify(view.items.map(({ when, who, recruitmentName }) => [when, who, recruitmentName])).includes(actor),
    'identyfikator konta nie trafia do tekstu na ekranie');
  assert.ok(COMPANY_EXPORT_HISTORY_PAGE <= COMPANY_EXPORT_HISTORY_MAX);
});

test('brak nazwy rekrutacji nie ukrywa wpisu; pusty stan', async () => {
  const view = companyExportHistoryView(company, { ok: true, entries: [], next: null });
  assert.deepEqual(view, { kind: 'empty', message: companyExportHistoryEmptyMessage });
  const history = await loadCompanyReportExportHistory(client(() => ({ data: [row()], error: null })), company);
  assert.equal(companyExportHistoryView(company, history).items[0].recruitmentName, 'Rekrutacja');
});

test('pełna strona daje kursor z dokładnym czasem (mikrosekundy) i identyfikatorem ostatniego wpisu', async () => {
  const rows = Array.from({ length: COMPANY_EXPORT_HISTORY_PAGE }, (_, i) => row({ export_id: exportId(i + 1) }));
  rows.at(-1).exported_at = '2026-11-15T08:00:00.654321+00:00';
  const history = await loadCompanyReportExportHistory(client(() => ({ data: rows, error: null })), company);
  assert.deepEqual(history.next, { before: '2026-11-15T08:00:00.654321+00:00', id: exportId(100) });
  const view = companyExportHistoryView(company, history);
  assert.equal(view.nextHref, `/dashboard/${company}/eksporty?before=2026-11-15T08%3A00%3A00.654321%2B00%3A00&id=${exportId(100)}`);
  const url = new URL(view.nextHref, 'http://x.invalid');
  const cursor = parseCompanyExportCursor(url.searchParams.get('before'), url.searchParams.get('id'));
  assert.deepEqual(cursor, history.next);
  const fake = client(() => ({ data: [], error: null }));
  await loadCompanyReportExportHistory(fake, company, cursor);
  assert.deepEqual(fake.calls[0].args, {
    target_company: company, row_limit: 100, before_at: '2026-11-15T08:00:00.654321+00:00', before_id: exportId(100),
  });
});

test('kursor z adresu: tylko poprawna para, inaczej pierwsza strona', () => {
  assert.equal(parseCompanyExportCursor(undefined, undefined), null);
  assert.equal(parseCompanyExportCursor('2026-11-15T08:00:00Z', undefined), null);
  assert.equal(parseCompanyExportCursor(undefined, exportId(1)), null);
  assert.equal(parseCompanyExportCursor('wczoraj', exportId(1)), null);
  assert.equal(parseCompanyExportCursor('2026-11-15T08:00:00Z', 'nie-uuid'), null);
  assert.equal(parseCompanyExportCursor(['2026-11-15T08:00:00Z'], exportId(1)), null);
  assert.equal(parseCompanyExportCursor("2026-11-15T08:00:00Z'; drop table x", exportId(1)), null);
  assert.deepEqual(parseCompanyExportCursor('2026-11-15T08:00:00Z', exportId(1).toUpperCase()), { before: '2026-11-15T08:00:00Z', id: exportId(1) });
});

test('każdy błąd odczytu daje neutralny komunikat, nie wyjątek', async () => {
  const cases = [
    () => ({ data: null, error: { code: '42501', message: 'company_report_exports_forbidden' } }),
    () => ({ data: null, error: null }),
    () => ({ data: [row({ actor_role: 'admin' })], error: null }),
    () => ({ data: [row({ actor_id: 'nie-uuid' })], error: null }),
    () => ({ data: [row({ exported_at: 'wczoraj' })], error: null }),
    () => ({ data: [row({ is_me: 'tak' })], error: null }),
    () => ({ data: [row({ recruitment_id: null })], error: null }),
    () => ({ data: [row({ application_id: '../x' })], error: null }),
    () => ({ data: [row({ export_id: undefined })], error: null }),
    () => ({ data: Array.from({ length: COMPANY_EXPORT_HISTORY_PAGE + 1 }, () => row()), error: null }),
    () => { throw new Error('sieć'); },
  ];
  for (const rpc of cases) {
    const view = companyExportHistoryView(company, await loadCompanyReportExportHistory(client(rpc), company));
    assert.deepEqual(view, { kind: 'error', message: companyExportHistoryErrorMessage });
    assert.doesNotMatch(view.message, /42501|forbidden|sieć/);
  }
  const fake = client(() => ({ data: [], error: null }));
  assert.deepEqual(await loadCompanyReportExportHistory(fake, 'x'), { ok: false });
  assert.equal(fake.calls.length, 0);
});

// Strona /dashboard/[companyId]/eksporty renderowana z podmienionym dostępem do bazy.
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as historyModule from '../lib/company-report-export-history.ts';

function loadPage(mocks) {
  const path = fileURLToPath(new URL('../app/dashboard/[companyId]/eksporty/page.tsx', import.meta.url));
  const mod = new Module(path);
  mod.filename = path;
  mod.paths = Module._nodeModulePaths(fileURLToPath(new URL('../', import.meta.url)));
  const req = createRequire(path);
  mod.require = id => id in mocks ? mocks[id] : req(id);
  mod._compile(ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, path);
  return mod.exports.default;
}
const ownerId = '00000000-0000-4000-8000-000000000001';
async function renderPage({ userId = ownerId, rpc, searchParams = {}, recruitments = { data: [{ id: recruitment, name: 'Kurier — listopad' }], error: null } }) {
  const calls = [];
  const from = table => {
    calls.push({ table });
    const builder = { select: () => builder, eq: () => builder, in: () => builder, then: (ok, ko) => Promise.resolve(recruitments).then(ok, ko) };
    return builder;
  };
  const page = loadPage({
    'next/link': ({ children, href }) => React.createElement('a', { href }, children),
    '../../../../lib/company-access': { companyAccess: async () => ({
      client: { rpc: async (name, args) => { calls.push({ name, args }); return rpc(name, args); }, from },
      company: { name: 'Acme', owner_id: ownerId }, user: { id: userId }, canEdit: true,
    }) },
    '../../../../lib/company-report-export-history': historyModule,
  });
  const html = renderToStaticMarkup(await page({ params: Promise.resolve({ companyId: company }), searchParams: Promise.resolve(searchParams) }));
  return { html, calls };
}

test('strona: właściciel widzi listę z odnośnikami do rekrutacji i raportu', async () => {
  const { html, calls } = await renderPage({ rpc: () => ({ data: [row({ is_me: true, actor_role: 'owner' })], error: null }) });
  assert.match(html, /Historia eksportów raportów — Acme/);
  assert.match(html, /Ty \(właściciel konta firmy\)/);
  assert.match(html, new RegExp(`href="/dashboard/${company}/recruitments/${recruitment}"[^>]*>Kurier — listopad<`));
  assert.match(html, new RegExp(`href="/dashboard/${company}/recruitments/${recruitment}/applications/${application}/report"`));
  assert.doesNotMatch(html, new RegExp(actor));
  assert.doesNotMatch(html, /Starsze pobrania/);
  assert.equal(calls.filter(c => c.name).length, 1);
});

test('strona: pusty stan, neutralny błąd, kursor z adresu, brak nazwy rekrutacji', async () => {
  assert.match((await renderPage({ rpc: () => ({ data: [], error: null }) })).html, new RegExp(companyExportHistoryEmptyMessage));
  const failed = await renderPage({ rpc: () => ({ data: null, error: { code: '42501', message: 'SECRET_SQL_DETAILS' } }) });
  assert.match(failed.html, /Nie udało się teraz wczytać historii eksportów/);
  assert.doesNotMatch(failed.html, /SECRET_SQL_DETAILS|42501/);
  assert.equal(failed.calls.filter(c => c.table).length, 0, 'bez listy nie pytamy o nazwy rekrutacji');
  const paged = await renderPage({
    rpc: () => ({ data: [row()], error: null }), searchParams: { before: '2026-11-15T08:00:00.654321+00:00', id: exportId(9) },
    recruitments: { data: null, error: { message: 'x' } },
  });
  assert.deepEqual(paged.calls[0].args, { target_company: company, row_limit: 100, before_at: '2026-11-15T08:00:00.654321+00:00', before_id: exportId(9) });
  assert.match(paged.html, /Najnowsze pobrania/);
  assert.match(paged.html, />Rekrutacja</);
  const full = await renderPage({ rpc: () => ({ data: Array.from({ length: COMPANY_EXPORT_HISTORY_PAGE }, (_, i) => row({ export_id: exportId(i + 1) })), error: null }) });
  assert.match(full.html, /Starsze pobrania/);
});

test('strona: rekruter i czytelnik dostają informację, bez odczytu historii', async () => {
  const { html, calls } = await renderPage({ userId: '00000000-0000-4000-8000-000000000002', rpc: () => { throw new Error('nie powinno być wywołane'); } });
  assert.match(html, /Historię eksportów całej firmy widzi właściciel konta firmy\./);
  assert.equal(calls.length, 0);
});
