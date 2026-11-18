// SC-AC-SESSION-EXPORT — CSV podsumowania sesji Assessment Center.
// Dane syntetyczne; żadnego prawdziwego kandydata ani firmy. Fałszywy klient nie łączy się z siecią.
// To NIE jest test RLS ani autoryzacji RPC (tests/ac-session-database.test.mjs) — tu sprawdzamy,
// że eksport pyta tymi samymi zapytaniami co strona i nie dokłada niczego ponad to, co strona pokazuje.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AC_ASSESSOR_OUTSIDE_TEAM, AC_ASSESSOR_UNKNOWN, AC_SESSION_EXPORT_VERSION, AC_TEXT_WITHHELD, acAssessorLabels, acSessionCsv, acSessionExportFilename, exportAcSession,
  loadAcAssessorNames,
} from '../lib/assessment-center-session-export.ts';
import { buildAssessmentCenterSessionReport, parseAssessmentCenterSession } from '../lib/assessment-center-session.ts';
import { ids, sessionPayload } from './helpers/ac-session-payload.mjs';

const companyId = '90000000-0000-4000-8000-0000000000c1';
const foreignCompany = '90000000-0000-4000-8000-0000000000c2';
const positionId = '90000000-0000-4000-8000-0000000000d1';
const recruitmentId = ids.recruitment;
const candidateA = '90000000-0000-4000-8000-0000000000e1', candidateB = '90000000-0000-4000-8000-0000000000e2';
const now = () => new Date('2026-11-16T10:00:00.000Z');
const auditId = '90000000-0000-4000-8000-0000000000b1';

function blindPayload() {
  const payload = sessionPayload();
  const finalist = payload.finalists[0];
  finalist.textHidden = true;
  finalist.expertNotes = [];
  finalist.stages[0].entries = finalist.stages[0].entries.filter(entry => entry.kind !== 'feedback' && entry.kind !== 'change_proof');
  return payload;
}

/** Minimalny PostgREST: filtruje tylko po parametrach eq/in, które wysyła kod — jak stub w testach HTTP. */
function fakeClient({ user = { id: ids.owner }, tables = {}, payload = sessionPayload(), findError = null, readError = null, audit = () => ({ data: auditId, error: null }),
  // R3-AC-NAMES: domyślnie funkcji nazw nie ma (jak przed migracją) — zostają etykiety z PR #500.
  names = () => ({ data: null, error: { code: 'PGRST202', message: 'function not found' } }) } = {}) {
  const calls = [];
  const data = {
    companies: [{ id: companyId, owner_id: ids.owner }],
    company_members: [{ company_id: companyId, user_id: ids.recruiter, role: 'recruiter' }],
    recruitments: [{ id: recruitmentId, company_id: companyId, position_id: positionId, name: 'Rekrutacja =HRBP' }],
    positions: [{ id: positionId, company_id: companyId }],
    applications: [
      { id: ids.applicationA, company_id: companyId, recruitment_id: recruitmentId, candidate_id: candidateA },
      { id: ids.applicationB, company_id: companyId, recruitment_id: recruitmentId, candidate_id: candidateB },
    ],
    candidates: [
      { id: candidateA, company_id: companyId, first_name: 'Anna', last_name: 'Syntetyczna' },
      { id: candidateB, company_id: companyId, first_name: '=cmd|', last_name: 'Formuła' },
    ],
    ...tables,
  };
  const query = table => {
    const filters = [];
    const result = () => (data[table] ?? []).filter(row => filters.every(([column, values]) => values.includes(row[column])));
    const builder = {
      select: columns => { calls.push({ table, columns }); return builder; },
      eq: (column, value) => { filters.push([column, [value]]); return builder; },
      in: (column, values) => { filters.push([column, values]); return builder; },
      maybeSingle: async () => ({ data: result()[0] ?? null, error: null }),
      then: (resolve, reject) => Promise.resolve({ data: result(), error: null }).then(resolve, reject),
    };
    return builder;
  };
  return {
    calls,
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    from: query,
    rpc: async (name, args) => {
      calls.push({ rpc: name, args });
      if (name === 'ac_session_find') return findError ? { data: null, error: findError } : { data: payload ? ids.session : null, error: null };
      if (name === 'ac_session_read') return readError ? { data: null, error: readError } : { data: payload, error: null };
      if (name === 'record_assessment_center_session_export') return audit(args);
      if (name === 'ac_assessor_display_names') return names(args);
      throw new Error(`unexpected rpc ${name}`);
    },
  };
}
const route = (company = companyId, recruitment = recruitmentId) => ({ companyId: company, recruitmentId: recruitment });
const body = async response => Buffer.from(await response.arrayBuffer()).toString('utf8');
const run = (client, r = route(), enabled = true) => exportAcSession(client, r, { enabled, now });

test('plik: bezpieczne nagłówki, BOM, nazwa bez nazwisk, oceny obu asesorów i jawna rozbieżność', async () => {
  const fake = fakeClient();
  const response = await run(fake);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('content-type'), 'text/csv; charset=utf-8');
  const disposition = response.headers.get('content-disposition');
  assert.equal(disposition, `attachment; filename="skillcheck-assessment-center-${recruitmentId}-2026-11-16.csv"`);
  assert.doesNotMatch(disposition, /Anna|Syntetyczna|Formu|HRBP/);
  const csv = await body(response);
  assert.ok(csv.startsWith('﻿'));
  assert.ok(csv.includes(AC_SESSION_EXPORT_VERSION));
  assert.ok(csv.includes('"Sesja otwarta"'));
  // Finalista jak na stronie: imię i nazwisko; kolejność = kolejność dodania.
  assert.ok(csv.indexOf('"Anna Syntetyczna"') < csv.indexOf(`"'=cmd| Formuła"`));
  const diagnosis = csv.split('\r\n').find(line => line.includes('"Diagnoza przyczyn"') && line.includes('Anna'));
  assert.match(diagnosis, /"Ty";"Powyżej wymagań";"Członek zespołu 1";"Zgodne z wymaganiami";"Zgodne z wymaganiami"/);
  // ROADMAP R3: asesorzy z czytelnej etykiety, nigdy z identyfikatora konta.
  assert.ok(!csv.includes(ids.owner) && !csv.includes(ids.recruiter), 'brak identyfikatorów asesorów w pliku');
  assert.ok(csv.includes('"rozbieżność (czeka na potwierdzenie)"'));
  assert.ok(csv.includes('UzasadnienieUzgodnienia'), 'uzasadnienie widoczne na stronie jest w pliku');
  assert.ok(csv.includes('"Zmiana potwierdzona dowodem"'));
  // Tylko znaczniki prób — bez treści pracy kandydata i bez wyniku ogólnego.
  assert.ok(!csv.includes('PierwszaProba') && !csv.includes('PoprawionaPraca') && !csv.includes('NotatkaEksperta'));
  assert.doesNotMatch(csv, /ranking[^u]|wynik ogólny:|rekomendacja/i);
  // Ten sam klient RLS i to samo RPC co strona; żadnego service_role.
  // Wpis audytowy jako ostatni krok przed wydaniem pliku (SC-AC-EXPORT-AUDIT).
  assert.deepEqual(fake.calls.filter(call => call.rpc).map(call => call.rpc), ['ac_session_find', 'ac_session_read', 'ac_assessor_display_names', 'record_assessment_center_session_export']);
  assert.deepEqual(fake.calls.at(-1).args, {
    target_company: companyId, target_recruitment: recruitmentId, target_session: ids.session, export_kind: 'ac_session_csv',
  });
});

test('audyt: bez udanego wpisu nie ma pliku — 503 bez CSV; odmowa bazy 42501 = 404', async () => {
  const failures = [
    () => ({ data: null, error: { code: 'PGRST202', message: 'function not found' } }),
    () => ({ data: null, error: { code: '57014' } }),
    () => ({ data: null, error: null }),
    () => ({ data: 'nie-uuid', error: null }),
    () => { throw new Error('network'); },
  ];
  for (const audit of failures) {
    const response = await run(fakeClient({ audit }));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('content-disposition'), null);
    assert.match(response.headers.get('content-type'), /application\/json/);
    const text = await body(response);
    assert.equal(JSON.parse(text).error, 'audit_failed');
    assert.doesNotMatch(text, /Anna|Syntetyczna|Formuła|Wersja eksportu|ac-session-csv/);
  }
  const denied = await run(fakeClient({ audit: () => ({ data: null, error: { code: '42501' } }) }));
  assert.equal(denied.status, 404);
  assert.doesNotMatch(await body(denied), /Anna|Syntetyczna/);
  // Wpis z rolą rekrutera: plik wydany dopiero po udanym zapisie.
  const recruiter = fakeClient({ user: { id: ids.recruiter } });
  const ok = await run(recruiter);
  assert.equal(ok.status, 200);
  assert.ok((await body(ok)).includes(AC_SESSION_EXPORT_VERSION));
  assert.equal(recruiter.calls.filter(call => call.rpc === 'record_assessment_center_session_export').length, 1);
});

test('audyt: przy błędach odczytu i braku dostępu nic nie jest zapisywane', async () => {
  for (const client of [fakeClient({ user: null }), fakeClient({ payload: null }), fakeClient({ findError: { code: 'PGRST202' } }), fakeClient({ readError: { code: 'XX000' } })]) {
    await run(client);
    assert.ok(!client.calls.some(call => call.rpc === 'record_assessment_center_session_export'));
  }
});

test('ochrona przed formułami: każda komórka zaczynająca się od =, +, -, @ dostaje apostrof', () => {
  const report = buildAssessmentCenterSessionReport(parseAssessmentCenterSession(sessionPayload()));
  const csv = acSessionCsv({ recruitmentId, recruitmentName: '=HYPERLINK("http://x.invalid")', generatedAt: now().toISOString(),
    viewerId: ids.owner, report, finalistLabel: () => '\t@SUM(A1)' });
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x.invalid"")"`));
  assert.ok(csv.includes(`"'\t@SUM(A1)"`));
  for (const cell of csv.replace(/^﻿/, '').split(/[;\r\n]+/).filter(Boolean)) {
    assert.doesNotMatch(cell, /^"[\s]*[=+@-]/, cell);
  }
});

test('#338: sekcja „Brak dowodu” — każdy brak z powodem i etykietą asesora, bez identyfikatorów i cudzych tekstów', async () => {
  const lines = (await body(await run(fakeClient()))).split('\r\n');
  const header = lines.indexOf('"Finalista";"Zgłoszenie";"Kompetencja";"Etap";"Brak dowodu"');
  assert.ok(header > 0, 'sekcja braków jest w pliku');
  const gaps = lines.slice(header + 1).filter(Boolean);
  assert.deepEqual(gaps.filter(line => line.startsWith('"Anna Syntetyczna"')).map(line => line.split(';').slice(2).join(';')), [
    '"Myślenie finansowe";"Etap 2 — konsekwencje finansowe";"Czeka na oddanie obu niezależnych arkuszy."',
    '"Myślenie finansowe";"Etap 3 — plan zmiany";"Niewystarczające dane, bez dowodu: Asesor 2 (Członek zespołu 1)."',
    '"Planowanie zmiany";"Etap 4 — rozmowa z dyrektorem operacyjnym";"Nie przypisano asesorów — brak arkuszy."',
    '"Komunikacja z biznesem";"Etap 4 — rozmowa z dyrektorem operacyjnym";"Nie przypisano asesorów — brak arkuszy."',
  ]);
  assert.equal(gaps.filter(line => line.includes('Formuła')).length, 6);
  const section = gaps.join('\n');
  assert.ok(!section.includes(ids.owner) && !section.includes(ids.recruiter));
  assert.doesNotMatch(section, /AsesorPierwszy|AsesorDrugi|Uzasadnienie|OpisRozbieznosci|NotatkaEksperta/);
  // Pełny dowód od obu asesorów: jawne „brak braków”, a nie pusta sekcja.
  const full = sessionPayload();
  full.session.plannedCompetencies = ['Diagnoza przyczyn'];
  full.finalists = full.finalists.slice(0, 1);
  const csv = await body(await run(fakeClient({ payload: full })));
  assert.match(csv, /"Anna Syntetyczna";"[0-9a-f-]+";"";"";"Brak braków: każda kompetencja ma dowód od obu asesorów w każdym etapie\."/);
});

test('ślepa ocena: bez własnego arkusza plik nie zawiera tekstów innych asesorów ani eksperta', async () => {
  const csv = await body(await run(fakeClient({ payload: blindPayload() })));
  for (const hidden of ['InformacjaZwrotna', 'OpisZmiany', 'DowodZmiany', 'NotatkaEksperta', 'UzasadnienieUzgodnienia', 'OpisRozbieznosci', 'UzasadnienieDrugie']) {
    assert.ok(!csv.includes(hidden), hidden);
  }
  assert.ok(csv.includes(AC_TEXT_WITHHELD));
  // Oceny widoczne na stronie zostają.
  assert.ok(csv.includes('"Powyżej wymagań"'));
});

test('ślepa ocena działa także, gdy dane mimo wszystko zawierają cudzy wpis (obrona w głąb)', () => {
  const report = buildAssessmentCenterSessionReport(parseAssessmentCenterSession(sessionPayload()));
  const leaked = { ...report, finalists: report.finalists.map(finalist => ({ ...finalist, textHidden: true })) };
  const csv = acSessionCsv({ recruitmentId, recruitmentName: 'R', generatedAt: now().toISOString(), viewerId: ids.recruiter, report: leaked, finalistLabel: () => 'F' });
  assert.ok(!csv.includes('Zmiana potwierdzona dowodem'));
  assert.ok(!csv.includes('UzasadnienieUzgodnienia') && !csv.includes('OpisRozbieznosci'));
  assert.ok(csv.includes(AC_TEXT_WITHHELD));
});

test('dostęp: niezalogowany 401, obca firma/rekrutacja lub brak sesji 404, podgląd wyłączony 404', async () => {
  assert.equal((await run(fakeClient({ user: null }))).status, 401);
  assert.equal((await run(fakeClient(), route(foreignCompany))).status, 404);
  assert.equal((await run(fakeClient(), route(companyId, '90000000-0000-4000-8000-0000000000f9'))).status, 404);
  assert.equal((await run(fakeClient({ payload: null }))).status, 404);
  assert.equal((await run(fakeClient(), route(), false)).status, 404);
  assert.equal((await run(fakeClient(), route('nie-uuid'))).status, 400);
  // Członek bez roli rekrutera (ani nie właściciel) nie widzi strony, więc nie dostaje pliku.
  const viewer = '90000000-0000-4000-8000-0000000000aa';
  const member = fakeClient({ user: { id: viewer }, tables: { company_members: [{ company_id: companyId, user_id: viewer, role: 'viewer' }] } });
  const denied = await run(member);
  assert.equal(denied.status, 404);
  assert.ok(!member.calls.some(call => call.rpc), 'bez uprawnień nie ma odczytu sesji');
  // Rekruter firmy ma dostęp jak na stronie.
  assert.equal((await run(fakeClient({ user: { id: ids.recruiter } }))).status, 200);
});

test('błędy: brak RPC 503, uszkodzone dane 409, sesja innej rekrutacji 409; komunikat bez danych kandydata', async () => {
  const unavailable = await run(fakeClient({ findError: { code: 'PGRST202' } }));
  assert.equal(unavailable.status, 503);
  const broken = sessionPayload(); broken.finalists[0].stages[0].pair.sheets[1].authorId = ids.owner;
  const changed = await run(fakeClient({ payload: broken }));
  assert.equal(changed.status, 409);
  assert.equal(changed.headers.get('cache-control'), 'private, no-store');
  assert.doesNotMatch(await body(changed), /Anna|Syntetyczna/);
  const other = sessionPayload(); other.session.recruitmentId = '90000000-0000-4000-8000-0000000000f8';
  assert.equal((await run(fakeClient({ payload: other }))).status, 409);
  assert.equal((await run(fakeClient({ readError: { code: 'XX000' } }))).status, 500);
});

test('nazwa pliku: tylko identyfikator rekrutacji i data', () => {
  assert.equal(acSessionExportFilename(recruitmentId.toUpperCase(), '2026-11-16T23:59:59.000Z'), `skillcheck-assessment-center-${recruitmentId}-2026-11-16.csv`);
  assert.throws(() => acSessionExportFilename('Anna Syntetyczna', '2026-11-16T00:00:00.000Z'));
});

test('strona i trasa: link „Pobierz CSV” tylko przy istniejącej sesji, trasa bez service_role, wspólne etykiety', () => {
  const dir = 'app/dashboard/[companyId]/recruitments/[recruitmentId]/assessment-center';
  const page = readFileSync(`${dir}/page.tsx`, 'utf8');
  const routeSource = readFileSync(`${dir}/export/route.ts`, 'utf8');
  const link = page.indexOf('Pobierz CSV');
  assert.ok(link > page.indexOf("read.state === 'invalid'"), 'link dopiero po wczytaniu i weryfikacji sesji');
  assert.match(page, /readAcSession\(client, recruitmentId\)/);
  assert.match(page, /acAgreementText\(row\.agreement, who\)/);
  assert.match(page, /acEvidenceGapText\(gap, who\)/, '#338: ten sam tekst braków na stronie i w pliku');
  assert.match(routeSource, /createClient\(\)/);
  assert.match(routeSource, /assessmentCenterPreviewEnabled\(\)/);
  assert.doesNotMatch(routeSource + readFileSync('lib/assessment-center-session-export.ts', 'utf8'), /SERVICE_ROLE|serviceRole|createAdminClient/);
});

test('ROADMAP R3: etykiety asesorów — „Ty”, „Właściciel firmy”, „Członek zespołu N” wg kolejności dołączenia, nigdy identyfikator', () => {
  const a = '90000000-0000-4000-8000-0000000000a1', b = '90000000-0000-4000-8000-0000000000a2', gone = '90000000-0000-4000-8000-0000000000a9';
  const team = [
    { user_id: b, role: 'recruiter', created_at: '2026-11-02T10:00:00Z' },
    { user_id: a, role: 'viewer', created_at: '2026-11-01T10:00:00Z' },
  ];
  const owner = acAssessorLabels(ids.owner, ids.owner, team);
  assert.equal(owner(ids.owner), 'Ty');
  assert.equal(owner(a), 'Członek zespołu 1');
  assert.equal(owner(b), 'Członek zespołu 2');
  assert.equal(owner(gone), AC_ASSESSOR_OUTSIDE_TEAM);
  const recruiter = acAssessorLabels(b, ids.owner, [...team].reverse());
  assert.equal(recruiter(ids.owner), 'Właściciel firmy');
  assert.equal(recruiter(b), 'Ty');
  assert.equal(recruiter(a), 'Członek zespołu 1', 'numeracja nie zależy od kolejności zwróconych wierszy');
  // Bez listy zespołu: neutralnie, bez identyfikatora.
  const unknown = acAssessorLabels(b, ids.owner, null);
  assert.equal(unknown(a), AC_ASSESSOR_UNKNOWN);
  for (const label of [owner, recruiter, unknown]) for (const id of [ids.owner, a, b, gone]) assert.doesNotMatch(label(id), /[0-9a-f]{8}-/);
  // CSV bez przekazanych etykiet też nie pokazuje identyfikatorów.
  const report = buildAssessmentCenterSessionReport(parseAssessmentCenterSession(sessionPayload()));
  const csv = acSessionCsv({ recruitmentId, recruitmentName: 'R', generatedAt: now().toISOString(), viewerId: ids.recruiter, report, finalistLabel: () => 'F' });
  assert.ok(!csv.includes(ids.owner) && !csv.includes(ids.recruiter));
});

test('ROADMAP R3: strona sesji i arkusze par nie wyświetlają identyfikatora asesora', () => {
  const dir = 'app/dashboard/[companyId]/recruitments/[recruitmentId]';
  const page = readFileSync(`${dir}/assessment-center/page.tsx`, 'utf8');
  const sheets = readFileSync(`${dir}/paired-assessor-sheets.tsx`, 'utf8');
  const form = readFileSync(`${dir}/paired-assessor-form.tsx`, 'utf8');
  assert.match(page, /const who = acAssessorLabels\(user\.id, company\.owner_id, team, assessorNames\)/);
  assert.match(page, /loadAcAssessorNames\(client, companyId, recruitmentId\)/);
  assert.match(sheets, /acAssessorLabels\(user\.id, company\.owner_id/);
  assert.doesNotMatch(page + sheets + form, /'Ty' : (id|sheet\.authorId)\b/);
  assert.match(form, /\{label\}<\/option>/);
});

test('R3-AC-NAMES: nazwy asesorów tylko z RPC; „Ty” bez zmian, reszta z etykiet, nigdy identyfikator', async () => {
  const a = '90000000-0000-4000-8000-0000000000a1', gone = '90000000-0000-4000-8000-0000000000a9';
  const team = [{ user_id: a, role: 'recruiter', created_at: '2026-11-01T10:00:00Z' }];
  const names = new Map([[ids.owner, 'wlasciciel@example.invalid'], [a, 'rekruter@example.invalid']]);
  const asRecruiter = acAssessorLabels(a, ids.owner, team, names);
  assert.equal(asRecruiter(a), 'Ty');
  assert.equal(asRecruiter(ids.owner), 'wlasciciel@example.invalid (właściciel firmy)');
  assert.equal(asRecruiter(gone), AC_ASSESSOR_OUTSIDE_TEAM, 'usunięty członek: bez nazwy');
  const asOwner = acAssessorLabels(ids.owner, ids.owner, team, names);
  assert.equal(asOwner(a), 'rekruter@example.invalid');
  // Bez nazw (null albo pusta mapa) — dokładnie etykiety z PR #500.
  for (const none of [null, new Map()]) assert.equal(acAssessorLabels(ids.owner, ids.owner, team, none)(a), 'Członek zespołu 1');

  // Odczyt: argumenty RPC, walidacja wierszy, każdy błąd = null (fallback), bez wyjątku.
  const rows = [
    { user_id: a.toUpperCase(), display_name: ' rekruter@example.invalid ' },
    { user_id: 'nie-uuid', display_name: 'x@example.invalid' },
    { user_id: gone, display_name: '' },
    { user_id: gone, display_name: 'y'.repeat(321) },
    { user_id: gone, display_name: 42 },
    null,
  ];
  let seen;
  const ok = await loadAcAssessorNames({ rpc: async (name, args) => { seen = { name, args }; return { data: rows, error: null }; } }, companyId, recruitmentId);
  assert.deepEqual(seen, { name: 'ac_assessor_display_names', args: { target_company: companyId, target_recruitment: recruitmentId } });
  assert.deepEqual([...ok], [[a, 'rekruter@example.invalid']]);
  for (const rpc of [async () => ({ data: null, error: { code: '42501' } }), async () => ({ data: {}, error: null }), async () => { throw new Error('network'); }]) {
    assert.equal(await loadAcAssessorNames({ rpc }, companyId, recruitmentId), null);
  }
});

test('R3-AC-NAMES: CSV pokazuje nazwę tylko, gdy baza ją wydała; odmowa bazy = etykiety, plik nadal wydany', async () => {
  const withNames = fakeClient({ names: args => args.target_company === companyId && args.target_recruitment === recruitmentId
    ? { data: [{ user_id: ids.recruiter, display_name: '=rekruter@example.invalid' }], error: null } : { data: null, error: { code: '42501' } } });
  const response = await run(withNames);
  assert.equal(response.status, 200);
  const csv = await body(response);
  const diagnosis = csv.split('\r\n').find(line => line.includes('"Diagnoza przyczyn"') && line.includes('Anna'));
  // Nazwa przechodzi przez csvCell (ochrona przed formułami); „Ty” bez zmian.
  assert.match(diagnosis, /"Ty";"Powyżej wymagań";"'=rekruter@example\.invalid";/);
  assert.ok(!csv.includes(ids.owner) && !csv.includes(ids.recruiter));
  const denied = fakeClient({ names: () => ({ data: null, error: { code: '42501' } }) });
  const fallback = await body(await run(denied));
  assert.match(fallback, /"Ty";"Powyżej wymagań";"Członek zespołu 1";/);
  assert.doesNotMatch(fallback, /example\.invalid/);
});
