import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
          if (args && table === 'position_requirement_flags') {
            // SC-015 / #268: oznaczenia wymagań są per stanowisko, nie per rekrutacja.
            assert.equal(args.target_company, company); assert.ok('target_position' in args);
          } else if (args) {
            assert.equal(args.target_recruitment, recruitment); assert.ok(!('company_id' in args));
            if (table === 'get_recruitment_shortlist') assert.equal(args.include_removed, false);
          }
          let rows = (data[table] ?? []).filter(row => q.eqs.every(([k, v]) => row[k] === v) && q.ins.every(([k, v]) => v.includes(row[k])));
          if (q.sort) rows = [...rows].sort((a,b) => String(a[q.sort]).localeCompare(String(b[q.sort])));
          rows = rows.slice(q.from, Math.min(q.to + 1, q.from + (options.cap ?? 200)));
          if (q.fields !== '*') rows = rows.map(row => Object.fromEntries(q.fields.split(',').map(k => [k, row[k]])));
          const response = structuredClone(q.single ? rows[0] ?? null : rows);
          return { data: options.responseData?.(q, response) ?? response, error: null };
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

test('report rejects mis-scoped source identities even if the Data API accepted its filters', async () => {
  // A broken view or mocked PostgREST response must never mix another tenant's
  // company, recruitment, position or application into a downloadable report.
  const cases = [
    ['companies', 'id', uuid(90)],
    ['recruitments', 'id', uuid(90)],
    ['recruitments', 'company_id', uuid(90)],
    ['recruitments', 'position_id', 'invalid-position-id'],
    ['positions', 'id', uuid(90)],
    ['positions', 'company_id', uuid(90)],
    ['applications', 'id', 'invalid-application-id'],
    ['applications', 'company_id', uuid(90)],
    ['applications', 'recruitment_id', uuid(90)],
  ];
  for (const [table, field, value] of cases) {
    const client = clientFor(fixture(), {
      responseData(q, response) {
        if (q.table !== table || response === null) return response;
        const corrupt = row => ({ ...row, [field]: value });
        return Array.isArray(response) ? response.map((row, i) => i === 0 ? corrupt(row) : row) : corrupt(response);
      },
    });
    await assert.rejects(() => loadScreeningReport(client, company, recruitment),
      error => error?.code === 'changed', `${table}.${field} must fail closed`);
  }
});

test('comparison report rejects malformed and duplicate requirement-flag RPC rows', async () => {
  const flag = { criterion_id: 'task:1', criterion_text: 'Raportowanie', flag: 'required' };
  const malformed = [
    [flag, { ...flag, flag: 'additional' }], // ambiguous required/optional
    [null], [{ ...flag, criterion_id: null }],
    [{ ...flag, criterion_id: '  ' }],
    [{ ...flag, criterion_text: null }],
    [{ ...flag, flag: null }],
  ];
  for (const rows of malformed) {
    const data = fixture();
    data.position_requirement_flags = rows;
    await assert.rejects(() => load(data), error => error?.code === 'changed');
  }

  const oldProfile = await load(fixture());
  assert.deepEqual(oldProfile.requirementFlags, [], 'missing flags remain a valid legacy profile');
  const current = fixture();
  current.position_requirement_flags = [flag];
  assert.deepEqual((await load(current)).requirementFlags, [flag]);

  const unknown = fixture();
  unknown.position_requirement_flags = [{ ...flag, flag: 'legacy-unknown' }];
  assert.equal((await load(unknown)).requirementFlags[0].flag, 'legacy-unknown',
    'unknown text flag is handled as unmarked by the shared resolver');
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

test('malformed successful paginated Data API results cannot silently produce an empty report', async () => {
  const empty = fixture();
  empty.applications = []; empty.get_screening_ranking = [];
  // Before the guard, each malformed page was treated as length=0 (an empty
  // recruitment or shortlist) despite PostgREST never returning this shape.
  for (const table of ['applications', 'get_screening_ranking', 'get_recruitment_shortlist']) {
    for (const payload of [{ length: 0 }, { 0: { id: application }, length: 1 }, 'invalid-array']) {
      await assert.rejects(
        () => load(empty, { responseData(q, value) {
          return q.table === table && q.from === 0 ? payload : value;
        } }),
        error => error?.code === 'changed',
        `malformed ${table} payload must not look like no candidates`,
      );
    }
  }
  // A proxy ignoring a requested 200-row range is also inconsistent; never
  // accept a page larger than the requested slice.
  await assert.rejects(
    () => load(fixture(), { responseData(q, value) {
      return q.table === 'applications' && q.from === 0
        ? Array.from({ length: 201 }, () => value[0])
        : value;
    } }),
    error => error?.code === 'changed',
  );
});

test('concurrent evidence or reviewer corrections invalidate a mixed screening report', async () => {
  const verify = async (table, mutate, setup = () => {}) => {
    const data = fixture(); setup(data);
    let reads = 0;
    await assert.rejects(() => load(data, {
      onQuery(q, source) {
        if (q.table !== table || q.from !== 0) return;
        // Do not count the v2 matrix probe as the criterion evidence read.
        if (table === 'screening_criterion_results' && !q.fields.includes('criterion_text_snapshot')) return;
        if (++reads === 2) mutate(source);
      },
    }), error => error?.code === 'changed', `concurrent ${table} mutation must not publish stale data`);
    assert.equal(reads, 2, `re-read the complete ${table} data before exporting`);
  };

  await verify('screening_criterion_results', source => {
    source.screening_criterion_results[0].evidence = [{ start: 0, end: 7, quote: 'Poprawka' }];
  });
  await verify('screening_result_reviews', source => {
    source.screening_result_reviews[0].disposition = 'rejected';
  });
  await verify('screening_criterion_review_overrides', source => {
    source.screening_criterion_review_overrides[0].explanation_override = 'Skorygowany opis';
  }, source => {
    source.screening_result_reviews[0].disposition = 'approved_with_changes';
    source.screening_criterion_review_overrides.push({
      id: uuid(11), company_id: company, review_id: review, criterion_result_id: result,
      rating_override: null, evidence_override: null, explanation_override: 'Pierwotny opis',
    });
  });
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
  for (const input of [
    '=1+1', '+CMD', '-CMD', '@SUM(A1)', '\t=1', ' \r\n+CMD', '\u0000=1', '\uFEFF@CMD',
    '\u200b=HYPERLINK("https://example.invalid")', // zero-width space
    '\u200d+CMD', // zero-width joiner
    '\u200e@CMD', // left-to-right mark
    '\u202e-CMD', // right-to-left override
    '\u2060=1+1', // word joiner
    '\u00ad=1+1', // soft hyphen
    '\u061c@CMD', // Arabic letter mark
  ]) assert.ok(csvCell(input).startsWith('"\''), JSON.stringify(input));
  assert.equal(csvCell('\u200bWynik'), '"\u200bWynik"', 'benign invisible prefix must remain unchanged');
  assert.equal(csvCell(null),'""'); assert.equal(csvCell(0),'"0"');
});

test('React report renders status/evidence and escapes hostile content', async () => {
  const data = fixture(); data.screening_criterion_results[0].evidence[0].quote = '<img src=x onerror=alert(1)>';
  const report = await load(data);
  const filename = fileURLToPath(new URL('../app/dashboard/[companyId]/recruitments/[recruitmentId]/report/report-view.tsx',import.meta.url));
  const module = new Module(filename); module.filename = filename;
  const require = createRequire(filename);
  module.require = name => name.endsWith('.module.css') ? { default: new Proxy({}, { get: (_, key) => String(key) }), __esModule: true }
    : /\/lib\/[a-z-]+$/.test(name) ? require(name+'.ts') : require(name);
  module._compile(ts.transpileModule(readFileSync(filename,'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  const html = renderToStaticMarkup(React.createElement(module.exports.ScreeningReportView,{report,basePath:'/dashboard/test'}));
  assert.match(html,/Raport preselekcji/); assert.match(html,/Spełnia wymagania/); assert.match(html,/Nie jest decyzją o zatrudnieniu/);
  assert.match(html,/&lt;img/); assert.doesNotMatch(html,/<img|DO_NOT_EXPORT/);
  assert.match(html,/scope="col"/); assert.match(html,/<caption>/);
});

test('v2 evidence rows publish the human matrix review, never the discarded AI citation', async () => {
  const edited = fixture(); Object.assign(edited.screening_criterion_results[0], { verdict: 'supported', human_status: 'edited', human_verdict: 'missing', human_evidence: [] });
  const editedReport = await load(edited);
  const e = editedReport.applications[0].criteria[0];
  assert.equal(e.matrixVerdict, 'missing', 'The human-corrected evidence state is published, not the neutral rating');
  assert.match(screeningReportCsv(editedReport), /"Werdykt macierzy dowodów"/);
  assert.match(screeningReportCsv(editedReport), /"Brak informacji w CV"/);
  assert.deepEqual(e.evidence, []); assert.equal(e.explanation, null, 'the superseded AI explanation is not published'); assert.equal(e.reviewedChange, true);
  const rejected = fixture(); Object.assign(rejected.screening_criterion_results[0], { verdict: 'supported', human_status: 'rejected', human_evidence: null });
  const r = (await load(rejected)).applications[0].criteria[0];
  assert.deepEqual(r.evidence, []); assert.equal(r.explanation, null); assert.equal(r.reviewedChange, true);
  assert.equal(r.matrixVerdict, 'rejected');
  const accepted = fixture(); Object.assign(accepted.screening_criterion_results[0], { verdict: 'supported', human_status: 'accepted', human_evidence: null });
  const a = (await load(accepted)).applications[0].criteria[0];
  assert.equal(a.evidence[0].quote, 'Raport'); assert.equal(a.reviewedChange, false); assert.equal(a.matrixVerdict, 'supported');
  assert.equal((await load(fixture())).applications[0].criteria[0].matrixVerdict, null, 'Legacy v1 rows keep their rating only');
});

test('automatic preselection groups appear in the report and CSV without per-row review', async () => {
  const data = fixture();
  data.get_preselection_groups = [
    { application_id: application, candidate_id: uuid(60), candidate_name: 'Jan Testowy', has_phone: true, group_key: 'passed',
      source: 'auto', raw_score: 87.5, coverage: 0.875, updated_at: timestamp, application_status: 'new', analysis_id: data.get_screening_ranking[0].analysis_id },
  ];
  const report = await load(data), csv = screeningReportCsv(report);
  assert.equal(report.groups.length, 1);
  assert.deepEqual(report.groups[0], { application_id: application, candidate_name: 'Jan Testowy', group: 'passed', source: 'auto', raw_score: 87.5, coverage: 0.875, stale: false });
  assert.match(csv, /"Preselekcja automatyczna/); assert.match(csv, new RegExp(`"${application}";"Przeszli sito";"87.5";"0.875";"Automatycznie";"Aktualny"`));
  assert.doesNotMatch(csv, /Jan Testowy/, 'CSV keeps candidates by application ID only');
});

test('preselection group RPC fails closed for a foreign application instead of silently hiding it', async () => {
  const data = fixture();
  data.get_preselection_groups = [{
    application_id: uuid(61), candidate_id: uuid(62), candidate_name: 'Obca Osoba', has_phone: false,
    group_key: 'rejected', source: 'auto', raw_score: 0, coverage: 1, updated_at: timestamp,
    application_status: 'new', analysis_id: uuid(63),
  }];
  await assert.rejects(() => load(data), error => error?.code === 'changed',
    'an out-of-recruitment result from a trusted RPC must invalidate the export');
  const csvResponse = await exportScreeningReport(clientFor(data), company, recruitment);
  assert.equal(csvResponse.status, 409, 'an inconsistent RPC must not produce a downloadable CSV');
  assert.equal((await csvResponse.json()).error, 'changed');
});

test('preselection group RPC rejects duplicate entries and malformed analysis links', async () => {
  const data = fixture();
  const group = {
    application_id: application, candidate_name: 'Kandydat testowy', group_key: 'passed',
    source: 'auto', raw_score: 80, coverage: 0.8,
    analysis_id: data.get_screening_ranking[0].analysis_id,
  };
  for (const rows of [
    [group, { ...group, group_key: 'review', raw_score: 40 }],
    [{ ...group, analysis_id: '-'.repeat(36) }],
    [{ ...group, analysis_id: 'a'.repeat(36) }],
  ]) {
    data.get_preselection_groups = rows;
    await assert.rejects(() => load(data), error => error?.code === 'changed',
      'a duplicated candidate or malformed UUID must invalidate the report');
  }
  data.get_preselection_groups = [group];
  assert.equal((await load(data)).groups.length, 1, 'one valid group still appears');
});

test('report still loads before the bulk migration (groups RPC missing)', async () => {
  const report = await load(fixture(), { error: { get_preselection_groups: 'PGRST202' } });
  assert.deepEqual(report.groups, []);
  assert.doesNotMatch(screeningReportCsv(report), /Preselekcja automatyczna/);
});

test('a group whose analysis became stale is flagged, not shown as current', async () => {
  const data = fixture();
  Object.assign(data.get_screening_ranking[0], { rank: null, rankable: false, eligibility_reason: 'stale', raw_score: null, coverage: null,
    known_criteria: 0, total_criteria: 1, below_count: 0, meets_count: 0, above_count: 0, insufficient_data_count: 0, suggested_shortlist: false });
  data.get_preselection_groups = [{ application_id: application, candidate_id: uuid(60), candidate_name: 'Jan Testowy', has_phone: true,
    group_key: 'passed', source: 'auto', raw_score: 90, coverage: 1, updated_at: timestamp, application_status: 'new' }];
  const report = await load(data);
  assert.equal(report.groups[0].stale, true);
  assert.match(screeningReportCsv(report), /Wynik nieaktualny — wymaga ponownej analizy/);
});

test('a group computed from an older analysis is stale after a re-analysis outside the batch', async () => {
  const data = fixture();
  const row = { application_id: application, candidate_id: uuid(60), candidate_name: 'Jan Testowy', has_phone: true,
    group_key: 'passed', source: 'auto', raw_score: 90, coverage: 1, updated_at: timestamp, application_status: 'new' };
  // Same analysis as the ranking: current.
  data.get_preselection_groups = [{ ...row, analysis_id: data.get_screening_ranking[0].analysis_id }];
  const current = await load(data);
  assert.equal(current.groups[0].stale, false);
  assert.match(screeningReportCsv(current), new RegExp(`"${application}";"Przeszli sito";"90";"1";"Automatycznie";"Aktualny"`));
  // The ranking now uses a newer completed analysis: the saved score is historical.
  data.get_preselection_groups = [{ ...row, analysis_id: uuid(99) }];
  const report = await load(data);
  assert.equal(report.groups[0].stale, true);
  const staleGroupRow = screeningReportCsv(report).split('\r\n').find(line => line.includes('"Przeszli sito"'));
  assert.equal(staleGroupRow, `"${application}";"Przeszli sito";"";"";"Automatycznie";"Wynik nieaktualny — wymaga ponownej analizy"`,
    'historical score and coverage must not be exported as current');
  // No link to an analysis (erased, or an older RPC without the field): never shown as current.
  data.get_preselection_groups = [{ ...row, analysis_id: null }];
  assert.equal((await load(data)).groups[0].stale, true);
  data.get_preselection_groups = [row];
  assert.equal((await load(data)).groups[0].stale, true);
  // A malformed link fails closed.
  data.get_preselection_groups = [{ ...row, analysis_id: 'x' }];
  await assert.rejects(load(data));
});

test('a saved group is historical when the ranking no longer has a human-reviewed result', async () => {
  // An RPC may still return the previous analysis_id while a retry is pending or
  // a human has not approved it. A matching UUID must not publish its old score.
  for (const reason of [
    'no_human_review', 'pending', 'processing', 'failed', 'cancelled',
    'no_completed_result', 'result_incomplete', 'review_inconsistent',
  ]) {
    const data = fixture();
    Object.assign(data.get_screening_ranking[0], {
      rank: null, rankable: false, raw_score: null,
      eligibility_reason: reason, suggested_shortlist: false,
    });
    data.get_preselection_groups = [{
      application_id: application, candidate_name: 'Kandydat testowy', group_key: 'passed',
      source: 'auto', raw_score: 95, coverage: 1,
      analysis_id: data.get_screening_ranking[0].analysis_id,
    }];
    const report = await load(data);
    assert.equal(report.groups.length, 1);
    assert.equal(report.groups[0].stale, true, reason);
    const csv = screeningReportCsv(report);
    assert.match(csv, /Wynik nieaktualny — wymaga ponownej analizy/, reason);
  }
});

test('a reviewed evidence-matrix candidate shows the group score, not "too few rated criteria / 0%"', async () => {
  const data = fixture();
  // v2 analysis after human review: neutral legacy rating, so SC-008 reports insufficient_evidence (Step 3 rule).
  Object.assign(data.screening_criterion_results[0], { rating: 'insufficient_data', verdict: 'supported', human_status: 'accepted', human_evidence: null });
  Object.assign(data.get_screening_ranking[0], { rank: null, rankable: false, eligibility_reason: 'insufficient_evidence', raw_score: null,
    coverage: '0.000', known_criteria: 0, below_count: 0, meets_count: 0, above_count: 0, insufficient_data_count: 1, suggested_shortlist: false });
  data.get_preselection_groups = [{ application_id: application, candidate_id: uuid(60), candidate_name: 'Jan Testowy', has_phone: true,
    group_key: 'passed', source: 'auto', raw_score: 83.33, coverage: 1, updated_at: timestamp, application_status: 'new',
    analysis_id: data.get_screening_ranking[0].analysis_id }];
  const report = await load(data);
  const { rankingStatusLabel } = await import('../lib/screening-report.ts');
  assert.equal(rankingStatusLabel(report.applications[0], true), 'Sprawdzone przez człowieka — wynik w tabeli grup');
  // Without a group row (e.g. a single-CV evidence analysis) the label never points to the groups table.
  assert.equal(rankingStatusLabel(report.applications[0], false), 'Sprawdzone przez człowieka');
  const filename = fileURLToPath(new URL('../app/dashboard/[companyId]/recruitments/[recruitmentId]/report/report-view.tsx', import.meta.url));
  const module = new Module(filename); module.filename = filename;
  const require = createRequire(filename);
  module.require = name => name.endsWith('.module.css') ? { default: new Proxy({}, { get: (_, key) => String(key) }), __esModule: true }
    : /\/lib\/[a-z-]+$/.test(name) ? require(name + '.ts') : require(name);
  module._compile(ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  const html = renderToStaticMarkup(React.createElement(module.exports.ScreeningReportView, { report, basePath: '/dashboard/test' }));
  assert.match(html, /Sprawdzone przez człowieka — wynik w tabeli grup/);
  assert.match(html, /83,33 <small>\(grupa\)<\/small>/);
  assert.doesNotMatch(html, /Za mało ocenionych kryteriów/);
  assert.doesNotMatch(html, /<td>0%<\/td>/);
  assert.match(html, /nie przelicza dowodów automatycznie/);
  // A stale group score is never shown as the candidate's score.
  const staleHtml = renderToStaticMarkup(React.createElement(module.exports.ScreeningReportView, { report: { ...report, groups: report.groups.map(g => ({ ...g, stale: true })) }, basePath: '/dashboard/test' }));
  assert.doesNotMatch(staleHtml, /\(grupa\)<\/small>/);
  assert.doesNotMatch(staleHtml, /83,33/, 'historical group score must not appear in the report');
  // CSV agrees with the page: the same status, no misleading 0 coverage.
  const csv = screeningReportCsv(report);
  assert.match(csv, /"Sprawdzone przez człowieka — wynik w tabeli grup"/);
  assert.doesNotMatch(csv, /"Za mało ocenionych kryteriów"/);
  // Status, score and coverage cells of that application row: coverage is empty, not 0.
  const line = csv.split('\r\n').find(l => l.includes('"Sprawdzone przez człowieka — wynik w tabeli grup"'));
  const cells = line.split(';');
  const status = cells.findIndex(c => c.includes('Sprawdzone przez człowieka'));
  assert.equal(cells[status + 2], '""', 'coverage cell is empty');
  // Stale group: the label no longer points to the groups table.
  assert.match(staleHtml, /<td>Sprawdzone przez człowieka<\/td>/);
  // A legacy (v1) candidate keeps the original label.
  assert.equal(rankingStatusLabel({ ranking: { eligibility_reason: 'insufficient_evidence' }, criteria: [{ matrixVerdict: null }] }, true), 'Za mało ocenionych kryteriów');
});

test('recruitment-page groups use the report currency rule: an outdated group shows no score as current', async () => {
  const { groupAnalysisCurrent } = await import('../lib/screening-report.ts');
  const a = '00000000-0000-4000-8000-0000000000a1', b = '00000000-0000-4000-8000-0000000000b2';
  assert.equal(groupAnalysisCurrent(a, { analysis_id: a, eligibility_reason: 'eligible' }), true);
  assert.equal(groupAnalysisCurrent(a.toUpperCase(), { analysis_id: a, eligibility_reason: 'eligible' }), true, 'UUIDs are case-insensitive');
  assert.equal(groupAnalysisCurrent(a, { analysis_id: a.toUpperCase(), eligibility_reason: 'eligible' }), true);
  assert.equal(groupAnalysisCurrent('a'.repeat(36), { analysis_id: 'a'.repeat(36), eligibility_reason: 'eligible' }), false,
    'matching malformed IDs may never establish currency');
  assert.equal(groupAnalysisCurrent(a, { analysis_id: b, eligibility_reason: 'eligible' }), false, 're-analysed outside the batch');
  assert.equal(groupAnalysisCurrent(a, { analysis_id: a, eligibility_reason: 'stale' }), false, 'CV or position changed');
  assert.equal(groupAnalysisCurrent(a, { analysis_id: a, eligibility_reason: 'needs_reanalysis' }), false);
  assert.equal(groupAnalysisCurrent(a, { analysis_id: a, eligibility_reason: 'insufficient_evidence' }), true,
    'human-reviewed evidence matrix remains valid without an automated score');
  for (const reason of ['no_human_review', 'pending', 'processing', 'failed', 'cancelled', 'no_completed_result',
    'result_incomplete', 'review_inconsistent', 'unknown']) {
    assert.equal(groupAnalysisCurrent(a, { analysis_id: a, eligibility_reason: reason }), false, reason);
  }
  assert.equal(groupAnalysisCurrent(a, undefined), false, 'no ranking row (e.g. ranking unreadable): fail closed');
  for (const bad of [null, undefined, '', 'not-a-uuid', 42]) assert.equal(groupAnalysisCurrent(bad, { analysis_id: a, eligibility_reason: 'eligible' }), false);

  const filename = fileURLToPath(new URL('../app/dashboard/[companyId]/recruitments/[recruitmentId]/bulk/groups.tsx', import.meta.url));
  const module = new Module(filename); module.filename = filename;
  const require = createRequire(filename);
  module.require = name => name === './actions' ? { movePreselectionGroup: async () => ({}) }
    : name.endsWith('/submit-button') ? { SubmitButton: ({ children }) => React.createElement('button', null, children) }
    : name.endsWith('/lib/cv-bulk') ? require('../../../../../../lib/cv-bulk.ts') : require(name);
  module._compile(ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  const row = { application_id: a, candidate_name: 'Kandydat nr 1', has_phone: true, group_key: 'passed', source: 'auto', raw_score: 83.33, coverage: 1, updated_at: '2026-11-02T10:00:00Z' };
  const render = stale => renderToStaticMarkup(React.createElement(module.exports.PreselectionGroups, { companyId: b, recruitmentId: b, rows: [{ ...row, stale }], canEdit: false }));
  const current = render(false), outdated = render(true);
  assert.match(current, /83 pkt/); assert.match(current, /pokrycie kryteriów 100%/); assert.doesNotMatch(current, /nieaktualny/);
  assert.match(outdated, /Wynik nieaktualny — wymaga ponownej analizy/);
  assert.doesNotMatch(outdated, /83 pkt|pokrycie kryteriów/, 'no historical score shown as current');
});

test('ranking currency: every page is read, a failed page fails closed; recruitment and batch pages use it', async () => {
  const { loadCurrentRanking, withGroupCurrency } = await import('../lib/preselection-currency.ts');
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const rows = Array.from({ length: 1203 }, (_, n) => ({ application_id: id(n), analysis_id: id(10000 + n), eligibility_reason: 'eligible' }));
  const client = (failAt = -1) => ({ calls: [], orders: [], rpc(fn, args) {
    const self = this;
    return { order(column, options) {
      self.orders.push([column, options?.ascending]);
      return { range(from, to) { self.calls.push([fn, args, from, to]);
        return Promise.resolve(from === failAt ? { data: null, error: { code: 'X' } } : { data: rows.slice(from, to + 1), error: null }); } };
    } };
  } });
  const ok = client();
  const map = await loadCurrentRanking(ok, id(9));
  assert.equal(map.size, 1203, 'all pages, not only the first');
  assert.deepEqual(ok.calls.map(c => [c[2], c[3]]), [[0, 499], [500, 999], [1000, 1499], [1203, 1702]],
    'an empty page, not a short page, ends pagination');
  assert.deepEqual(ok.orders, Array(4).fill(null).map(() => ['application_id', true]),
    'all ranking pages must use a stable application UUID order');
  assert.equal(await loadCurrentRanking(client(500), id(9)), null, 'a failed page fails closed');
  // A PostgREST installation can enforce a smaller max_rows than the requested
  // range. Each short page must be followed by the next offset until an empty
  // page, or cached group scores can be shown as current despite missing rows.
  const cappedClient = (failFrom = -1) => ({ calls: [], rpc() {
    const self = this;
    return { order(column, options) {
      assert.equal(column, 'application_id');
      assert.equal(options?.ascending, true);
      return { range(from, to) {
        self.calls.push([from, to]);
        return Promise.resolve(from === failFrom
          ? { data: null, error: { code: 'X' } }
          : { data: rows.slice(from, Math.min(to + 1, from + 37)), error: null });
      } };
    } };
  } });
  const capped = cappedClient();
  const complete = await loadCurrentRanking(capped, id(9));
  assert.equal(complete?.size, 1203, 'short RPC pages must not truncate later candidates');
  assert.deepEqual(capped.calls.at(-1), [1203, 1702], 'the last probe establishes EOF');
  assert.equal(capped.calls.length, Math.ceil(1203 / 37) + 1);
  assert.equal(withGroupCurrency([{ application_id: id(1202), group_key: 'passed',
    group_analysis_id: id(11202) }], complete)[0].group_current, true,
    'the final candidate must still be included in currency checks');
  assert.equal(await loadCurrentRanking(cappedClient(37), id(9)), null,
    'a failed short-page continuation must invalidate the whole ranking');
  const rankingClient = data => ({ rpc: () => ({ order: (column, options) => {
    assert.equal(column, 'application_id');
    assert.equal(options?.ascending, true);
    return { range: (from, to) => Promise.resolve({ data: data.slice(from, to + 1), error: null }) };
  } }) });
  const withLetters = { ...rows[0], application_id: 'aabbccdd-aabb-4ccd-8eaf-aabbccddeeff' };
  const duplicate = { ...withLetters, application_id: withLetters.application_id.toUpperCase(), analysis_id: id(99999) };
  const upperRow = { ...withLetters, application_id: withLetters.application_id.toUpperCase(),
    analysis_id: 'aabbccdd-aabb-4cdd-8eaf-aabbccddeeff' };
  const upperMap = await loadCurrentRanking(rankingClient([upperRow]), id(9));
  assert.equal(upperMap.has(withLetters.application_id), true, 'ranking map must use canonical keys');
  assert.deepEqual(withGroupCurrency([{ application_id: withLetters.application_id.toUpperCase(),
    group_key: 'passed', group_analysis_id: upperRow.analysis_id.toUpperCase() }], upperMap)
    .map(item => item.group_current), [true], 'mixed-case source IDs refer to the same group');
  assert.deepEqual(withGroupCurrency([{ application_id: withLetters.application_id.toUpperCase(),
    group_key: 'passed', analysis_id: upperRow.analysis_id.toUpperCase() }], upperMap)
    .map(item => item.group_current), [true],
    'recruitment RPC uses analysis_id, not group_analysis_id; mixed-case UUIDs remain current');
  assert.equal(withGroupCurrency([{ application_id: withLetters.application_id,
    group_key: 'passed', group_analysis_id: null, analysis_id: upperRow.analysis_id }], upperMap)[0].group_current, false,
    'an explicitly absent batch analysis link cannot be replaced by another field');
  assert.equal(withGroupCurrency([{ application_id: 'not-a-uuid',
    group_key: 'passed', analysis_id: upperRow.analysis_id }], upperMap)[0].group_current, false,
    'invalid recruitment group IDs cannot be confirmed');
  const recruitmentPage = readFileSync(new URL('../app/dashboard/[companyId]/recruitments/[recruitmentId]/page.tsx', import.meta.url), 'utf8');
  assert.match(recruitmentPage, /withGroupCurrency\s*\(/,
    'the recruitment screen must use the same normalized currency check as bulk progress');
  assert.equal(await loadCurrentRanking(rankingClient([withLetters, duplicate]), id(9)), null,
    'duplicate candidate IDs with different letter casing fail closed');
  assert.equal(await loadCurrentRanking(rankingClient([...rows.slice(0, 499), withLetters, duplicate]), id(9)), null,
    'a differently cased duplicate across pagination boundaries cannot override the first row');
  for (const malformed of [null, {}, { ...rows[0], application_id: 'not-a-uuid' }]) {
    assert.equal(await loadCurrentRanking(rankingClient([rows[0], malformed]), id(9)), null,
      'a malformed ranking page cannot confirm any group as current');
  }
  const oversized = Array.from({ length: 20500 }, (_, n) => ({
    ...rows[0], application_id: id(n), analysis_id: id(10000 + n),
  }));
  assert.equal(await loadCurrentRanking(rankingClient(oversized), id(9)), null,
    'a truncated ranking cannot mark the first 20k groups current while omitting the rest');
  const items = [
    { application_id: id(1200), group_key: 'passed', group_analysis_id: id(11200) },
    { application_id: id(1), group_key: 'passed', group_analysis_id: id(99999) },
    { application_id: id(2), group_key: 'passed' },
    { application_id: null, group_key: null },
  ];
  assert.deepEqual(withGroupCurrency(items, map).map(i => i.group_current), [true, false, false, false]);
  assert.deepEqual(withGroupCurrency(items, null).map(i => i.group_current), [false, false, false, false], 'unreadable ranking: outdated');
  for (const file of ['../app/dashboard/[companyId]/recruitments/[recruitmentId]/page.tsx', '../app/dashboard/[companyId]/recruitments/[recruitmentId]/bulk/[batchId]/page.tsx', '../app/dashboard/[companyId]/recruitments/[recruitmentId]/bulk/actions.ts']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(src, /loadCurrentRanking\(client, /, file);
    assert.doesNotMatch(src, /get_screening_ranking[^\n]*\.range\(0,\s*999\)/, file);
  }

  // The batch page shows an outdated group without its historical score.
  const filename = fileURLToPath(new URL('../app/dashboard/[companyId]/recruitments/[recruitmentId]/bulk/[batchId]/progress.tsx', import.meta.url));
  const module = new Module(filename); module.filename = filename;
  const require = createRequire(filename);
  module.require = name => name === '../actions' ? { bulkProgress: async () => null }
    : name === 'next/link' ? { __esModule: true, default: ({ children, ...props }) => React.createElement('a', props, children) }
    : name.endsWith('/lib/cv-bulk') ? require('../../../../../../../lib/cv-bulk.ts') : require(name);
  module._compile(ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  const item = { id: id(1), position: 1, file_name: 'cv.pdf', phase: 'done', error_reason: null, ocr_used: false, application_id: id(1),
    candidate_name: 'Kandydat nr 1', has_phone: true, group_key: 'passed', raw_score: 83.3, duplicate_of_application: null };
  const render = group_current => renderToStaticMarkup(React.createElement(module.exports.BatchProgress, { companyId: id(1), recruitmentId: id(2), batchId: id(3), billingHref: '/b',
    initial: { batch: { id: id(3), recruitment_id: id(2), status: 'completed', declared_files: 1, reserved_slots: 1, completed_at: null }, items: [{ ...item, group_current }] } }));
  assert.match(render(true), /83 pkt/);
  const outdated = render(false);
  assert.match(outdated, /Wynik nieaktualny — wymaga ponownej analizy/);
  assert.doesNotMatch(outdated, /83 pkt/, 'no historical score shown as current');
  assert.match(render(undefined), /Wynik nieaktualny/, 'missing flag means outdated');
});
