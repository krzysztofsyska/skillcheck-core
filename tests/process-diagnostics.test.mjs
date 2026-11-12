// SC-PROCESS / #277, część A — diagnostyka rekrutacji: deterministyczne podpowiedzi,
// walidacja listy pięciu obszarów (w tym reguła budżetu), katalog wskaźników
// z jawnym brakiem pomiaru oraz akcja serwera panelu (od formularza do wywołania
// bazy). Bez bazy i bez sieci; baza jest sprawdzana w
// tests/process-diagnostics-database.test.mjs. Dane są fikcyjne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire, Module } from 'node:module';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as diagnostics from '../lib/process-diagnostics.ts';
import * as metricsLib from '../lib/process-metrics.ts';

const {
  DIAGNOSTIC_LIMITS, INFLOW_RULES, diagnosticAreas, diagnosticProblems, emptyDiagnosticContent, inflowLevel, parseDiagnosticContent,
  parseDiagnosticForm, parseDiagnosticsState, processError, proposeDiagnosticAreas, recruitmentChannels, uncheckedAreas,
} = diagnostics;
const { METRICS_DEFINITION_VERSION, describeMetrics, describeScope, metricCatalogue, metricKeys } = metricsLib;
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

const goodAd = 'Szukamy księgowej do zespołu finansów w Poznaniu. Praca hybrydowa: trzy dni w biurze, dwa zdalnie. '
  + 'Wynagrodzenie 8 000–9 500 zł brutto na umowie o pracę, prywatna opieka medyczna i budżet szkoleniowy. '
  + 'Zespół liczy sześć osób, wdrożenie trwa miesiąc.';
const healthy = { status: 'open', daysOpen: 21, applicationsTotal: 30, applicationsLast14Days: 12, title: 'Księgowa',
  description: goodAd, tasks: ['Księgowanie faktur', 'Uzgadnianie sald', 'Przygotowanie deklaracji VAT'] };
const filler = 'Oferujemy stabilną współpracę, przyjazną atmosferę, wsparcie doświadczonych koleżanek i kolegów oraz jasny podział obowiązków.';
const areasOf = proposal => proposal.hints.map(hint => hint.area);

function formFor(areas = {}, { channels = [], kind = 'keep_watching', recommendation = 'Obserwujemy kolejny tydzień.', expected = 0 } = {}) {
  const form = new FormData();
  for (const area of diagnosticAreas) {
    const [status, note = ''] = [].concat(areas[area] ?? 'not_checked');
    form.set(`area.${area}.status`, status); form.set(`area.${area}.note`, note);
  }
  for (const channel of channels) form.append('channel', channel);
  form.set('recommendationKind', kind); form.set('recommendation', recommendation); form.set('expectedRecordNo', String(expected));
  return form;
}
const allChecked = { channels: 'ok', role_name: 'ok', tasks: 'ok', job_ad: 'ok', market: ['problem', 'Stawka poniżej rynku.'] };

test('hints are deterministic, make no AI call and differ for different synthetic inputs', () => {
  assert.deepEqual(proposeDiagnosticAreas(healthy), proposeDiagnosticAreas(healthy), 'same input, same output');
  assert.deepEqual(proposeDiagnosticAreas(healthy), { level: 'ok', levelText: 'Napływ nie wygląda na mały: 12 CV w ostatnich 14 dniach (łącznie 30).', hints: [] });

  // Zero zgłoszeń przez 10 dni: najpierw kanały.
  const silent = proposeDiagnosticAreas({ ...healthy, daysOpen: 10, applicationsTotal: 0, applicationsLast14Days: 0 });
  assert.equal(silent.level, 'none');
  assert.deepEqual(areasOf(silent), ['channels']);
  assert.match(silent.hints[0].reason, /czy ogłoszenie jest w ogóle opublikowane/);
  // Napływ ustał albo jest mały: inne uzasadnienie tej samej wskazówki.
  const stopped = proposeDiagnosticAreas({ ...healthy, applicationsTotal: 9, applicationsLast14Days: 0 });
  const trickle = proposeDiagnosticAreas({ ...healthy, applicationsTotal: 9, applicationsLast14Days: 3 });
  assert.deepEqual([stopped.level, trickle.level], ['low', 'low']);
  assert.match(stopped.hints[0].reason, /przestały napływać/);
  assert.match(trickle.hints[0].reason, /Zgłoszeń jest mało/);
  assert.notEqual(stopped.hints[0].reason, trickle.hints[0].reason);

  // Nazwa roli: żargon, wewnętrzne oznaczenie, długość.
  for (const title of ['Sales Ninja', 'Specjalista SP2', 'Analityk poziom 3', 'Konsultant III']) {
    assert.deepEqual(areasOf(proposeDiagnosticAreas({ ...healthy, title })), ['role_name'], title);
  }
  const long = proposeDiagnosticAreas({ ...healthy, title: 'Starszy specjalista do spraw rozliczeń i kontaktu z kluczowymi klientami' });
  assert.deepEqual(areasOf(long), ['role_name']);
  assert.match(long.hints[0].reason, /jest długa/);
  assert.deepEqual(areasOf(proposeDiagnosticAreas({ ...healthy, title: 'Główna księgowa' })), []);

  // Zadania: brak albo za mało.
  assert.match(proposeDiagnosticAreas({ ...healthy, tasks: [] }).hints.find(hint => hint.area === 'tasks').reason, /nie ma żadnych zadań/);
  assert.match(proposeDiagnosticAreas({ ...healthy, tasks: ['Księgowanie', '  '] }).hints.find(hint => hint.area === 'tasks').reason, /tylko 1 zadanie/);
  // Ogłoszenie i warunki rynkowe: brak opisu, krótki opis, brak wynagrodzenia, brak miejsca pracy.
  assert.deepEqual(areasOf(proposeDiagnosticAreas({ ...healthy, description: null })), ['job_ad', 'market']);
  assert.match(proposeDiagnosticAreas({ ...healthy, description: 'Praca w biurze, 7 000 zł brutto.' }).hints[0].reason, /jest krótki/);
  const noSalary = proposeDiagnosticAreas({ ...healthy, description: goodAd.replace(/Wynagrodzenie[^.]*\./, filler) });
  assert.deepEqual(areasOf(noSalary), ['market']);
  assert.match(noSalary.hints[0].reason, /nie widać informacji o wynagrodzeniu — porównaj warunki z rynkiem, zanim zmienisz budżet/);
  const noPlace = proposeDiagnosticAreas({ ...healthy, description: goodAd.replace(/ w Poznaniu\. Praca hybrydowa[^.]*\./, `. ${filler}`) });
  assert.match(noPlace.hints[0].reason, /nie widać informacji o miejscu pracy/);
  // „zł" jako część innego słowa nie liczy się jako informacja o wynagrodzeniu.
  assert.deepEqual(areasOf(proposeDiagnosticAreas({ ...healthy, description: `${goodAd.replace(/Wynagrodzenie[^.]*\./, filler)} Szukamy osoby, która nie jest złośliwa.` })), ['market']);

  // Najgorszy przypadek: wszystkie pięć obszarów, w stałej kolejności sprawdzania.
  const worst = proposeDiagnosticAreas({ status: 'open', daysOpen: 30, applicationsTotal: 0, applicationsLast14Days: 0, title: 'Growth Hacking Rockstar LVL 2', description: '', tasks: [] });
  assert.deepEqual(areasOf(worst), [...diagnosticAreas]);

  for (const file of ['lib/process-diagnostics.ts', 'lib/process-metrics.ts']) {
    const source = read(file);
    assert.doesNotMatch(source, /^import /m, `${file}: pure module, no imports`);
    assert.doesNotMatch(source, /openai|fetch\(|Math\.random|Date\.now|new Date/i, `${file}: no AI, network, randomness or clock`);
  }
});

test('inflow level: too early is "not measured"; a draft recruitment is judged like an open one', () => {
  const facts = { status: 'open', daysOpen: 3, applicationsTotal: 0, applicationsLast14Days: 0 };
  assert.equal(inflowLevel(facts).level, 'not_measured');
  assert.match(inflowLevel(facts).levelText, /^Brak pomiaru: rekrutacja trwa 3 dni/);
  // Panel tworzy każdą rekrutację jako `draft` i nie zmienia statusu, a szkic zbiera CV — status nie może wyłączać oceny.
  for (const status of ['draft', 'open', 'paused', 'closed']) {
    assert.deepEqual(inflowLevel({ ...facts, daysOpen: 40, status }), { level: 'none', levelText: 'Przez 40 dni nie wpłynęło żadne CV.' }, status);
    assert.equal(inflowLevel({ ...facts, daysOpen: 3, status }).level, 'not_measured', `${status}: the 7-day rule still applies`);
  }
  const draft = proposeDiagnosticAreas({ ...healthy, status: 'draft', daysOpen: 10, applicationsTotal: 0, applicationsLast14Days: 0 });
  assert.deepEqual([draft.level, areasOf(draft)], ['none', ['channels']], 'the low-inflow hint fires for a panel-created (draft) recruitment');
  assert.doesNotMatch(read('lib/process-diagnostics.ts'), /status === 'draft'|nie zbiera zgłoszeń\./, 'no branch treats a draft as not collecting');
  // Akcja panelu rzeczywiście tworzy rekrutację bez statusu (czyli `draft`) — na tym opiera się powyższe.
  assert.match(read('app/dashboard/[companyId]/actions.ts'), /from\("recruitments"\)\.insert\(\{company_id:companyId,position_id:position\.id,name\}\)/);
  assert.equal(inflowLevel({ ...facts, daysOpen: null }).level, 'not_measured');
  assert.equal(inflowLevel({ ...facts, daysOpen: INFLOW_RULES.minDaysToJudge }).level, 'none');
  assert.equal(inflowLevel({ ...facts, daysOpen: 20, applicationsTotal: 6, applicationsLast14Days: INFLOW_RULES.lowLast14Days - 1 }).level, 'low');
  assert.equal(inflowLevel({ ...facts, daysOpen: 20, applicationsTotal: 6, applicationsLast14Days: INFLOW_RULES.lowLast14Days }).level, 'ok');
  // Za wcześnie na ocenę napływu: nie ma wskazówki o kanałach, ale braki profilu nadal są widoczne.
  assert.deepEqual(areasOf(proposeDiagnosticAreas({ ...healthy, daysOpen: 2, applicationsTotal: 0, applicationsLast14Days: 0, tasks: [] })), ['tasks']);
});

test('the checklist form maps to canonical content; shape and limits are enforced', () => {
  const parsed = parseDiagnosticForm(formFor({ channels: ['problem', '  Tylko strona firmy.\n'], tasks: 'ok' },
    { channels: ['other', 'job_board', 'job_board'], kind: 'fix_areas', recommendation: '\tDodać portal ogłoszeniowy. ' }));
  assert.deepEqual(parsed, {
    content: { areas: {
      channels: { status: 'problem', note: 'Tylko strona firmy.' }, role_name: { status: 'not_checked', note: '' },
      tasks: { status: 'ok', note: '' }, job_ad: { status: 'not_checked', note: '' }, market: { status: 'not_checked', note: '' },
    }, channelsUsed: ['job_board', 'other'] },
    recommendationKind: 'fix_areas', recommendation: 'Dodać portal ogłoszeniowy.',
  });
  assert.deepEqual(parseDiagnosticContent(parsed.content), parsed.content, 'already canonical');
  assert.deepEqual(uncheckedAreas(parsed.content), ['role_name', 'job_ad', 'market']);
  assert.deepEqual(uncheckedAreas(emptyDiagnosticContent()), [...diagnosticAreas]);

  assert.throws(() => parseDiagnosticForm(formFor({}, { kind: 'cut_budget' })), /Wybierz zalecenie/);
  assert.throws(() => parseDiagnosticForm(formFor({ tasks: 'maybe' })), /Wybierz status obszaru „Zadania”/);
  assert.throws(() => parseDiagnosticForm(formFor({ tasks: ['ok', 'x'.repeat(DIAGNOSTIC_LIMITS.note + 1)] })), /Skróć pole „Zadania — notatka” do 500 znaków/);
  assert.throws(() => parseDiagnosticForm(formFor({}, { recommendation: 'x'.repeat(DIAGNOSTIC_LIMITS.recommendation + 1) })), /Skróć pole „Zalecenie — uzasadnienie”/);
  assert.throws(() => parseDiagnosticForm(formFor({ tasks: ['ok', 'a\u0007b'] })), /niedozwolone znaki/);
  assert.throws(() => parseDiagnosticForm(formFor({}, { channels: ['telepatia'] })), /Niepoprawna lista kanałów/);
  // Dane kontaktowe w wolnym tekście są odrzucane (wpisu nie da się później poprawić).
  for (const text of ['Napisać do jan.kowalski@example.com w sprawie ogłoszenia.', 'Kandydat prosił o telefon: 600 700 800.', 'tel. +48 600-700-800', 'Zadzwonić 600700800']) {
    assert.throws(() => parseDiagnosticForm(formFor({ tasks: ['ok', text] })), /Pole „Zadania — notatka”: treść wygląda na adres e-mail lub numer telefonu\. Nie wpisuj tu danych kandydatów/, text);
    assert.throws(() => parseDiagnosticForm(formFor({}, { recommendation: text })), /Pole „Zalecenie — uzasadnienie”: treść wygląda na adres e-mail lub numer telefonu/, text);
  }
  // Zwykłe liczby z diagnozy (widełki, daty, liczba CV) przechodzą.
  for (const text of ['Widełki 8 000–9 500 zł brutto, konkurencja daje 10 000 - 12 000 zł.', 'Ogłoszenie wygasło 2026-11-01, odnowić do 15.11.2026.', 'Stawka 8000-9500 zł; 3 CV w 14 dni.', 'Publikacja @ portal branżowy']) {
    assert.equal(parseDiagnosticForm(formFor({ tasks: ['ok', text] })).content.areas.tasks.note, text);
  }
  const { market: _dropped, ...four } = parsed.content.areas;
  for (const invalid of [null, [], 'x', {}, { areas: [] }, { areas: four }, { areas: { ...parsed.content.areas, budget: { status: 'ok', note: '' } } },
    { ...parsed.content, channelsUsed: ['job_board', 'job_board'] }, { ...parsed.content, channelsUsed: 'job_board' },
    { ...parsed.content, channelsUsed: Array(8).fill('other') }]) {
    assert.throws(() => parseDiagnosticContent(invalid), JSON.stringify(invalid));
  }
});

test('budget rule: "change budget" needs all five areas checked first', () => {
  const problems = options => diagnosticProblems(parseDiagnosticForm(formFor(options.areas, options)));
  assert.deepEqual(problems({ areas: allChecked, kind: 'change_budget', recommendation: 'Zwiększyć budżet.' }), [], 'all five checked (one with a problem): allowed');
  for (const missing of diagnosticAreas) {
    const list = problems({ areas: { ...allChecked, [missing]: 'not_checked' }, kind: 'change_budget', recommendation: 'Zwiększyć budżet.' });
    assert.equal(list.length, 1, missing);
    assert.match(list[0], /^Zanim zalecisz zmianę budżetu, sprawdź wszystkie obszary\. Jeszcze nie sprawdzone: /);
  }
  assert.deepEqual(problems({ areas: {}, kind: 'change_budget', recommendation: 'Zwiększyć budżet.' }),
    ['Zanim zalecisz zmianę budżetu, sprawdź wszystkie obszary. Jeszcze nie sprawdzone: Kanały, Nazwa roli, Zadania, Ogłoszenie, Warunki rynkowe.']);
  // Reguła dotyczy tylko budżetu: niepełną listę wolno zapisać z innym zaleceniem.
  assert.deepEqual(problems({ areas: { channels: 'ok' } }), []);
  // Pozostałe braki.
  assert.deepEqual(problems({ areas: { ...allChecked, market: 'problem' } }), ['Obszar „Warunki rynkowe”: opisz krótko, co jest do poprawy.']);
  assert.deepEqual(problems({ areas: { channels: 'ok' }, kind: 'fix_areas' }), ['Zalecenie „popraw wskazane obszary” wymaga co najmniej jednego obszaru oznaczonego „do poprawy”.']);
  assert.deepEqual(problems({ areas: allChecked, recommendation: '  ' }), ['Wpisz uzasadnienie zalecenia.']);
});

test('database errors become plain Polish messages; unexpected state is refused', () => {
  assert.equal(processError({ code: '22023', message: 'process_budget_requires_full_check:job_ad,market' }),
    'Zanim zalecisz zmianę budżetu, sprawdź wszystkie obszary. Jeszcze nie sprawdzone: Ogłoszenie, Warunki rynkowe.');
  assert.equal(processError({ code: '22023', message: 'process_diagnostic_incomplete:role_name.note' }), 'Obszar „Nazwa roli”: opisz krótko, co jest do poprawy.');
  assert.equal(processError({ code: '22023', message: 'process_diagnostic_incomplete:recommendation' }), 'Wpisz uzasadnienie zalecenia.');
  assert.match(processError({ code: '22023', message: 'process_diagnostic_incomplete:fix_areas.problem' }), /co najmniej jednego obszaru/);
  assert.match(processError({ code: 'PT409', message: 'process_record_changed' }), /Ktoś zapisał w międzyczasie inną diagnozę/);
  assert.equal(processError({ code: '42501', message: 'process_forbidden' }), 'Masz dostęp tylko do odczytu.');
  assert.match(processError({ code: '22023', message: 'process_diagnostic_invalid' }), /Sprawdź pola formularza/);
  assert.match(processError({ code: '54000', message: 'process_diagnostic_limit' }), /maksymalną liczbę zapisów/);
  assert.match(processError({ code: '22023', message: 'process_diagnostic_contact_data:job_ad' }), /^Pole „Ogłoszenie — notatka”: treść wygląda na adres e-mail lub numer telefonu/);
  assert.match(processError({ code: '22023', message: 'process_diagnostic_contact_data:recommendation' }), /^Pole „Zalecenie — uzasadnienie”: treść wygląda na adres e-mail/);
  for (const unknown of [null, undefined, {}, { code: 'XX000', message: 'boom' }]) assert.match(processError(unknown), /^Nie udało się zapisać diagnozy/);

  const inflow = { status: 'open', started_at: '2026-11-01T10:00:00Z', start_source: 'created_at', closed_at: null, days_open: 11,
    total: 2, last_7_days: 1, last_14_days: 2, last_30_days: 2, first_application_at: '2026-11-03T10:00:00Z', last_application_at: '2026-11-09T10:00:00Z',
    weekly: Array.from({ length: 8 }, (_, weeks_ago) => ({ weeks_ago, count: weeks_ago < 2 ? 1 : 0 })) };
  const content = parseDiagnosticForm(formFor(allChecked)).content;
  const row = { id: 'r1', record_no: 1, content, recommendation_kind: 'keep_watching', recommendation: 'Czekamy.', created_at: '2026-11-10T10:00:00Z',
    inflow_snapshot: { total: 2, last_14_days: 2, last_30_days: 2, days_open: 9 } };
  const state = parseDiagnosticsState({ can_edit: true, latest_record_no: 1, inflow, history: [row] });
  assert.equal(state.can_edit, true);
  assert.deepEqual(state.inflow, inflow);
  assert.deepEqual(state.history, [row]);
  assert.equal(parseDiagnosticsState({ can_edit: 'yes', latest_record_no: 0, inflow, history: [] }).can_edit, false, 'only a literal true grants editing');
  for (const broken of [null, [], 'x', { latest_record_no: 0, history: [] }, { latest_record_no: 0, inflow, history: 'x' },
    { latest_record_no: -1, inflow, history: [] }, { latest_record_no: 0, inflow: { ...inflow, total: '2' }, history: [] },
    { latest_record_no: 0, inflow: { ...inflow, start_source: 'guess' }, history: [] },
    { latest_record_no: 0, inflow: { ...inflow, weekly: [{ weeks_ago: 0, count: -1 }] }, history: [] },
    { latest_record_no: 1, inflow, history: [{ ...row, recommendation_kind: 'fire_someone' }] },
    { latest_record_no: 1, inflow, history: [{ ...row, content: { areas: {} } }] }]) {
    assert.equal(parseDiagnosticsState(broken), null, JSON.stringify(broken)?.slice(0, 60));
  }
});

// --- wskaźniki: definicja, zakres danych, jawny brak pomiaru -----------------

const scope = (source, rows, extra = {}) => ({ source, rows, period_from: '2026-11-01T10:00:00Z', period_to: '2026-11-03T10:00:00Z', ...extra });
const rawMetrics = overrides => ({ definition_version: METRICS_DEFINITION_VERSION, metrics: [
  { key: 'days_to_first_application', unit: 'days', state: 'measured', value: 2, reason: null, scope: scope('applications', 4) },
  { key: 'days_to_first_shortlist', unit: 'days', state: 'not_measured', value: null, reason: 'no_data', scope: scope('recruitment_shortlist_entries', 0) },
  { key: 'days_to_first_next_stage_decision', unit: 'days', state: 'measured', value: 0, reason: null, scope: scope('application_decision_events', 1) },
  { key: 'median_days_application_to_decision', unit: 'days', state: 'not_measured', value: null, reason: 'too_few_rows',
    scope: scope('application_decision_events', 2, { population: 4, min_rows: 3 }) },
  { key: 'recruitment_duration_days', unit: 'days', state: 'not_measured', value: null, reason: 'recruitment_not_closed', scope: scope('recruitments', 1) },
  { key: 'days_to_hire', unit: 'days', state: 'not_measured', value: null, reason: 'requires_hire_date', scope: { source: null, rows: 0 } },
  { key: 'probation_pass_rate', unit: 'percent', state: 'not_measured', value: null, reason: 'requires_post_hire_observations', scope: { source: null, rows: 0 } },
  { key: 'retention_rate', unit: 'percent', state: 'not_measured', value: null, reason: 'requires_post_hire_observations', scope: { source: null, rows: 0 } },
].map(metric => ({ ...metric, ...(overrides?.[metric.key] ?? {}) })) });

test('every metric carries a definition and a data scope; not measured is never zero', () => {
  assert.equal(Object.keys(metricCatalogue).length, metricKeys.length);
  const described = describeMetrics(rawMetrics());
  assert.deepEqual(described.map(metric => metric.key), [...metricKeys], 'whole catalogue, catalogue order');
  for (const metric of described) {
    assert.ok(metric.label && metric.definition.length > 30 && metric.dataScope.length > 30, `${metric.key}: label, definition, data scope`);
    if (metric.state === 'not_measured') {
      assert.equal(metric.value, null, `${metric.key}: no value`);
      assert.ok(metric.reason, `${metric.key}: a reason`);
      assert.match(metric.display, /^Brak pomiaru: /, metric.key);
      assert.doesNotMatch(metric.display, /\d/, `${metric.key}: no number is shown for a missing measurement`);
    } else {
      assert.equal(typeof metric.value, 'number');
      assert.equal(metric.reason, null);
    }
  }
  const by = Object.fromEntries(described.map(metric => [metric.key, metric]));
  assert.deepEqual([by.days_to_first_application.state, by.days_to_first_application.display], ['measured', '2 dni']);
  assert.equal(describeScope(by.days_to_first_application), 'Źródło: zgłoszenia, wierszy: 4.');
  // Zmierzone zero to wynik, a brak danych to brak pomiaru — dwa różne stany.
  assert.deepEqual([by.days_to_first_next_stage_decision.state, by.days_to_first_next_stage_decision.value, by.days_to_first_next_stage_decision.display], ['measured', 0, '0 dni']);
  assert.deepEqual([by.days_to_first_shortlist.state, by.days_to_first_shortlist.value, by.days_to_first_shortlist.reason], ['not_measured', null, 'no_data']);
  assert.equal(by.median_days_application_to_decision.reason, 'too_few_rows');
  assert.equal(describeScope(by.median_days_application_to_decision), 'Źródło: zapisane decyzje rekrutera, wierszy: 2, z 4 zgłoszeń w rekrutacji, wymagane minimum: 3.');
  assert.match(by.recruitment_duration_days.display, /nie została jeszcze zamknięta/);
  assert.equal(describeMetrics(rawMetrics({ days_to_first_application: { value: -1.5 } }))[0].display, '-1,5 dni', 'a negative measurement is still a measurement');

  // Przejście próby i retencja: zdefiniowane, ale nigdy nie udawane — nawet gdyby baza zwróciła liczbę.
  for (const key of ['probation_pass_rate', 'retention_rate', 'days_to_hire']) {
    assert.equal(metricCatalogue[key].availableToday, false);
    assert.match(metricCatalogue[key].dataScope, /część B/);
    const forged = describeMetrics(rawMetrics({ [key]: { state: 'measured', value: 100, reason: null } })).find(metric => metric.key === key);
    assert.deepEqual([forged.state, forged.value], ['not_measured', null], `${key}: cannot be measured in part A`);
  }
  assert.equal(by.probation_pass_rate.reason, 'requires_post_hire_observations');
  assert.equal(by.retention_rate.reason, 'requires_post_hire_observations');
  assert.equal(by.days_to_hire.reason, 'requires_hire_date');
});

test('anything that cannot be read as a measurement becomes "not measured", never a number', () => {
  const allMissing = list => list.every(metric => metric.state === 'not_measured' && metric.value === null && /^Brak pomiaru: /.test(metric.display));
  for (const broken of [null, undefined, 'x', [], {}, { definition_version: 'process-metrics-v0', metrics: rawMetrics().metrics },
    { definition_version: METRICS_DEFINITION_VERSION }, { definition_version: METRICS_DEFINITION_VERSION, metrics: 'x' }]) {
    const described = describeMetrics(broken);
    assert.equal(described.length, metricKeys.length);
    assert.ok(allMissing(described), JSON.stringify(broken)?.slice(0, 60));
  }
  const first = overrides => describeMetrics(rawMetrics({ days_to_first_application: overrides }))[0];
  for (const overrides of [{ value: '2' }, { value: null }, { value: Number.NaN }, { unit: 'percent' }, { state: 'estimated' },
    { state: 'not_measured', value: 0, reason: 'no_data' }, { state: 'not_measured', value: null, reason: 'because' }]) {
    assert.deepEqual([first(overrides).state, first(overrides).value, first(overrides).reason], ['not_measured', null, 'unavailable'], JSON.stringify(overrides));
  }
});

// --- akcja serwera: od formularza panelu do wywołania bazy -------------------

const base = 'app/dashboard/[companyId]/recruitments/[recruitmentId]/diagnostyka/';
const lib = '../../../../../../lib/';
function load(file, mocks, jsx = false) {
  const path = fileURLToPath(new URL(`../${base}${file}`, import.meta.url));
  const mod = new Module(path); mod.filename = path;
  const require = createRequire(path);
  mod.require = id => Object.hasOwn(mocks, id) ? mocks[id] : require(id);
  mod._compile(ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}) } }).outputText, path);
  return mod.exports;
}
function scenario({ canEdit = true, rpc } = {}) {
  const calls = [], revalidated = [], accessChecked = [];
  const client = { rpc: async (name, args) => { calls.push([name, args]); return rpc ?? { data: null, error: { code: 'XX000', message: 'unexpected' } }; } };
  const { recordDiagnostic } = load('actions.ts', {
    'next/cache': { revalidatePath: target => revalidated.push(target) },
    [`${lib}company-access`]: { companyAccess: async companyId => { accessChecked.push(companyId); return { client, canEdit }; } },
    [`${lib}process-diagnostics`]: diagnostics,
  });
  return { calls, revalidated, accessChecked, action: recordDiagnostic };
}
const companyId = '11111111-1111-4111-8111-111111111111', recruitmentId = '33333333-3333-4333-8333-333333333333';

test('server action: the form is stored through the RPC with the record number the recruiter saw', async () => {
  const s = scenario({ rpc: { data: 4, error: null } });
  const form = formFor(allChecked, { channels: ['referrals', 'job_board'], kind: 'change_budget', recommendation: ' Zwiększyć budżet o jedną publikację. ', expected: 3 });
  assert.deepEqual(await s.action(companyId, recruitmentId, {}, form), { saved: true, recordNo: 4 });
  assert.deepEqual(s.accessChecked, [companyId], 'the access guard runs first');
  assert.deepEqual(s.calls, [['process_record_diagnostic', { target_company: companyId, target_recruitment: recruitmentId,
    diagnostic: { areas: { channels: { status: 'ok', note: '' }, role_name: { status: 'ok', note: '' }, tasks: { status: 'ok', note: '' },
      job_ad: { status: 'ok', note: '' }, market: { status: 'problem', note: 'Stawka poniżej rynku.' } }, channelsUsed: ['job_board', 'referrals'] },
    recommendation_kind: 'change_budget', recommendation: 'Zwiększyć budżet o jedną publikację.', expected_record_no: 3 }]]);
  assert.deepEqual(s.revalidated, [`/dashboard/${companyId}/recruitments/${recruitmentId}/diagnostyka`]);
});

test('server action: a budget recommendation with unchecked areas is refused before any write', async () => {
  const s = scenario({ rpc: { data: 1, error: null } });
  const result = await s.action(companyId, recruitmentId, {}, formFor({ ...allChecked, job_ad: 'not_checked' }, { kind: 'change_budget', recommendation: 'Zwiększyć budżet.' }));
  assert.equal(result.error, 'Nie można jeszcze zapisać. Zanim zalecisz zmianę budżetu, sprawdź wszystkie obszary. Jeszcze nie sprawdzone: Ogłoszenie.');
  assert.deepEqual(s.calls, [], 'no database call');
  assert.deepEqual(s.revalidated, []);
  // Gdyby panel przepuścił, baza i tak odmawia — komunikat pozostaje czytelny.
  const refused = scenario({ rpc: { data: null, error: { code: '22023', message: 'process_budget_requires_full_check:market' } } });
  assert.deepEqual(await refused.action(companyId, recruitmentId, {}, formFor(allChecked, { kind: 'change_budget', recommendation: 'Zwiększyć budżet.' })),
    { error: 'Zanim zalecisz zmianę budżetu, sprawdź wszystkie obszary. Jeszcze nie sprawdzone: Warunki rynkowe.' });
});

test('server action: read-only members, bad input and database refusals never report success', async () => {
  const viewer = scenario({ canEdit: false, rpc: { data: 1, error: null } });
  assert.deepEqual(await viewer.action(companyId, recruitmentId, {}, formFor(allChecked)), { error: 'Masz dostęp tylko do odczytu.' });
  assert.deepEqual(viewer.calls, []);

  const s = scenario({ rpc: { data: 1, error: null } });
  assert.match((await s.action(companyId, 'not-a-uuid', {}, formFor(allChecked))).error, /Nie rozpoznano rekrutacji/);
  assert.match((await s.action(companyId, recruitmentId, {}, formFor(allChecked, { expected: -1 }))).error, /Odśwież stronę/);
  assert.match((await s.action(companyId, recruitmentId, {}, formFor({ tasks: 'maybe' }))).error, /Wybierz status obszaru „Zadania”/);
  assert.match((await s.action(companyId, recruitmentId, {}, formFor(allChecked, { recommendation: '' }))).error, /Wpisz uzasadnienie zalecenia/);
  assert.deepEqual(s.calls, []);

  const denied = scenario({ rpc: { data: null, error: { code: '42501', message: 'process_forbidden' } } });
  assert.deepEqual(await denied.action(companyId, recruitmentId, {}, formFor(allChecked)), { error: 'Masz dostęp tylko do odczytu.' });
  const conflict = scenario({ rpc: { data: null, error: { code: 'PT409', message: 'process_record_changed' } } });
  assert.match((await conflict.action(companyId, recruitmentId, {}, formFor(allChecked))).error, /Ktoś zapisał w międzyczasie/);
  assert.deepEqual(conflict.revalidated, []);
  const odd = scenario({ rpc: { data: 'not-a-number', error: null } });
  assert.match((await odd.action(companyId, recruitmentId, {}, formFor(allChecked))).error, /^Nie udało się zapisać diagnozy/);
});

test('panel form renders the five areas, the channels, the hints and the record number', () => {
  const { DiagnosticForm } = load('diagnostic-form.tsx', { './actions': { recordDiagnostic: async () => ({}) }, [`${lib}process-diagnostics`]: diagnostics }, true);
  const initial = parseDiagnosticForm(formFor({ channels: ['problem', 'Tylko strona firmy.'] }, { channels: ['company_site'] })).content;
  const html = renderToStaticMarkup(createElement(DiagnosticForm, { companyId, recruitmentId, initial, latestRecordNo: 6,
    hints: [{ area: 'tasks', reason: 'Profil stanowiska nie ma żadnych zadań.' }] }));
  assert.match(html, /name="expectedRecordNo" value="6"/);
  for (const area of diagnosticAreas) {
    assert.ok(html.includes(`name="area.${area}.status"`), `${area} status`);
    assert.ok(html.includes(`name="area.${area}.note"`), `${area} note`);
  }
  assert.equal(html.match(/name="channel"/g).length, recruitmentChannels.length);
  assert.match(html, /<input type="checkbox" name="channel" checked="" value="company_site"\/>/);
  assert.match(html, /Tylko strona firmy\./);
  assert.match(html, /Podpowiedź: Profil stanowiska nie ma żadnych zadań\./);
  assert.match(html, /<option value="change_budget">Zmień budżet rekrutacji<\/option>/);
  assert.match(html, /niczego nie zmienia w rekrutacji ani w budżecie i nie dotyczy żadnego kandydata/);
});

test('panel wiring: guarded page, link from the recruitment, no decision about people', () => {
  const page = read(`${base}page.tsx`);
  assert.match(page, /companyAccess\(companyId\)/);
  assert.match(page, /process_diagnostics_state/);
  assert.match(page, /process_recruitment_metrics/);
  assert.match(page, /describeMetrics\(measured\.error \? null : measured\.data\)/, 'a failed metrics read becomes "not measured", not zeros');
  assert.match(page, /nie ocenia kandydatów/);
  assert.match(page, /to nie jest zero ani zły wynik/);
  assert.match(read('app/dashboard/[companyId]/recruitments/[recruitmentId]/page.tsx'), /recruitments\/\$\{recruitmentId\}\/diagnostyka/);
  // Część A nie zapisuje nic o osobach: żadnych pól kandydata, zatrudnienia ani oceny pracownika.
  const migration = read('supabase/migrations/20261112140000_sc_process_diagnostics.sql');
  const table = migration.slice(migration.indexOf('create table process.diagnostic_records'), migration.indexOf('alter table process.diagnostic_records'));
  assert.doesNotMatch(table, /candidate|application_id|employee|hire|score/i);
  assert.equal(migration.match(/create table /g).length, 1, 'one company-level table');
  assert.doesNotMatch(migration, /references public\.|references private\./, 'no foreign key into public/private');
  assert.doesNotMatch(migration, /[0-9a-f]{64}/, 'no pinned inventory signature: unchanged-by-this-migration is checked before/after');
  assert.match(migration, /sc_process\.signature_before/);
});
