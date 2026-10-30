import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildInterviewGaps } from '../lib/interview-gaps.ts';
import { prepareScreening } from '../lib/screening.ts';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const route = { companyId: uuid(1), recruitmentId: uuid(2), applicationId: uuid(3) };
const row = (n, extra = {}) => ({
  id: uuid(100 + n), criterion_id: `task:${n}`, criterion_kind: 'task', criterion_text_snapshot: `Wymaganie ${n}`,
  criterion_order: n, verdict: 'missing', missing_info: null, suggested_question: null, human_status: 'unreviewed',
  human_verdict: null, human_missing_info: null, human_suggested_question: null, ...extra,
});

test('gaps list partial, missing and contradicted rows in criterion order; supported rows are only counted', () => {
  const result = buildInterviewGaps([
    row(2, { verdict: 'contradicted', missing_info: 'Daty się wykluczają', suggested_question: 'Kiedy?' }),
    row(0, { verdict: 'supported' }),
    row(1, { verdict: 'partial', missing_info: ' Brak skali ', suggested_question: ' Ile osób? ' }),
    row(3, { verdict: 'missing' }),
  ]);
  assert.equal(result.total, 4);
  assert.equal(result.supported, 1);
  assert.deepEqual(result.gaps.map(g => [g.requirement, g.verdict]), [
    ['Wymaganie 1', 'partial'], ['Wymaganie 2', 'contradicted'], ['Wymaganie 3', 'missing'],
  ]);
  assert.equal(result.gaps[0].missingInfo, 'Brak skali');
  assert.equal(result.gaps[0].question, 'Ile osób?');
  assert.equal(result.gaps[2].question, null);
});

test('human edits win over the AI row; a rejected row stays open without the AI question', () => {
  const result = buildInterviewGaps([
    row(0, { verdict: 'missing', human_status: 'edited', human_verdict: 'supported' }),
    row(1, { verdict: 'supported', human_status: 'edited', human_verdict: 'partial', human_suggested_question: 'Pytanie rekrutera' }),
    row(2, { verdict: 'partial', suggested_question: 'Pytanie AI', human_status: 'rejected' }),
  ]);
  assert.equal(result.supported, 1);
  assert.deepEqual(result.gaps.map(g => [g.source, g.verdict, g.question]), [
    ['edited', 'partial', 'Pytanie rekrutera'], ['rejected', null, null],
  ]);
});

test('legacy v1 rows (verdict null) produce no interview topics', () => {
  assert.deepEqual(buildInterviewGaps([row(0, { verdict: null })]), { gaps: [], supported: 0, total: 0 });
});

function context() {
  const common = { company_id: route.companyId, created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z' };
  return { companyId: route.companyId,
    application: { ...common, id: route.applicationId, candidate_id: uuid(4), recruitment_id: route.recruitmentId, status: 'new' },
    recruitment: { ...common, id: route.recruitmentId, position_id: uuid(5), status: 'open', name: 'Test' },
    position: { ...common, id: uuid(5), title: 'Analityk', tasks: ['Raporty'], kpis: ['Terminowość'], required_competencies: [], required_behaviors: [], status: 'active' },
    document: { ...common, id: uuid(6), candidate_id: uuid(4), version: 1, status: 'reviewed', reviewed_by: uuid(7), reviewed_at: common.created_at, redacted_text: 'Tworzę raporty.' },
  };
}
function clientFor(tables) {
  return { from(table) {
    const filters = [];
    const data = () => (Array.isArray(tables[table]) ? tables[table] : tables[table] ? [tables[table]] : [])
      .filter(r => filters.every(([k, v]) => r[k] === v));
    return { select() { return this; }, eq(k, v) { filters.push([k, v]); return this; }, order() { return this; }, limit() { return this; },
      maybeSingle: async () => ({ data: data()[0] ?? null, error: null }),
      then(resolve) { return Promise.resolve({ data: data(), error: null }).then(resolve); } };
  } };
}
async function renderPage({ analysis, rows = [], stale = false } = {}) {
  const ctx = context();
  const id = uuid(11);
  const versions = analysis === null ? [] : [{ id, company_id: route.companyId, application_id: route.applicationId, recruitment_id: route.recruitmentId,
    analysis_version: 2, execution_status: 'completed', input_fingerprint: prepareScreening(ctx).fingerprint,
    stale_at: stale ? 'now' : null, candidate_document_version: 1, ...analysis }];
  const client = clientFor({ applications: ctx.application, recruitments: ctx.recruitment, positions: ctx.position, candidate_documents: ctx.document,
    screening_analysis_versions: versions, screening_criterion_results: rows.map(r => ({ ...r, company_id: route.companyId, analysis_id: id })) });
  const path = 'app/dashboard/[companyId]/recruitments/[recruitmentId]/applications/[applicationId]/interview/page.tsx';
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const require = createRequire(import.meta.url);
  const mod = { exports: {} };
  const replacements = { 'next/link': ({ children, ...props }) => React.createElement('a', props, children), 'next/navigation': { notFound() { throw Error('404'); } }, '../screening/screening.module.css': {} };
  const customRequire = name => {
    if (Object.hasOwn(replacements, name)) return replacements[name];
    if (name.endsWith('/lib/company-access')) return { companyAccess: async () => ({ client, canEdit: true }) };
    if (name.includes('/lib/')) return require(`../lib/${name.split('/lib/')[1]}.ts`);
    return require(name);
  };
  new Function('require', 'module', 'exports', code)(customRequire, mod, mod.exports);
  return renderToStaticMarkup(await mod.exports.default({ params: Promise.resolve(route) }));
}

test('interview page shows matrix gaps with questions and leaves the decision to a human', async () => {
  const html = await renderPage({ rows: [
    row(0, { verdict: 'supported' }),
    row(1, { verdict: 'missing', missing_info: 'Brak informacji o SQL', suggested_question: 'Jak używa Pan/Pani SQL?' }),
  ] });
  assert.match(html, /1 z 2 wymagań ma potwierdzenie w CV, 1 do wyjaśnienia/);
  assert.match(html, /Brak informacji o SQL/);
  assert.match(html, /Jak używa Pan\/Pani SQL\?/);
  assert.match(html, /nie oznacza kandydatów do zatrudnienia ani do odrzucenia/);
  assert.ok(!html.includes('Wymaganie 0'), 'supported rows are not repeated as interview topics');
  assert.doesNotMatch(html, /rekomend|odrzuć kandydata|zatrudnij/i);
});

test('interview page asks for an analysis when none exists and warns on stale material', async () => {
  assert.match(await renderPage({ analysis: null }), /nie ma jeszcze zestawienia dowodów/);
  assert.match(await renderPage({ analysis: { execution_status: 'processing' } }), /nie jest jeszcze gotowe/);
  assert.match(await renderPage({ rows: [row(0, { verdict: null })] }), /starszego typu/);
  assert.match(await renderPage({ stale: true, rows: [row(0)] }), /Pytania mogą być nieaktualne/);
});
