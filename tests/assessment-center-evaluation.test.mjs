import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAssessmentCenter } from '../lib/assessment-center-evaluation.ts';

const definition = () => ({
  kind: 'assessment_center', title: 'Symulacja rozmowy', instructions: 'Rozmowa z klientem',
  expectedOutput: 'Rozwiązanie problemu', durationMinutes: 20,
  criteria: [
    { competency: 'Komunikacja', below: 'Przerywa rozmowę', meets: 'Słucha klienta', above: 'Podsumowuje potrzeby' },
    { competency: 'Analiza', below: 'Pomija problem', meets: 'Wyjaśnia problem', above: 'Sprawdza przyczyny' },
  ],
});
const observations = () => [
  { criterionIndex: 0, rating: 'meets', evidence: 'Zadał dwa pytania otwarte.', context: 'Podczas rozmowy z klientem.' },
  { criterionIndex: 1, rating: 'insufficient_data', evidence: '', context: '' },
];

test('AC observations retain evidence, never decide hiring or invent missing evidence', () => {
  const result = evaluateAssessmentCenter(definition(), observations());
  assert.equal(result.status, 'incomplete_evidence');
  assert.equal(result.evidencedCriteria, 1);
  assert.equal(result.criteria[1].rating, 'insufficient_data');
  assert.equal('score' in result, false);
  assert.equal('hiringDecision' in result, false);
  const complete = observations();
  complete[1] = { criterionIndex: 1, rating: 'above', evidence: 'Sprawdził przyczyny zgłoszenia.', context: 'W scenariuszu obsługi reklamacji.' };
  assert.equal(evaluateAssessmentCenter(definition(), complete).status, 'review_required');
});
test('rejects competency test, missing/sparse, reordered and invalid ratings', () => {
  assert.throws(() => evaluateAssessmentCenter({ ...definition(), kind: 'competency_test' }, observations()));
  assert.throws(() => evaluateAssessmentCenter(definition(), [observations()[0]]));
  const sparse = Array(2); sparse[1] = observations()[1];
  assert.throws(() => evaluateAssessmentCenter(definition(), sparse));
  const reordered = observations(); reordered[0].criterionIndex = 1;
  assert.throws(() => evaluateAssessmentCenter(definition(), reordered));
  const invalid = observations(); invalid[0].rating = 'hire';
  assert.throws(() => evaluateAssessmentCenter(definition(), invalid));
});
test('requires behavioral evidence and context, disallows evidence for insufficient data', () => {
  const rows = observations(); rows[0].evidence = 'ogólne';
  assert.throws(() => evaluateAssessmentCenter(definition(), rows));
  rows[0].evidence = 'Zadał dwa pytania otwarte.'; rows[0].context = '';
  assert.throws(() => evaluateAssessmentCenter(definition(), rows));
  rows[0].context = 'Podczas rozmowy z klientem.'; rows[1].evidence = 'Nie wiadomo';
  assert.throws(() => evaluateAssessmentCenter(definition(), rows));
});


test('rejects oversized observation and contextual text', () => {
  const tooLongEvidence = observations();
  tooLongEvidence[0].evidence = 'x'.repeat(4001);
  assert.throws(() => evaluateAssessmentCenter(definition(), tooLongEvidence));
  const tooLongContext = observations();
  tooLongContext[0].context = 'x'.repeat(2001);
  assert.throws(() => evaluateAssessmentCenter(definition(), tooLongContext));
});

test('normalizes whitespace and does not treat whitespace as evidence', () => {
  const empty = observations();
  empty[0].evidence = ' '.repeat(15);
  assert.throws(() => evaluateAssessmentCenter(definition(), empty));
  const valid = observations();
  valid[0].evidence = '  Zadał dwa pytania otwarte.  ';
  const result = evaluateAssessmentCenter(definition(), valid);
  assert.equal(result.criteria[0].evidence, 'Zadał dwa pytania otwarte.');
});
