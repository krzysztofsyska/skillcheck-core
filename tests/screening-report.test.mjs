import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadScreeningReport } from '../lib/screening-report-source.ts';
import { exportScreeningReport } from '../lib/screening-report-export.ts';
import { csvCell, parseRanking, reportParameters, screeningReportCsv } from '../lib/screening-report.ts';

import { uuid, company, recruitment, application, analysis, review, result, timestamp, fixture } from './helpers/screening-report-fixture.mjs';

// A PostgREST-shaped contract double: actual filters, projections, pagination and failures.
function clientFor(data, options = {}) {
  const calls = []; let rankingReads = 0;
  function query(table, args) {
    const q = { table, args, fields: '*', eqs: [], ins: [], from: 0, to: Infinity, single: false, sort: null };
    const builder = {
      select(fields) { q.fields = fields; return this; }, eq(key, value) { q.eqs.push([key, value]); return this; },
      in(key, value) { q.ins.push([key, value]); return this; }, order(key) { q.sort = key; return this; },
      range(from, to) { q.from = from; q.to = to; return this; }, maybeSingle() { q.single = true; return this; },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          calls.push(structuredClone(q));
          if (table === 'get_screening_ranking' && q.from === 0) rankingReads++;
          options.onQuery?.(q, data, rankingReads);
          if (options.error?.[table]) return { data: null, error: { code: options.error[table], message: 'SECRET_INTERNAL_DETAILS' } };
          if (args) {
            assert.equal(args.target_recruitment, recruitment); assert.ok(!('company_id' in args));
            if (table === 'get_recruitment_shortlist') assert.equal(args.include_removed, false);
          }
          let rows = (data[table] ?? []).filter(row => q.eqs.every(([k, v]) => row[k] === v) && q.ins.every(([k, v]) => v.includes(row[k])));
          if (q.sort) rows = [...rows].sort((a,b) => String(a[q.sort]).localeCompare(String(b[q.sort])));
          rows = rows.slice(q.from, Math.min(q.to + 1, q.from + (options.cap ?? 200)));
          if (q.fields !== '*') rows = rows.map(row => Object.fromEntries(q.fields.split(',').map(k => [k, row[k]])));
          return { data: structuredClone(q.single ? rows[0] ?? null : rows), error: null };
        }).then(resolve, reject);
      },
    }; return builder;
  }
  return { calls, auth: { getUser: async () => ({ data: { user: options.anonymous ? null : { id: uuid(50) } }, error: null }) },
    from: table => query(table), rpc: (table, args) => query(table, args) };
}
const load = (data, options) => loadScreeningReport(clientFor(data, options), company, recruitment);

test('report uses current reviewed evidence, whitelists fields, and leaves source immutable', async () => {
  const data = fixture(), before = structuredClone(data), client = clientFor(data);
  const report = await loadScreeningReport(client, company, recruitment);
  assert.equal(report.applications[0].criteria[0].evidence[0].quote, 'Raport');
  assert.equal(report.applications[0].ranking.raw_score, 50);
  assert.equal(report.applications[0].shortlist, null);
  assert.deepEqual(data, before);
  assert.doesNotMatch(JSON.stringify(report), /DO_NOT_EXPORT/);
  for (const q of client.calls.filter(q => !q.args)) {
    assert.notEqual(q.fields, '*');
    assert.doesNotMatch(q.fields, /input_cv_text_snapshot|binding_snapshot|source_text|redacted_text|provider|result_summary|review_note|reviewer_id/);
    assert.ok(q.eqs.some(([k,v]) => k === (q.table === 'companies' ? 'id' : 'company_id') && v === company));
  }
});

test('only indicated review overrides apply; empty evidence/explanation survive and null rating preserves AI', async () => {
  const data = fixture(); data.screening_result_reviews[0].disposition = 'approved_with_changes';
  data.screening_criterion_review_overrides.push({ id: uuid(11), company_id: company, review_id: review, criterion_result_id: result,
    rating_override: null, evidence_override: [], explanation_override: '' },
    { id: uuid(12), company_id: company, review_id: uuid(99), criterion_result_id: result, rating_override: 'below' });
  const criterion = (await load(data)).applications[0].criteria[0];
  assert.equal(criterion.rating, 'meets'); assert.equal(criterion.explanation, ''); assert.deepEqual(criterion.evidence, []);
  assert.equal(criterion.reviewedChange, true);
});

test('insufficient data remains null score and may have a manual shortlist', async () => {
  const data = fixture(); Object.assign(data.get_screening_ranking[0], { rank: null, rankable: false, eligibility_reason: 'insufficient_evidence',
    raw_score: null, coverage: 0, known_criteria: 0, meets_count: 0, insufficient_data_count: 1, suggested_shortlist: false,
    shortlist_entry_id: uuid(20), shortlist_snapshot_current: true });
  data.screening_criterion_results[0].rating = 'insufficient_data';
  data.get_recruitment_shortlist.push({ entry_id: uuid(20), application_id: application, analysis_id: analysis, review_id: review,
    source: 'manual', selected_at: timestamp, ranking_policy_version: 'screening-ranking-v1', raw_score_snapshot: null,
    coverage_snapshot: 0, snapshot_current: true, policy_current: true, removed_at: null, note: 'DO_NOT_EXPORT_NOTE' });
  const report = await load(data), csv = screeningReportCsv(report);
  assert.equal(report.applications[0].ranking.raw_score, null);
  assert.match(csv, /Brak wystarczających danych/); assert.match(csv, /Wybrano przez człowieka/);
  assert.doesNotMatch(csv, /DO_NOT_EXPORT/);
});

test('rating overrides affect displayed rating; mismatched ranking counts block export', async () => {
  const data = fixture(); data.screening_result_reviews[0].disposition = 'approved_with_changes';
  data.screening_criterion_review_overrides.push({ id: uuid(10), company_id: company, review_id: review, criterion_result_id: result,
    rating_override: 'above', evidence_override: null, explanation_override: null });
  await assert.rejects(load(data), e => e.code === 'changed');
  Object.assign(data.get_screening_ranking[0], { meets_count: 0, above_count: 1, raw_score: 100 });
  const c = (await load(data)).applications[0].criteria[0]; assert.equal(c.rating, 'above'); assert.equal(c.aiRating, 'meets');
});

test('all exclusion reasons preserve status, withhold unreviewed evidence and do not reject the person', async () => {
  for (const reason of ['stale','pending','processing','failed','cancelled','no_completed_result','result_incomplete','review_inconsistent','needs_reanalysis','no_human_review']) {
    const data = fixture(); Object.assign(data.get_screening_ranking[0], { rank: null, rankable: false, raw_score: null,
      eligibility_reason: reason, suggested_shortlist: false });
    const report = await load(data); assert.deepEqual(report.applications[0].criteria, []); assert.equal(report.applications[0].ranking.eligibility_reason, reason);
  }
});

test('stale shortlist stays visible and separate from current ranking', async () => {
  const data = fixture(); Object.assign(data.get_screening_ranking[0], { shortlist_entry_id: uuid(20), shortlist_snapshot_current: false });
  data.get_recruitment_shortlist.push({ entry_id: uuid(20), application_id: application, analysis_id: uuid(21), review_id: uuid(22),
    source: 'suggested', selected_at: timestamp, ranking_policy_version: 'older', raw_score_snapshot: 100,
    coverage_snapshot: 1, snapshot_current: false, policy_current: false, removed_at: null });
  const report = await load(data); assert.equal(report.applications[0].ranking.raw_score, 50);
  assert.match(screeningReportCsv(report), /wymaga ponownego sprawdzenia/);
});

test('invalid UUID and size, duplicates, bad RPC shapes and incomplete results are rejected', async () => {
  for (const size of ['4', '11', '05', '5.0', '', ['5','6'], null, 10]) assert.throws(() => reportParameters(company,recruitment,size), e => e.code === 'invalid');
  for (const size of ['5','6','7','8','9','10',undefined]) assert.ok(reportParameters(company,recruitment,size));
  assert.throws(() => reportParameters('bad',recruitment));
  for (const mutate of [
    d => d.get_screening_ranking.push(d.get_screening_ranking[0]), d => { d.get_screening_ranking[0].application_id = uuid(90); },
    d => { d.get_screening_ranking[0].eligibility_reason = 'hire'; }, d => { d.get_screening_ranking[0].coverage = 'NaN'; },
    d => { d.get_screening_ranking[0].rank = 2; }, d => { d.screening_criterion_results = []; },
    d => { d.screening_result_reviews[0].review_version = 1; }, d => { d.screening_result_reviews[0].analysis_id = uuid(90); },
    d => { d.screening_analysis_versions[0].application_id = uuid(90); }, d => { d.screening_analysis_versions[0].stale_at = timestamp; },
    d => { d.screening_analysis_versions[0].criteria_snapshot[0].text = 'Nowy profil'; },
    d => { d.screening_result_reviews[0].disposition = 'approved_with_changes'; },
  ]) { const data = fixture(); mutate(data); await assert.rejects(load(data), e => e.code === 'changed'); }
});

test('pagination handles server caps without truncation; scope is recruitment and tenant', async () => {
  const data = fixture();
  for (let i = 100; i < 305; i++) {
    data.applications.push({ ...data.applications[0], id: uuid(i) });
    data.get_screening_ranking.push({ ...data.get_screening_ranking[0], application_id: uuid(i), analysis_id: null, review_id: null,
      rank: null, rankable: false, raw_score: null, eligibility_reason: 'no_completed_result', suggested_shortlist: false });
  }
  data.applications.push({ ...data.applications[0], id: uuid(999), recruitment_id: uuid(88) });
  const report = await load(data, { cap: 37 }); assert.equal(report.applications.length, 206);
  assert.equal(report.applications[0].ranking.application_id, application);
});

test('empty recruitment is a valid report only when RPCs exist; oversize is not silently clipped', async () => {
  const data = fixture(); data.applications = []; data.get_screening_ranking = [];
  assert.equal((await load(data)).applications.length, 0);
  for (let n = 100; n < 601; n++) data.applications.push({ id: uuid(n), company_id: company, recruitment_id: recruitment, updated_at: timestamp });
  await assert.rejects(load(data), e => e.code === 'too_large');
});

test('changed metadata, ranking, new review, shortlist or revoked access blocks mixed exports', async () => {
  for (const change of [
    d => { d.get_screening_ranking[0].raw_score = 51; },
    d => { d.get_screening_ranking[0].review_id = uuid(55); },
    d => { d.get_screening_ranking[0].shortlist_entry_id = uuid(55); },
  ]) {
    await assert.rejects(load(fixture(), { onQuery(q,d,reads) { if (q.table === 'get_screening_ranking' && q.from === 0 && reads === 2) change(d); } }), e => e.code === 'changed');
  }
  await assert.rejects(load(fixture(), { onQuery(q,d) { if(q.table === 'screening_criterion_results') d.recruitments[0].updated_at = 'later'; } }), e => e.code === 'changed');
  await assert.rejects(load(fixture(), { onQuery(q,d) { if(q.table === 'screening_criterion_results') d.companies = []; } }), e => e.code === 'not_found');
});

test('export uses safe errors and no-store; anonymous, cross-tenant and missing dependency cannot download', async () => {
  for (const [options, status] of [[{anonymous:true},401], [{error:{get_screening_ranking:'PGRST202'}},503],
    [{error:{get_recruitment_shortlist:'42883'}},503], [{error:{screening_result_reviews:'42501'}},404],
    [{error:{screening_criterion_results:'XX000'}},500]]) {
    const response = await exportScreeningReport(clientFor(fixture(),options),company,recruitment);
    assert.equal(response.status,status); assert.match(response.headers.get('cache-control'),/no-store/);
    assert.doesNotMatch(await response.text(),/SECRET_INTERNAL_DETAILS|Raportowanie/);
    assert.equal(response.headers.get('content-disposition'),null);
  }
  const foreign = await exportScreeningReport(clientFor(fixture()),uuid(999),recruitment); assert.equal(foreign.status,404);
  const wrongRecruitment = await exportScreeningReport(clientFor(fixture()),company,uuid(999)); assert.equal(wrongRecruitment.status,404);
  const response = await exportScreeningReport(clientFor(fixture()),company,recruitment,'5');
  assert.equal(response.status,200); assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.equal(response.headers.get('referrer-policy'),'no-referrer'); assert.match(response.headers.get('content-disposition'),/attachment; filename="skillcheck-preselekcja-/);
  const bytes = new Uint8Array(await response.arrayBuffer()); assert.deepEqual([...bytes.slice(0,3)],[239,187,191]);
});

test('CSV preserves quotes/newlines/Polish text and neutralizes formulas and control prefixes', () => {
  assert.equal(csvCell('Zażółć; "cytat"\nnowy'), '"Zażółć; ""cytat""\nnowy"');
  for (const input of ['=1+1','+CMD','-CMD','@SUM(A1)','\t=1',' \r\n+CMD','\u0000=1','\uFEFF@CMD']) assert.ok(csvCell(input).startsWith('"\''));
  assert.equal(csvCell(null),'""'); assert.equal(csvCell(0),'"0"');
});

test('React report renders status/evidence and escapes hostile content', async () => {
  const data = fixture(); data.screening_criterion_results[0].evidence[0].quote = '<img src=x onerror=alert(1)>';
  const report = await load(data);
  const filename = new URL('../app/dashboard/[companyId]/recruitments/[recruitmentId]/report/report-view.tsx',import.meta.url).pathname;
  const module = new Module(filename); module.filename = filename;
  const require = createRequire(filename);
  module.require = name => name.endsWith('.module.css') ? { default: new Proxy({}, { get: (_, key) => String(key) }), __esModule: true }
    : name.endsWith('/screening-report') ? require(name+'.ts') : require(name);
  module._compile(ts.transpileModule(readFileSync(filename,'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  const html = renderToStaticMarkup(React.createElement(module.exports.ScreeningReportView,{report,basePath:'/dashboard/test'}));
  assert.match(html,/Raport preselekcji/); assert.match(html,/Spełnia wymagania/); assert.match(html,/Nie jest decyzją o zatrudnieniu/);
  assert.match(html,/&lt;img/); assert.doesNotMatch(html,/<img|DO_NOT_EXPORT/);
  assert.match(html,/scope="col"/); assert.match(html,/<caption>/);
});
