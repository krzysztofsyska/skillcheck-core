// SC-015-D — eksport CSV raportu kandydata i wpis audytowy.
// Dane są fikcyjne; żadnego prawdziwego CV, nazwiska ani firmy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANDIDATE_REPORT_EXPORT_VERSION, candidateReportCsv, candidateReportFilename, exportCandidateReport,
} from '../lib/candidate-report-export.ts';
import { CandidateReportError, buildCandidateRequirement, summariseCandidateReport } from '../lib/candidate-report.ts';
import { ScreeningNotFoundError } from '../lib/screening-flow.ts';
import { positionRequirements } from '../lib/requirement-flags.ts';

const companyA = '11111111-1111-4111-8111-111111111111';
const companyB = '22222222-2222-4222-8222-222222222222';
const recruitmentId = '33333333-3333-4333-8333-333333333333';
const applicationId = '44444444-4444-4444-8444-444444444444';
const auditId = '55555555-5555-4555-8555-555555555555';
const route = (companyId = companyA) => ({ companyId, recruitmentId, applicationId });

const requirements = positionRequirements({
  tasks: ['=HYPERLINK("http://x.invalid","klik")'], kpis: ['Terminowość dostaw'], required_competencies: ['Prawo jazdy kategorii B'],
});
const completed = { execution_status: 'completed' };
const criterion = (id, overrides = {}) => ({
  criterion_id: id, verdict: 'supported', evidence: [{ start: 0, end: 9, quote: 'DowodCV_1' }],
  missing_info: null, suggested_question: null, human_status: 'accepted',
  human_verdict: null, human_missing_info: null, human_suggested_question: null, human_evidence: null, ...overrides,
});
function report(overrides = {}) {
  const built = [
    buildCandidateRequirement(requirements[2], 'required', completed, criterion('competency:1', {
      verdict: 'missing', evidence: [], missing_info: '+48 500 000 000 wpisane jako brak', suggested_question: '@SUM(A1:A2)',
    })),
    buildCandidateRequirement(requirements[0], 'unmarked', completed, criterion('task:1', {
      human_status: 'edited', human_verdict: 'supported', human_evidence: [{ start: 3, end: 15, quote: '\t-2+3 KorektaCV' }],
    })),
    buildCandidateRequirement(requirements[1], 'unmarked', completed, criterion('kpi:1', { human_status: 'rejected' })),
  ];
  return {
    recruitmentName: 'Rekrutacja testowa', positionTitle: 'Kurier', applicationId,
    analysisVersion: 2, documentVersion: 1, stale: false, reanalysisRequested: false, legacyAnalysis: false,
    analysisStatus: 'completed', requirements: built, summary: summariseCandidateReport(built),
    generatedAt: '2026-11-16T10:00:00.000Z', ...overrides,
  };
}

/** Fałszywy klient: rejestruje wywołania RPC, nic nie łączy z siecią. */
function client({ user = { id: '66666666-6666-4666-8666-666666666666' }, rpc } = {}) {
  const calls = [];
  return {
    calls,
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    rpc: async (name, args) => {
      calls.push({ name, args });
      return rpc ? rpc(name, args) : { data: auditId, error: null };
    },
  };
}
const load = (value = report()) => async () => value;
const body = async response => Buffer.from(await response.arrayBuffer()).toString('utf8');
const cells = csv => csv.replace(/^﻿/, '').split('\r\n');

test('plik ma te same oceny i dowody co ekran oraz bezpieczne nagłówki', async () => {
  const fake = client();
  const response = await exportCandidateReport(fake, route(), { load: load() });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('content-type'), /^text\/csv; charset=utf-8$/);
  assert.equal(response.headers.get('content-disposition'),
    `attachment; filename="skillcheck-raport-kandydata-${applicationId}.csv"`);
  const csv = await body(response);
  assert.ok(csv.startsWith('﻿'));
  assert.ok(csv.includes(CANDIDATE_REPORT_EXPORT_VERSION));
  // Ekran: korekta rekrutera wygrywa, odrzucony wiersz nie publikuje dowodu AI.
  assert.ok(csv.includes('KorektaCV'));
  assert.ok(!csv.includes('DowodCV_1'), 'odrzucony i nadpisany dowód AI nie trafia do pliku');
  assert.ok(csv.includes('"Brak informacji w CV"'));
  assert.ok(csv.includes('"Wiersz odrzucony przez rekrutera"'));
  assert.ok(csv.includes('Nie jest decyzją o zatrudnieniu'));
  // Pusta grupa „Dodatkowe" zostaje w pliku, jak na ekranie.
  assert.ok(csv.includes('"Dodatkowe";"";"Brak wymagań w tej grupie."'));
  // Audyt: dokładnie jeden wpis, z identyfikatorami trasy i rodzajem eksportu.
  assert.deepEqual(fake.calls, [{ name: 'record_candidate_report_export', args: {
    target_company: companyA, target_recruitment: recruitmentId, target_application: applicationId,
    export_kind: 'candidate_report_csv', analysis_version: 2,
  } }]);
});

test('CSV jest odporny na wstrzyknięcie formuły (=, +, -, @, tabulator, CR)', () => {
  const csv = candidateReportCsv(report({ recruitmentName: '\r=1+1', positionTitle: '-cmd|calc' }));
  for (const line of cells(csv)) {
    if (!line) continue;
    for (const cell of line.split(/;(?=")/)) {
      const value = cell.slice(1);
      assert.doesNotMatch(value, /^[\s\u0000-\u001f]*[=+@-]/, `komórka zaczyna się od formuły: ${cell}`);
    }
  }
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x.invalid"",""klik"")"`));
  assert.ok(csv.includes(`"'+48 500 000 000`));
  assert.ok(csv.includes(`"'@SUM(A1:A2)"`));
  assert.ok(csv.includes(`"'\r=1+1"`));
  assert.ok(csv.includes(`"'-cmd|calc"`));
});

test('nazwa pliku nie zawiera nazwiska: tylko identyfikator zgłoszenia', () => {
  assert.equal(candidateReportFilename(applicationId.toUpperCase()), `skillcheck-raport-kandydata-${applicationId}.csv`);
  assert.match(candidateReportFilename(applicationId), /^skillcheck-raport-kandydata-[0-9a-f-]{36}\.csv$/);
});

test('nieprawidłowa trasa i brak logowania kończą się przed odczytem', async () => {
  let loaded = 0;
  const counting = async () => { loaded++; return report(); };
  const bad = await exportCandidateReport(client(), { ...route(), applicationId: 'x' }, { load: counting });
  assert.equal(bad.status, 400);
  const anonymous = client({ user: null });
  const denied = await exportCandidateReport(anonymous, route(), { load: counting });
  assert.equal(denied.status, 401);
  assert.equal(loaded, 0);
  assert.equal(anonymous.calls.length, 0);
});

test('po wycofaniu zgody eksport jest odmawiany i nie wydaje pliku', async () => {
  // 1) Dane zamrożone po wycofaniu zgody: RLS ukrywa zgłoszenie, warstwa odczytu odmawia.
  const hidden = client();
  const notFound = await exportCandidateReport(hidden, route(), {
    load: async () => { throw new ScreeningNotFoundError('Nie znaleziono zgłoszenia.'); },
  });
  assert.equal(notFound.status, 404);
  assert.equal(hidden.calls.length, 0, 'bez odczytu nie ma wpisu audytu');
  // 2) Zgoda wycofana między odczytem a wydaniem pliku: baza odmawia zapisu (55000).
  const withdrawn = client({ rpc: () => ({ data: null, error: { code: '55000', message: 'candidate_report_withdrawn' } }) });
  const refused = await exportCandidateReport(withdrawn, route(), { load: load() });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get('cache-control'), 'private, no-store');
  const json = await refused.json();
  assert.equal(json.error, 'withdrawn');
  assert.doesNotMatch(JSON.stringify(json), /KorektaCV|Rekrutacja testowa|candidate_report_withdrawn/);
});

test('błąd zapisu audytu = brak pliku (fail closed)', async () => {
  for (const rpc of [
    () => ({ data: null, error: { code: 'PGRST202', message: 'SECRET_SQL_DETAILS' } }),
    () => ({ data: null, error: null }),
    () => ({ data: ['not-a-uuid'], error: null }),
    () => { throw new Error('network SECRET_SQL_DETAILS'); },
  ]) {
    const response = await exportCandidateReport(client({ rpc }), route(), { load: load() });
    assert.equal(response.status, 503);
    assert.doesNotMatch(response.headers.get('content-type'), /text\/csv/);
    const text = await body(response);
    assert.doesNotMatch(text, /KorektaCV|SECRET_SQL_DETAILS/);
  }
});

test('izolacja firm: ten sam identyfikator zgłoszenia pod obcą firmą daje ten sam błąd co brak rekordu', async () => {
  // Firma B nie ma dostępu: baza odmawia 42501, odpowiedź jest identyczna jak przy braku rekordu.
  const foreign = client({ rpc: (_name, args) => args.target_company === companyB
    ? { data: null, error: { code: '42501', message: 'candidate_report_forbidden' } }
    : { data: auditId, error: null } });
  const responseB = await exportCandidateReport(foreign, route(companyB), { load: load() });
  const missing = await exportCandidateReport(client(), route(), {
    load: async () => { throw new ScreeningNotFoundError('Nie znaleziono zgłoszenia.'); },
  });
  assert.equal(responseB.status, 404);
  assert.deepEqual(await responseB.json(), await missing.json());
  const responseA = await exportCandidateReport(foreign, route(companyA), { load: load() });
  assert.equal(responseA.status, 200);
  // Raport innego zgłoszenia niż w adresie nie zostanie wydany.
  const mismatch = await exportCandidateReport(client(), route(), {
    load: load(report({ applicationId: '77777777-7777-4777-8777-777777777777' })),
  });
  assert.equal(mismatch.status, 409);
});

test('niespójny raport i nieoczekiwany błąd nie ujawniają szczegółów', async () => {
  const changed = await exportCandidateReport(client(), route(), {
    load: async () => { throw new CandidateReportError('Macierz dowodów zmieniła się podczas odczytu. Odśwież raport.'); },
  });
  assert.equal(changed.status, 409);
  const failed = await exportCandidateReport(client(), route(), {
    load: async () => { throw new Error('SECRET_SQL_DETAILS Jan Kowalski'); },
  });
  assert.equal(failed.status, 500);
  assert.doesNotMatch(await body(failed), /SECRET_SQL_DETAILS|Kowalski/);
});

// SC-015-D2 — historia eksportu na ekranie raportu.
import {
  EXPORT_HISTORY_LIMIT, exportHistoryEmptyMessage, exportHistoryErrorMessage, exportHistoryView, loadCandidateReportExportHistory,
} from '../lib/candidate-report-export.ts';

const actor = '77777777-7777-4777-8777-777777777777';
const historyRow = (overrides = {}) => ({ exported_at: '2026-11-16T10:00:00+00:00', actor_id: actor, actor_role: 'recruiter', is_me: false, ...overrides });

test('historia eksportu: odczyt przez list_candidate_report_exports z trasą w małych literach', async () => {
  const fake = client({ rpc: () => ({ data: [historyRow({ is_me: true }), historyRow({ actor_role: 'owner' })], error: null }) });
  const history = await loadCandidateReportExportHistory(fake, { companyId: companyA.toUpperCase(), recruitmentId, applicationId });
  assert.deepEqual(fake.calls, [{ name: 'list_candidate_report_exports', args: {
    target_company: companyA, target_recruitment: recruitmentId, target_application: applicationId,
  } }]);
  assert.equal(history.ok, true);
  const view = exportHistoryView(history);
  assert.equal(view.kind, 'list');
  assert.equal(view.truncated, false);
  assert.deepEqual(view.items.map(item => item.who), ['Ty (rekruter)', 'Właściciel konta firmy']);
  // Czas pokazywany w strefie Warszawy (UTC+1 w listopadzie).
  assert.match(view.items[0].when, /11:00:00/);
  assert.ok(!JSON.stringify(view).includes(actor), 'identyfikator konta nie trafia na ekran');
});

test('historia eksportu: pusty stan', async () => {
  const history = await loadCandidateReportExportHistory(client({ rpc: () => ({ data: [], error: null }) }), route());
  assert.deepEqual(exportHistoryView(history), { kind: 'empty', message: exportHistoryEmptyMessage });
  assert.equal(exportHistoryEmptyMessage, 'Ten raport nie był jeszcze eksportowany.');
});

test('historia eksportu: każdy błąd odczytu daje neutralny komunikat, nie wyjątek', async () => {
  const cases = [
    () => ({ data: null, error: { code: '42501', message: 'candidate_report_forbidden' } }),
    () => ({ data: null, error: null }),
    () => ({ data: [historyRow({ actor_role: 'admin' })], error: null }),
    () => ({ data: [historyRow({ actor_id: 'nie-uuid' })], error: null }),
    () => ({ data: [historyRow({ exported_at: 'wczoraj' })], error: null }),
    () => ({ data: [historyRow({ is_me: 'tak' })], error: null }),
    () => ({ data: Array.from({ length: EXPORT_HISTORY_LIMIT + 1 }, () => historyRow()), error: null }),
    () => { throw new Error('sieć'); },
  ];
  for (const rpc of cases) {
    const view = exportHistoryView(await loadCandidateReportExportHistory(client({ rpc }), route()));
    assert.deepEqual(view, { kind: 'error', message: exportHistoryErrorMessage });
    assert.doesNotMatch(view.message, /42501|forbidden|sieć/);
  }
  const fake = client();
  assert.deepEqual(await loadCandidateReportExportHistory(fake, { ...route(), applicationId: 'x' }), { ok: false });
  assert.equal(fake.calls.length, 0);
});

test('historia eksportu: przy 50 wpisach informacja o limicie, osoba spoza zespołu ma etykietę', () => {
  const entries = Array.from({ length: EXPORT_HISTORY_LIMIT }, (_, i) => ({
    exportedAt: new Date(Date.UTC(2026, 10, 16, 10, 0, 0) - i * 60000).toISOString(), actorId: actor,
    actorRole: i ? 'viewer' : 'former_member', isMe: false,
  }));
  const view = exportHistoryView({ ok: true, entries });
  assert.equal(view.truncated, true);
  assert.equal(view.items[0].who, 'Osoba spoza obecnego zespołu');
  assert.equal(view.items[1].who, 'Czytelnik');
  assert.equal(new Set(view.items.map(item => item.key)).size, EXPORT_HISTORY_LIMIT);
});
