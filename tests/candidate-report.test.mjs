// SC-015 / #268 — wspólny odczyt raportu kandydata i porównania.
// Dane kandydatów są fikcyjne; żadnego prawdziwego CV ani nazwiska.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCandidateRequirement, fallbackGapQuestion, requirementStatus,
  requirementStatusLabels, summariseCandidateReport,
} from '../lib/candidate-report.ts';
import {
  buildCandidateComparison, comparisonCandidates, MAX_COMPARISON_CANDIDATES,
} from '../lib/candidate-comparison.ts';
import {
  positionRequirements, resolveRequirementMarks, sortByRequirementMark,
} from '../lib/requirement-flags.ts';

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
  missing_info: null, suggested_question: null, human_status: 'unreviewed',
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
  criteria: reason === 'pending' || reason === 'processing' ? []
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
