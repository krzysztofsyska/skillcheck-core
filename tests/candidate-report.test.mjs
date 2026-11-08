// SC-015 / #268 — wspólny odczyt raportu kandydata i porównania.
// Dane kandydatów są fikcyjne; żadnego prawdziwego CV ani nazwiska.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCandidateRequirement, criterionRowFor, fallbackGapQuestion, requirementStatus,
  requirementStatusLabels, summariseCandidateReport,
} from '../lib/candidate-report.ts';
import {
  buildCandidateComparison, comparisonCandidates, comparisonStatus, MAX_COMPARISON_CANDIDATES,
} from '../lib/candidate-comparison.ts';
import {
  positionRequirements, resolveRequirementMarks, sortByRequirementMark,
} from '../lib/requirement-flags.ts';
import { prepareScreening } from '../lib/screening.ts';
import { buildInterviewGaps } from '../lib/interview-gaps.ts';

const position = {
  tasks: ['Dostarczanie przesyłek', 'Rozliczanie tras'],
  kpis: ['Terminowość dostaw'],
  required_competencies: ['Prawo jazdy kategorii B'],
};
const requirements = positionRequirements(position);
const licence = requirements.find(r => r.id === 'competency:1');

const row = (overrides = {}) => ({
  criterion_id: 'competency:1', verdict: 'supported',
  evidence: [{ start: 0, end: 7, quote: 'dowód AI' }],
  missing_info: null, suggested_question: null, human_status: 'accepted',
  human_verdict: null, human_missing_info: null, human_suggested_question: null, human_evidence: null,
  ...overrides,
});
const completed = { execution_status: 'completed' };

test('analiza w toku to nie jest brak informacji w CV', () => {
  assert.equal(requirementStatus(null, undefined), 'in_progress');
  assert.equal(requirementStatus({ execution_status: 'pending' }, row()), 'in_progress');
  assert.equal(requirementStatus({ execution_status: 'processing' }, row()), 'in_progress');
  assert.equal(requirementStatus(completed, row({ verdict: 'missing', evidence: [] })), 'missing');
  // Etykiety muszą się różnić — to jest sedno rozróżnienia dla rekrutera.
  assert.notEqual(requirementStatusLabels.in_progress, requirementStatusLabels.missing);
  assert.equal(requirementStatus({ execution_status: 'failed' }, row()), 'unavailable');
  assert.equal(requirementStatus(completed, undefined), 'unavailable');
  assert.equal(requirementStatus(completed, row({ verdict: null })), 'legacy');
  assert.equal(requirementStatus(completed, row({ human_status: 'rejected' })), 'rejected');
});

test('wymagane prawo jazdy bez wzmianki w CV: brak informacji, pytanie i brak cytatu', () => {
  const built = buildCandidateRequirement(licence, 'required', completed, row({
    verdict: 'missing', evidence: [], missing_info: 'CV nie wspomina o prawie jazdy.',
    suggested_question: 'Czy posiadasz prawo jazdy kategorii B?',
  }));
  assert.equal(built.status, 'missing');
  assert.equal(built.quotes.length, 0);
  assert.equal(built.missingInfo, 'CV nie wspomina o prawie jazdy.');
  assert.equal(built.question, 'Czy posiadasz prawo jazdy kategorii B?');
  // Bez zapisanego pytania widok nadal podaje pytanie — to samo, co „Przygotowanie do rozmowy".
  const withoutQuestion = buildCandidateRequirement(licence, 'required', completed,
    row({ verdict: 'missing', evidence: [], suggested_question: null }));
  assert.equal(withoutQuestion.question, fallbackGapQuestion);
  // Potwierdzone wymaganie o nic nie pyta.
  assert.equal(buildCandidateRequirement(licence, 'required', completed, row()).question, null);
});

test('korekta rekrutera wygrywa, odrzucony wiersz nie publikuje dowodu AI', () => {
  const edited = buildCandidateRequirement(licence, 'required', completed, row({
    verdict: 'missing', evidence: [], human_status: 'edited', human_verdict: 'supported',
    human_evidence: [{ start: 0, end: 5, quote: 'dowód człowieka' }],
    human_suggested_question: 'Pytanie rekrutera',
  }));
  assert.equal(edited.status, 'supported');
  assert.equal(edited.quotes[0].quote, 'dowód człowieka');
  assert.equal(edited.corrected, true);
  const rejected = buildCandidateRequirement(licence, 'required', completed, row({ human_status: 'rejected' }));
  assert.equal(rejected.status, 'rejected');
  assert.deepEqual(rejected.quotes, []);
  assert.equal(rejected.question, fallbackGapQuestion);
  assert.equal(rejected.corrected, true);
});

test('FREE: uszkodzony zakres cytatu nie jest zastępowany fikcyjną pozycją w CV', () => {
  const valid = { start: 10, end: 25, quote: 'prawidłowy dowód' };
  const built = buildCandidateRequirement(licence, 'required', completed, row({
    evidence: [
      { quote: 'bez zakresu' },
      { start: -1, end: 3, quote: 'ujemny offset' },
      { start: 8, end: 3, quote: 'odwrócony zakres' },
      { start: 1.5, end: 4, quote: 'ułamkowy offset' },
      { start: 0, end: 1_000_001, quote: 'poza limitem' },
      valid,
    ],
  }));
  assert.deepEqual(built.quotes, [valid], 'only real, bounded offsets may reach either report view');
  assert.equal(built.status, 'supported', 'one corrupt citation does not erase the human-reviewed verdict');
});

test('odrzucony wiersz zostaje odrzucony także w nieaktualnej analizie', () => {
  // Decyzja człowieka o wierszu bije stan całej analizy. Inaczej nieaktualna
  // analiza przywracałaby na ekran cytat AI, który rekruter wprost odrzucił.
  const rejected = row({ human_status: 'rejected', missing_info: 'czegoś brakuje' });
  for (const analysis of [completed, { execution_status: 'completed', outdated: true }]) {
    const built = buildCandidateRequirement(licence, 'required', analysis, rejected);
    assert.equal(built.status, 'rejected');
    assert.deepEqual(built.quotes, []);
    assert.equal(built.missingInfo, null);
    assert.equal(built.question, fallbackGapQuestion);
    assert.equal(built.corrected, true);
  }
});

test('potwierdzenie, którego nikt nie sprawdził, nie jest potwierdzeniem', () => {
  const unreviewed = buildCandidateRequirement(licence, 'required', completed,
    row({ verdict: 'supported', human_status: 'unreviewed' }));
  assert.equal(unreviewed.status, 'awaiting_review');
  assert.equal(summariseCandidateReport([unreviewed]).requiredSupported, 0);
  assert.equal(summariseCandidateReport([unreviewed]).requiredPending, 1);
  // Dowód zostaje na ekranie — etykieta mówi, że czeka na sprawdzenie.
  assert.equal(unreviewed.quotes.length, 1);
  // Zgodność z lib/interview-gaps.ts: tam ten sam wiersz nie liczy się jako supported.
  assert.equal(buildInterviewGaps([{ id: 'x', criterion_id: 'competency:1', criterion_kind: 'competency',
    criterion_text_snapshot: licence.text, criterion_order: 1, verdict: 'supported',
    missing_info: null, suggested_question: null, human_status: 'unreviewed',
    human_verdict: null, human_missing_info: null, human_suggested_question: null }]).supported, 0);
  // Sprawdzone potwierdzenie liczy się normalnie.
  assert.equal(buildCandidateRequirement(licence, 'required', completed,
    row({ verdict: 'supported', human_status: 'accepted' })).status, 'supported');
  // Nieznany stan przeglądu czyta się jako niesprawdzony, nie jako potwierdzenie.
  assert.equal(buildCandidateRequirement(licence, 'required', completed,
    row({ verdict: 'supported', human_status: 'jakiś_nowy_stan' })).status, 'awaiting_review');
  // Korekta człowieka na „supported" to sprawdzenie samo w sobie.
  assert.equal(buildCandidateRequirement(licence, 'required', completed,
    row({ verdict: 'missing', human_status: 'edited', human_verdict: 'supported' })).status, 'supported');
  // Werdykt o luce idzie dalej mimo braku sprawdzenia: on o niczym nie przesądza.
  assert.equal(buildCandidateRequirement(licence, 'required', completed,
    row({ verdict: 'missing', evidence: [], human_status: 'unreviewed' })).status, 'missing');
});

test('starszy profil: brak oznaczeń znaczy nieoznaczone, nie konieczne', () => {
  const marks = resolveRequirementMarks(requirements, []);
  assert.deepEqual([...marks.values()], requirements.map(() => 'unmarked'));
  const summary = summariseCandidateReport(requirements.map(r =>
    buildCandidateRequirement(r, marks.get(r.id), completed, row({ criterion_id: r.id }))));
  assert.equal(summary.requiredTotal, 0);
  assert.equal(summary.unmarkedTotal, requirements.length);
});

test('oznaczenie nieaktualne po zmianie treści wymagania nie przykleja się do innego', () => {
  const marks = resolveRequirementMarks(requirements, [
    { criterion_id: 'competency:1', criterion_text: 'Prawo jazdy kategorii C', flag: 'required' },
    { criterion_id: 'task:1', criterion_text: 'Dostarczanie przesyłek', flag: 'required' },
    { criterion_id: 'task:2', criterion_text: 'Rozliczanie tras', flag: 'nonsens' },
  ]);
  assert.equal(marks.get('competency:1'), 'unmarked', 'inny tekst pod tym samym identyfikatorem');
  assert.equal(marks.get('task:1'), 'required');
  assert.equal(marks.get('task:2'), 'unmarked', 'nieznana etykieta jest ignorowana');
});

test('kolejność: konieczne, potem nieoznaczone, na końcu dodatkowe', () => {
  const marks = resolveRequirementMarks(requirements, [
    { criterion_id: 'task:1', criterion_text: 'Dostarczanie przesyłek', flag: 'additional' },
    { criterion_id: 'kpi:1', criterion_text: 'Terminowość dostaw', flag: 'required' },
  ]);
  assert.deepEqual(sortByRequirementMark(requirements, marks).map(r => r.id),
    ['kpi:1', 'task:2', 'competency:1', 'task:1']);
});

test('wiersz analizy z innym tekstem nie dokleja się do nowego wymagania', () => {
  // Profil zmieniony po analizie: competency:1 to dziś kategoria C, a analiza
  // pracowała na kategorii B. Bez sprawdzenia tekstu raport pokazałby przy nowym
  // wymaganiu cudzy werdykt i cudzy cytat — i policzył je jako potwierdzone.
  const stale = {
    ...row({ verdict: 'supported', evidence: [{ start: 0, end: 24, quote: 'prawo jazdy kategorii B' }] }),
    criterion_text_snapshot: 'Prawo jazdy kategorii B',
  };
  const current = { ...licence, text: 'Prawo jazdy kategorii C' };
  const built = buildCandidateRequirement(current, 'required', completed, criterionRowFor(current, stale));
  assert.equal(built.status, 'unavailable');
  assert.deepEqual(built.quotes, []);
  assert.equal(summariseCandidateReport([built]).requiredSupported, 0);
  // Ten sam tekst nadal przechodzi.
  assert.equal(buildCandidateRequirement(licence, 'required', completed, criterionRowFor(licence, stale)).status, 'supported');
  // Brak snapshotu w wierszu też nie przechodzi — nie zgadujemy.
  assert.equal(criterionRowFor(licence, row()), undefined);
});

// --- pełny odczyt raportu przez loadCandidateReport (nie tylko czyste funkcje) ---

// Podwójny klient w kształcie PostgREST: filtry, sortowanie i limity działają,
// więc test przechodzi tą samą drogą co produkcja, zamiast składać wynik ręcznie.
function loaderClient(data, afterRead = () => {}, modifyResult = (_table, result) => result) {
  function query(table) {
    const q = { eqs: [], order: null, limit: Infinity, single: false, columns: '*' };
    return {
      select(columns = '*') { q.columns = columns; return this; },
      eq(key, value) { q.eqs.push([key, value]); return this; },
      order(key, options) { q.order = [key, options?.ascending === false]; return this; },
      limit(value) { q.limit = value; return this; },
      maybeSingle() { q.single = true; return this; },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          let rows = (data[table] ?? []).filter(r => q.eqs.every(([k, v]) => r[k] === v));
          if (q.order) {
            const [key, descending] = q.order;
            // Kolumny takie jak review_version są w bazie liczbami, a nie tekstem:
            // sortowanie tekstowe stawiałoby wersję 10 przed 2 i test nie dowodziłby,
            // że loader bierze najnowszy przegląd.
            rows = [...rows].sort((a, b) => typeof a[key] === 'number' && typeof b[key] === 'number'
              ? a[key] - b[key] : String(a[key]).localeCompare(String(b[key])));
            if (descending) rows.reverse();
          }
          rows = rows.slice(0, q.limit);
          if (q.columns !== '*') rows = rows.map(row => Object.fromEntries(
            q.columns.split(',').map(key => [key, row[key]])));
          const result = { data: structuredClone(q.single ? rows[0] ?? null : rows), error: null };
          afterRead(table);
          return modifyResult(table, result);
        }).then(resolve, reject);
      },
    };
  }
  return { from: table => query(table), rpc: name => query(name) };
}

const id = n => `0000000${n}-0000-4000-8000-00000000000${n}`;
const route = { companyId: id(1), recruitmentId: id(2), applicationId: id(3) };
const loaderData = ({ competencyText = 'Prawo jazdy kategorii B', snapshot = 'Prawo jazdy kategorii B',
  disposition = 'approved', verdict = 'supported' } = {}) => withFingerprint({
  applications: [{ id: route.applicationId, company_id: route.companyId, recruitment_id: route.recruitmentId,
    candidate_id: id(4), status: 'new', updated_at: '2026-11-04T10:00:00Z' }],
  recruitments: [{ id: route.recruitmentId, company_id: route.companyId, position_id: id(5),
    name: 'Rekrutacja', status: 'open', updated_at: '2026-11-04T10:00:00Z' }],
  positions: [{ id: id(5), company_id: route.companyId, title: 'Kurier', status: 'active',
    tasks: ['Dostarczanie przesyłek'], kpis: ['Terminowość dostaw'],
    required_competencies: [competencyText], updated_at: '2026-11-04T10:00:00Z' }],
  candidate_documents: [{ id: id(6), company_id: route.companyId, candidate_id: id(4), version: 1,
    status: 'reviewed', reviewed_by: id(7), reviewed_at: '2026-11-04T10:00:00Z',
    redacted_text: 'Dostarczanie przesyłek, terminowość dostaw, prawo jazdy kategorii B.' }],
  screening_analysis_versions: [{ id: id(8), company_id: route.companyId, application_id: route.applicationId,
    recruitment_id: route.recruitmentId, analysis_version: 1, execution_status: 'completed',
    input_fingerprint: 'fp', stale_at: null, candidate_document_version: 1,
    latest_review_version: disposition ? 1 : 0 }],
  screening_criterion_results: [{ analysis_id: id(8), company_id: route.companyId, criterion_id: 'competency:1',
    criterion_text_snapshot: snapshot, verdict,
    evidence: [{ start: 0, end: 23, quote: 'prawo jazdy kategorii B' }],
    missing_info: null, suggested_question: null, human_status: 'accepted',
    human_verdict: null, human_missing_info: null, human_suggested_question: null, human_evidence: null }],
  // Sprawdzenie jest dwustopniowe, więc „ścieżka szczęśliwa" ma domknięty także
  // przegląd całej analizy; disposition: null znaczy, że go jeszcze nie ma.
  screening_result_reviews: disposition
    ? [{ analysis_id: id(8), company_id: route.companyId, review_version: 1, disposition }] : [],
  position_requirement_flags: [{ criterion_id: 'competency:1', criterion_text: competencyText, flag: 'required' }],
});

// Analiza jest aktualna tylko wtedy, gdy jej odcisk zgadza się z materiałem.
// Liczymy go tą samą funkcją co produkcja, żeby fixture nie udawał aktualności.
function withFingerprint(data) {
  data.screening_analysis_versions[0].input_fingerprint = prepareScreening({
    companyId: route.companyId, application: data.applications[0],
    recruitment: data.recruitments[0], position: data.positions[0],
    document: data.candidate_documents[0],
  }).fingerprint;
  return data;
}

test('SC-005: context rejects foreign and malformed Data API identities before CV reporting or AI', async () => {
  const { loadScreeningContext, ScreeningNotFoundError } = await import('../lib/screening-flow.ts');
  // Every mutation happens AFTER filtering and projection: test the trust boundary,
  // not the mock's normal equality filters. No production or customer data.
  const cases = [
    ['applications', 'id', id(9)],
    ['applications', 'company_id', id(9)],
    ['applications', 'recruitment_id', id(9)],
    ['applications', 'candidate_id', 'invalid-candidate-id'],
    ['recruitments', 'id', id(9)],
    ['recruitments', 'company_id', id(9)],
    ['recruitments', 'position_id', 'invalid-position-id'],
    ['positions', 'id', id(9)],
    ['positions', 'company_id', id(9)],
    ['candidate_documents', 'id', 'invalid-document-id'],
    ['candidate_documents', 'company_id', id(9)],
    ['candidate_documents', 'candidate_id', id(9)],
  ];
  for (const [table, field, value] of cases) {
    const client = loaderClient(loaderData(), () => {}, (selectedTable, result) => {
      if (selectedTable !== table || !result.data) return result;
      return { ...result, data: { ...result.data, [field]: value } };
    });
    await assert.rejects(() => loadScreeningContext(client, route),
      error => error instanceof ScreeningNotFoundError,
      `Mismatched ${table}.${field} must never reach a CV or provider payload`);
  }
  const valid = await loadScreeningContext(loaderClient(loaderData()), route);
  assert.equal(valid.application.id, route.applicationId);
  assert.equal(valid.document.candidate_id, valid.application.candidate_id);

  // SQL UUIDs compare case-insensitively; a case-only difference is not a new tenant.
  const uppercase = loaderClient(loaderData(), () => {}, (table, result) =>
    table === 'applications' ? { ...result, data: { ...result.data, id: route.applicationId.toUpperCase() } } : result);
  assert.equal((await loadScreeningContext(uppercase, route)).application.id.toLowerCase(), route.applicationId);
});

test('loadCandidateReport: zakończona analiza z pustą macierzą pokazuje ostrzeżenie', async () => {
  const { loadCandidateReport } = await import('../lib/candidate-report.ts');
  const legacy = loaderData();
  legacy.screening_criterion_results = [];
  const report = await loadCandidateReport(loaderClient(legacy), route);
  assert.equal(report.analysisStatus, 'completed');
  assert.equal(report.legacyAnalysis, true, 'brak wierszy nie może wyglądać jak kompletna nowa analiza');
  assert.equal(report.requirements.find(r => r.id === 'competency:1').status, 'unavailable');
  assert.equal(report.summary.requiredSupported, 0);

  const pending = loaderData();
  pending.screening_criterion_results = [];
  pending.screening_analysis_versions[0].execution_status = 'processing';
  const inProgress = await loadCandidateReport(loaderClient(pending), route);
  assert.equal(inProgress.legacyAnalysis, false, 'pusty wynik analizy w toku nie jest starszym formatem');
});

test('loadCandidateReport: zmieniona treść wymagania nie dziedziczy cudzego wyniku', async () => {
  const { loadCandidateReport } = await import('../lib/candidate-report.ts');
  const same = await loadCandidateReport(loaderClient(loaderData()), route);
  const found = same.requirements.find(r => r.id === 'competency:1');
  assert.equal(found.status, 'supported');
  assert.equal(found.quotes[0].quote, 'prawo jazdy kategorii B');
  assert.equal(same.summary.requiredSupported, 1);

  // Profil zmieniony po analizie: ten sam identyfikator, inny tekst.
  const changed = await loadCandidateReport(
    loaderClient(loaderData({ competencyText: 'Prawo jazdy kategorii C' })), route);
  const stale = changed.requirements.find(r => r.id === 'competency:1');
  assert.equal(stale.text, 'Prawo jazdy kategorii C');
  assert.equal(stale.status, 'unavailable', 'nowe wymaganie nie dostaje werdyktu poprzedniego');
  assert.deepEqual(stale.quotes, []);
  assert.equal(changed.summary.requiredSupported, 0);
});

test('loadCandidateReport: duplikat lub wiersz z obcej analizy nie zmienia potwierdzeń', async () => {
  const { loadCandidateReport, CandidateReportError } = await import('../lib/candidate-report.ts');
  const mutations = [
    rows => rows.push({ ...rows[0], verdict: 'missing', evidence: [], human_status: 'accepted' }),
    rows => { rows[0].analysis_id = id(9); },
    rows => { delete rows[0].analysis_id; },
    rows => { rows[0].criterion_id = ''; },
    rows => { rows[0].criterion_id = null; },
  ];
  for (const mutate of mutations) {
    // Wstrzykujemy wadliwy wiersz dopiero PO filtrach PostgREST. Zmiana w
    // źródłowej tablicy testowej byłaby odfiltrowana przez .eq('analysis_id')
    // i nie sprawdziłaby walidacji odpowiedzi w loadCandidateReport.
    const client = loaderClient(loaderData(), () => {}, (table, result) => {
      if (table === 'screening_criterion_results') mutate(result.data);
      return result;
    });
    await assert.rejects(() => loadCandidateReport(client, route),
      error => error instanceof CandidateReportError && /Macierz dowodów jest niespójna/.test(error.message));
  }
  // Prawidłowy raport nadal pokazuje zatwierdzone wymaganie i jego źródło.
  const valid = await loadCandidateReport(loaderClient(loaderData()), route);
  assert.equal(valid.requirements.find(r => r.id === 'competency:1').status, 'supported');
  assert.equal(valid.summary.requiredSupported, 1);
});

test('loadCandidateReport: niespójne oznaczenia nie zmieniają podsumowania FREE', async () => {
  const { loadCandidateReport, CandidateReportError } = await import('../lib/candidate-report.ts');
  const malformed = [
    rows => null, // SETOF RPC must return an array, including when it is empty
    rows => rows[0], // list payload must not be a single object
    rows => [...rows, { ...rows[0], flag: 'additional' }], // ambiguity: required or additional?
    rows => [null],
    rows => [{ ...rows[0], criterion_id: null }],
    rows => [{ ...rows[0], criterion_id: '   ' }],
    rows => [{ ...rows[0], criterion_text: null }],
    rows => [{ ...rows[0], flag: null }],
  ];
  for (const mutate of malformed) {
    // Inject after RPC processing, not into the source fixture: the bad
    // provider response must reach loadRequirementFlags unchanged.
    const client = loaderClient(loaderData(), () => {}, (table, result) =>
      table === 'position_requirement_flags' ? { ...result, data: mutate(result.data) } : result);
    await assert.rejects(() => loadCandidateReport(client, route),
      error => error instanceof CandidateReportError && /Oznaczenia wymagań są niespójne/.test(error.message));
  }

  const legacy = loaderData();
  legacy.position_requirement_flags = [];
  const empty = await loadCandidateReport(loaderClient(legacy), route);
  assert.equal(empty.summary.requiredTotal, 0);
  assert.equal(empty.summary.unmarkedTotal, empty.requirements.length);

  const unknownFlag = loaderData();
  unknownFlag.position_requirement_flags[0].flag = 'legacy-unknown';
  const unknown = await loadCandidateReport(loaderClient(unknownFlag), route);
  assert.equal(unknown.summary.requiredTotal, 0, 'unknown text flag remains unmarked');
  const valid = await loadCandidateReport(loaderClient(loaderData()), route);
  assert.equal(valid.summary.requiredSupported, 1);
});

test('loadCandidateReport: niespójna odpowiedź historii przeglądu nie potwierdza CV', async () => {
  const { loadCandidateReport, CandidateReportError } = await import('../lib/candidate-report.ts');
  const malformed = [
    rows => null,
    rows => ({ ...rows[0] }), // PostgREST list query must return an array
    rows => [...rows, { ...rows[0] }], // limit(1) contract broken
    rows => [null],
    rows => [{ ...rows[0], analysis_id: id(9) }],
    rows => [{ ...rows[0], analysis_id: undefined }],
    rows => [{ ...rows[0], review_version: '1' }],
    rows => [{ ...rows[0], review_version: 0 }],
    rows => [{ ...rows[0], disposition: null }],
    rows => [{ ...rows[0], disposition: '   ' }],
  ];
  for (const mutate of malformed) {
    // Fault injection happens AFTER PostgREST filters, projection and limit,
    // otherwise the fixture would hide mismatched rows from the loader.
    const client = loaderClient(loaderData(), () => {}, (table, result) =>
      table === 'screening_result_reviews' ? { ...result, data: mutate(result.data) } : result);
    await assert.rejects(() => loadCandidateReport(client, route),
      error => error instanceof CandidateReportError && /Historia sprawdzenia jest niespójna/.test(error.message));
  }

  // An absent review is legitimate, but it must never turn into an approval.
  const unreviewed = await loadCandidateReport(loaderClient(loaderData({ disposition: null })), route);
  assert.equal(unreviewed.summary.requiredSupported, 0);
  assert.equal(unreviewed.requirements.find(r => r.id === 'competency:1').status, 'awaiting_review');
});

test('loadCandidateReport: analiza odesłana do powtórzenia nie uchodzi za potwierdzenie', async () => {
  const { loadCandidateReport } = await import('../lib/candidate-report.ts');
  const report = await loadCandidateReport(
    loaderClient(loaderData({ disposition: 'needs_reanalysis' })), route);
  assert.equal(report.reanalysisRequested, true);
  const found = report.requirements.find(r => r.id === 'competency:1');
  assert.equal(found.status, 'outdated');
  assert.equal(report.summary.requiredSupported, 0, 'odrzucona analiza nie liczy się jako potwierdzenie');
  assert.equal(report.summary.requiredPending, 1);
  // Zatwierdzona analiza zachowuje się normalnie.
  const approved = await loadCandidateReport(loaderClient(loaderData({ disposition: 'approved' })), route);
  assert.equal(approved.requirements.find(r => r.id === 'competency:1').status, 'supported');

  // Liczy się najnowszy przegląd, nie pierwszy ani ostatni wstawiony.
  const many = loaderData({ disposition: 'approved' });
  many.screening_analysis_versions[0].latest_review_version = 10;
  many.screening_result_reviews = [
    { analysis_id: id(8), company_id: route.companyId, review_version: 10, disposition: 'needs_reanalysis' },
    { analysis_id: id(8), company_id: route.companyId, review_version: 2, disposition: 'approved' },
  ];
  assert.equal((await loadCandidateReport(loaderClient(many), route)).reanalysisRequested, true);
  many.screening_result_reviews.reverse();
  assert.equal((await loadCandidateReport(loaderClient(many), route)).reanalysisRequested, true);
  // Odwrotnie: najnowszy przegląd zatwierdza mimo starszego żądania powtórki.
  const settled = loaderData();
  settled.screening_analysis_versions[0].latest_review_version = 10;
  settled.screening_result_reviews = [
    { analysis_id: id(8), company_id: route.companyId, review_version: 2, disposition: 'needs_reanalysis' },
    { analysis_id: id(8), company_id: route.companyId, review_version: 10, disposition: 'approved' },
  ];
  assert.equal((await loadCandidateReport(loaderClient(settled), route)).reanalysisRequested, false);
});

test('loadCandidateReport: niezatwierdzona analiza nie daje potwierdzeń, tak jak porównanie', async () => {
  const { loadCandidateReport } = await import('../lib/candidate-report.ts');
  // Wiersz zaakceptowany, ale przeglądu całej analizy jeszcze nie ma. Porównanie
  // dla takiej analizy pokazuje „Oczekuje na sprawdzenie przez człowieka", więc
  // raport nie może w tym samym momencie mówić „Potwierdzone w CV".
  const report = await loadCandidateReport(loaderClient(loaderData({ disposition: null })), route);
  const found = report.requirements.find(r => r.id === 'competency:1');
  assert.equal(found.status, 'awaiting_review');
  assert.equal(report.summary.requiredSupported, 0);
  assert.equal(report.summary.requiredPending, 1);
  assert.equal(found.quotes.length, 1, 'dowód zostaje na ekranie do sprawdzenia');
  // Oba widoki nazywają ten sam przypadek tak samo.
  assert.equal(found.status,
    comparisonStatus({ ranking: { eligibility_reason: 'no_human_review' }, criteria: [] }, undefined));
});

test('loadCandidateReport: poprawka macierzy unieważnia historyczne zatwierdzenie, ponowny review je przywraca', async () => {
  const { loadCandidateReport } = await import('../lib/candidate-report.ts');
  const data = loaderData();
  // Ta sama analiza i materiał; zmienia się tylko wiersz macierzy. RPC podbija
  // rewizję analizy, zachowując poprzedni przegląd w historii.
  data.screening_analysis_versions[0].latest_review_version = 2;
  data.screening_criterion_results[0].human_status = 'edited';
  data.screening_criterion_results[0].human_verdict = 'supported';
  data.screening_criterion_results[0].human_evidence = [{ start: 0, end: 7, quote: 'korekta' }];
  const report = await loadCandidateReport(loaderClient(data), route);
  const found = report.requirements.find(r => r.id === 'competency:1');
  assert.equal(found.status,
    comparisonStatus({ ranking: { eligibility_reason: 'review_inconsistent' }, criteria: [] }, undefined));
  assert.equal(report.summary.requiredSupported, 0);
  assert.equal(report.summary.requiredPending, 1);
  assert.equal(found.corrected, true);
  assert.equal(found.quotes[0].quote, 'korekta');

  // Nowy przegląd całej macierzy jest osobną rewizją, zgodną z wersją analizy.
  data.screening_analysis_versions[0].latest_review_version = 3;
  data.screening_result_reviews.push({ analysis_id: id(8), company_id: route.companyId,
    review_version: 3, disposition: 'approved' });
  const approved = await loadCandidateReport(loaderClient(data), route);
  assert.equal(approved.requirements.find(r => r.id === 'competency:1').status, 'supported');
  assert.equal(approved.summary.requiredSupported, 1);
});

test('loadCandidateReport: zmiana macierzy między odczytami nie publikuje mieszanego raportu', async () => {
  const { loadCandidateReport, CandidateReportError } = await import('../lib/candidate-report.ts');
  for (const changeAfter of ['screening_analysis_versions', 'screening_criterion_results']) {
    const data = loaderData();
    let changed = false;
    const client = loaderClient(data, table => {
      if (table === changeAfter && !changed) {
        changed = true;
        data.screening_analysis_versions[0].latest_review_version++;
        data.screening_criterion_results[0].human_status = 'rejected';
      }
    });
    await assert.rejects(() => loadCandidateReport(client, route), CandidateReportError);
  }
});

test('loadCandidateReport: review zmienione w trakcie odczytu nie zatwierdza starego wyniku FREE', async () => {
  const { loadCandidateReport, CandidateReportError } = await import('../lib/candidate-report.ts');
  for (const scenario of ['revoke', 'new-review']) {
    const data = loaderData({ disposition: scenario === 'new-review' ? null : 'approved' });
    let reviewReads = 0;
    const client = loaderClient(data, table => {
      if (table !== 'screening_result_reviews' || ++reviewReads !== 1) return;
      // Change the review without changing screening_analysis_versions. Its existing
      // final re-read alone must not treat the first review as a consistent snapshot.
      if (scenario === 'revoke') data.screening_result_reviews[0].disposition = 'needs_reanalysis';
      else data.screening_result_reviews.push({
        analysis_id: id(8), company_id: route.companyId,
        review_version: 1, disposition: 'approved',
      });
    });
    await assert.rejects(() => loadCandidateReport(client, route),
      error => error instanceof CandidateReportError && /Wynik lub przegląd zmienił się/.test(error.message),
      scenario);
  }
  // An unchanged reviewed analysis remains available.
  assert.equal((await loadCandidateReport(loaderClient(loaderData()), route)).summary.requiredSupported, 1);
});

test('loadCandidateReport: równoległa zmiana macierzy bez zmiany analizy lub review unieważnia raport', async () => {
  const { loadCandidateReport, CandidateReportError } = await import('../lib/candidate-report.ts');
  for (const scenario of ['rejected', 'quote-changed', 'row-deleted']) {
    const data = loaderData();
    let criterionReads = 0;
    const client = loaderClient(data, table => {
      if (table !== 'screening_criterion_results' || ++criterionReads !== 1) return;
      // The first query has already returned a snapshot. No analysis/review
      // revision changes here: only a second matrix read can catch the race.
      if (scenario === 'rejected') data.screening_criterion_results[0].human_status = 'rejected';
      if (scenario === 'quote-changed') {
        data.screening_criterion_results[0].evidence = [{ start: 0, end: 9, quote: 'inny cytat' }];
      }
      if (scenario === 'row-deleted') data.screening_criterion_results = [];
    });
    await assert.rejects(() => loadCandidateReport(client, route),
      error => error instanceof CandidateReportError && /Macierz dowodów zmieniła się/.test(error.message),
      scenario);
    assert.equal(criterionReads, 2, 'both snapshots must come from the same scoped query');
  }
  const stable = await loadCandidateReport(loaderClient(loaderData()), route);
  assert.equal(stable.summary.requiredSupported, 1, 'unchanged human-approved evidence still works');
});

test('loadCandidateReport: pusta odpowiedź RPC nie udaje braku dowodów kandydata', async () => {
  const { loadCandidateReport, CandidateReportError } = await import('../lib/candidate-report.ts');
  for (const faultyRead of [1, 2]) {
    let reads = 0;
    const client = loaderClient(loaderData(), () => {}, (table, result) => {
      if (table === 'screening_criterion_results' && ++reads === faultyRead) {
        return { ...result, data: null, error: null };
      }
      return result;
    });
    await assert.rejects(() => loadCandidateReport(client, route),
      error => error instanceof CandidateReportError && /Macierz dowodów/.test(error.message));
  }
  assert.equal((await loadCandidateReport(loaderClient(loaderData()), route)).summary.requiredSupported, 1);
});

test('loadCandidateReport: nieaktualny materiał nie wymazuje cytatów rekruterowi', async () => {
  const { loadCandidateReport } = await import('../lib/candidate-report.ts');
  // Zamknięta rekrutacja albo zmienione CV sprawiają, że odcisk materiału się nie
  // zgadza. Wynik jest wtedy nieaktualny — ale rekruter ma dalej widzieć cytaty,
  // tak jak widzi je w macierzy dowodów. Liczy się tylko to, żeby takie wymaganie
  // nie uchodziło za potwierdzone.
  const data = loaderData();
  data.screening_analysis_versions[0].input_fingerprint = 'odcisk-sprzed-zmiany';
  const report = await loadCandidateReport(loaderClient(data), route);
  assert.equal(report.stale, true);
  const found = report.requirements.find(r => r.id === 'competency:1');
  assert.equal(found.status, 'outdated');
  assert.equal(found.quotes[0].quote, 'prawo jazdy kategorii B', 'cytat zostaje na ekranie');
  assert.equal(report.summary.requiredSupported, 0, 'ale wymaganie nie uchodzi za potwierdzone');
  assert.equal(report.summary.requiredPending, 1);
});

test('loadCandidateReport: jeden wiersz bez werdyktu wystarczy do ostrzeżenia o starszej analizie', async () => {
  const { loadCandidateReport } = await import('../lib/candidate-report.ts');
  const data = loaderData();
  data.screening_criterion_results.push({ ...data.screening_criterion_results[0],
    criterion_id: 'task:1', criterion_text_snapshot: 'Dostarczanie przesyłek', verdict: null });
  const report = await loadCandidateReport(loaderClient(data), route);
  assert.equal(report.legacyAnalysis, true);
  assert.equal(report.requirements.find(r => r.id === 'task:1').status, 'legacy');
});

// --- porównanie: jedno i pięć fikcyjnych CV ---

const criterion = (requirement, verdict, quote, reviewedChange = false) => ({
  id: requirement.id, kind: requirement.kind, text: requirement.text,
  aiRating: 'insufficient_data', rating: 'insufficient_data', reviewedChange,
  matrixVerdict: verdict, explanation: null,
  evidence: quote ? [{ start: 0, end: quote.length, quote }] : [],
});
const application = (index, { verdict = 'supported', reason = 'insufficient_evidence', shortlist = false, reviewedChange = false } = {}) => ({
  ranking: {
    application_id: `0000000${index}-0000-4000-8000-000000000000`, rank: index,
    rankable: false, eligibility_reason: reason, shortlist_entry_id: null,
  },
  shortlist: shortlist ? { entry_id: 'e' + index } : null,
  // Raport rekrutacji wczytuje kryteria tylko dla analiz sprawdzonych przez człowieka.
  criteria: reason !== 'insufficient_evidence' && reason !== 'eligible' ? []
    : requirements.map(r => criterion(r, r.id === 'competency:1' ? 'missing' : verdict,
      r.id === 'competency:1' ? null : 'cytat ' + index, reviewedChange)),
});
const report = (applications, flags = []) => ({
  version: 'screening-report-v1', generatedAt: '2026-11-04T10:00:00.000Z',
  companyId: 'c', companyName: 'Firma', recruitmentId: 'r', recruitmentName: 'Rekrutacja',
  positionTitle: 'Kurier', targetSize: 5,
  requirements: [
    ...position.tasks.map(text => ({ kind: 'task', text })),
    ...position.kpis.map(text => ({ kind: 'kpi', text })),
    ...position.required_competencies.map(text => ({ kind: 'competency', text })),
  ],
  applications, requirementFlags: flags,
});

test('porównanie jednego CV: wiersze to wymagania, jedna kolumna', () => {
  const comparison = buildCandidateComparison(report([application(1)]));
  assert.equal(comparison.candidates.length, 1);
  assert.equal(comparison.rows.length, requirements.length);
  assert.deepEqual(comparison.rows.map(r => r.cells.length), requirements.map(() => 1));
  const licenceRow = comparison.rows.find(r => r.id === 'competency:1');
  assert.equal(licenceRow.cells[0].status, 'missing');
  assert.equal(licenceRow.cells[0].quote, null);
  assert.equal(comparison.omitted, 0);
});

test('porównanie pięciu CV, limit pięciu kolumn i analiza w toku', () => {
  const five = [1, 2, 3, 4, 5].map(i => application(i));
  const comparison = buildCandidateComparison(report(five));
  assert.equal(comparison.candidates.length, 5);
  assert.equal(comparison.omitted, 0);
  for (const row of comparison.rows) assert.equal(row.cells.length, 5);

  // Szósty kandydat nie mieści się w limicie, ale jest policzony.
  const six = buildCandidateComparison(report([...five, application(6)]));
  assert.equal(six.candidates.length, MAX_COMPARISON_CANDIDATES);
  assert.equal(six.omitted, 1);

  // Kandydat w trakcie analizy: „analiza w toku", nigdy „brak informacji w CV".
  const pending = buildCandidateComparison(report([application(1, { reason: 'processing' })]));
  for (const row of pending.rows) assert.equal(row.cells[0].status, 'in_progress');
  assert.equal(pending.candidates[0].inProgress, true);
});

test('porównanie FREE nie potwierdza dowodu z nieukończonej lub uszkodzonej analizy', () => {
  for (const reason of ['failed', 'cancelled', 'no_completed_result', 'result_incomplete']) {
    const candidate = application(1, { reason });
    // Corrupt source: a stale evidence row is present despite the ranking reason.
    // The normal loader omits it, but the view must still fail closed.
    candidate.criteria = [criterion(requirements[0], 'supported', 'fikcyjny cytat')];
    const compared = buildCandidateComparison(report([candidate]));
    const cell = compared.rows.find(r => r.id === requirements[0].id).cells[0];
    assert.equal(cell.status, 'unavailable', reason);
    assert.equal(cell.quote, null, reason);
  }
});

test('porównanie FREE pokazuje pierwszy niepusty cytat, jak raport pojedynczego CV', () => {
  const candidate = application(1);
  candidate.criteria[0].evidence = [
    { start: 0, end: 2, quote: '  ' },
    { start: 2, end: 9, quote: 'dowód 2' },
  ];
  const compared = buildCandidateComparison(report([candidate]));
  assert.equal(compared.rows.find(r => r.id === requirements[0].id).cells[0].quote, 'dowód 2');
});

test('porównanie FREE odrzuca uszkodzone offsety cytatów tak jak raport jednego CV', () => {
  const candidate = application(1);
  const invalid = [
    { quote: 'bez zakresu' },
    { start: -1, end: 5, quote: 'ujemny' },
    { start: 8, end: 3, quote: 'odwrócony' },
    { start: 0, end: 1_000_001, quote: 'poza limitem' },
    { start: 2, end: 7, quote: 'ważny' },
  ];
  candidate.criteria[0].evidence = invalid;
  const compared = buildCandidateComparison(report([candidate]));
  const cell = compared.rows.find(r => r.id === requirements[0].id).cells[0];
  const single = buildCandidateRequirement(requirements[0], 'required', completed,
    row({ criterion_id: requirements[0].id, evidence: invalid }));
  assert.equal(cell.status, 'supported');
  assert.equal(cell.quote, single.quotes[0]?.quote ?? null);
  assert.equal(cell.quote, 'ważny');

  // With no valid anchored quote, neither view may display an invented citation.
  candidate.criteria[0].evidence = invalid.slice(0, -1);
  const empty = buildCandidateComparison(report([candidate]));
  assert.equal(empty.rows.find(r => r.id === requirements[0].id).cells[0].quote, null);
});

test('porównanie i raport pojedynczego CV identycznie rozpoznają tekst wymagania', () => {
  const whitespace = application(1);
  whitespace.criteria[0].text = `  ${requirements[0].text}  `;
  const expected = criterionRowFor(requirements[0], {
    criterion_text_snapshot: whitespace.criteria[0].text,
  });
  assert.ok(expected, 'raport pojedynczego CV akceptuje nieistotne białe znaki');
  const same = buildCandidateComparison(report([whitespace]));
  const cell = same.rows.find(r => r.id === requirements[0].id).cells[0];
  assert.equal(cell.status, 'supported', 'porównanie nie może odrzucać tego samego tekstu');
  assert.equal(cell.quote, 'cytat 1');

  // Real changes in the requirement must still never inherit another verdict.
  whitespace.criteria[0].text = requirements[0].text + ' (inne wymaganie)';
  const changed = buildCandidateComparison(report([whitespace]));
  const stale = changed.rows.find(r => r.id === requirements[0].id).cells[0];
  assert.equal(stale.status, 'unavailable');
  assert.equal(stale.quote, null);
});

test('pusta lista kryteriów nie znaczy od razu „brak wyniku analizy"', () => {
  // Raport rekrutacji wczytuje macierz tylko dla analiz sprawdzonych przez człowieka,
  // więc komórka musi powiedzieć, czego naprawdę brakuje.
  const reason = r => comparisonStatus({ ranking: { eligibility_reason: r }, criteria: [] }, undefined);
  assert.equal(reason('no_human_review'), 'awaiting_review');
  assert.equal(reason('stale'), 'outdated');
  assert.equal(reason('needs_reanalysis'), 'outdated');
  assert.equal(reason('review_inconsistent'), 'outdated');
  assert.equal(reason('processing'), 'in_progress');
  assert.equal(reason('no_completed_result'), 'unavailable');
  // Żadna z tych etykiet nie udaje braku informacji w CV.
  for (const status of ['awaiting_review', 'outdated', 'unavailable', 'in_progress']) {
    assert.notEqual(requirementStatusLabels[status], requirementStatusLabels.missing);
  }
  const comparison = buildCandidateComparison(report([application(1, { reason: 'no_human_review' })]));
  for (const row of comparison.rows) assert.equal(row.cells[0].status, 'awaiting_review');
});

test('shortlista człowieka idzie na początek, dalej miejsce w rankingu', () => {
  const { chosen } = comparisonCandidates(report([
    application(3), application(1), application(2, { shortlist: true }),
  ]));
  assert.deepEqual(chosen.map(a => a.ranking.rank), [2, 1, 3]);
});

test('korekta jednej osoby zmienia tylko jej kolumnę', () => {
  const before = buildCandidateComparison(report([1, 2, 3, 4, 5].map(i => application(i))));
  const after = buildCandidateComparison(report([
    application(1, { reviewedChange: true, verdict: 'partial' }),
    ...[2, 3, 4, 5].map(i => application(i)),
  ]));
  const column = (comparison, index) => comparison.rows.map(r => r.cells[index]);
  assert.notDeepEqual(column(before, 0), column(after, 0), 'kolumna skorygowanej osoby się zmienia');
  assert.equal(after.rows[0].cells[0].corrected, true);
  for (const index of [1, 2, 3, 4]) {
    assert.deepEqual(column(before, index), column(after, index), 'pozostali czterej bez zmian');
  }
});

test('zmiana samego oznaczenia zmienia kolejność w obu widokach i nie rusza wyników', () => {
  const applications = [1, 2, 3, 4, 5].map(i => application(i));
  const flags = [{ criterion_id: 'competency:1', criterion_text: 'Prawo jazdy kategorii B', flag: 'required' }];
  const before = buildCandidateComparison(report(applications));
  const after = buildCandidateComparison(report(applications, flags));

  // Porównanie: wymaganie konieczne wychodzi na pierwszy wiersz.
  assert.equal(before.rows[0].id, 'task:1');
  assert.equal(after.rows[0].id, 'competency:1');
  assert.equal(after.rows[0].mark, 'required');
  // Statusy i cytaty są te same — oznaczenie nie jest wynikiem analizy.
  const cellsById = comparison => new Map(comparison.rows.map(r => [r.id, r.cells]));
  const beforeCells = cellsById(before), afterCells = cellsById(after);
  for (const [id, cells] of beforeCells) assert.deepEqual(afterCells.get(id), cells);

  // Raport pojedynczego CV: ta sama zmiana kolejności z tych samych oznaczeń.
  const marksBefore = resolveRequirementMarks(requirements, []);
  const marksAfter = resolveRequirementMarks(requirements, flags);
  assert.equal(sortByRequirementMark(requirements, marksAfter)[0].id, 'competency:1');
  assert.notEqual(sortByRequirementMark(requirements, marksBefore)[0].id, 'competency:1');
  // Korekta rekrutera na wierszu przeżywa zmianę oznaczenia.
  const corrected = row({ human_status: 'edited', human_verdict: 'supported', human_suggested_question: 'Pytanie rekrutera' });
  assert.deepEqual(
    { ...buildCandidateRequirement(licence, 'required', completed, corrected), mark: null },
    { ...buildCandidateRequirement(licence, 'unmarked', completed, corrected), mark: null },
  );
  assert.equal(summariseCandidateReport([buildCandidateRequirement(licence, marksAfter.get('competency:1'), completed, corrected)]).requiredSupported, 1);
});
