import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBehaviorAssessment, parseHistoryBefore, behaviorEditingOpen, behaviorSaveError, behaviorSchemaMissing } from '../lib/behavior-assessment.ts';
const form = (rating, evidence) => { const data = new FormData(); data.set('rating', rating); if (evidence !== undefined) data.set('evidence', evidence); return data; };

test('manual ratings require bounded evidence; absence of data is explicit', () => {
  assert.deepEqual(parseBehaviorAssessment(form('insufficient_data', ' ')), { rating: 'insufficient_data', evidence: '' });
  for (const rating of ['below', 'meets', 'above']) {
    for (const evidence of ['', ' \t\n\u00a0\u2009\ufeff', undefined]) assert.throws(() => parseBehaviorAssessment(form(rating, evidence)));
    assert.deepEqual(parseBehaviorAssessment(form(rating, ' Dowód działania ')), { rating, evidence: 'Dowód działania' });
  }
  for (const rating of ['hired', '73/100', '', null]) assert.throws(() => parseBehaviorAssessment(form(rating, 'Dowód')));
  assert.throws(() => parseBehaviorAssessment(form('meets', 'x'.repeat(10001))));
  assert.throws(() => parseBehaviorAssessment(form('meets', new File(['x'], 'evidence.txt'))));
});

test('closed workflows are read only and errors distinguish conflicts from unavailable schema', () => {
  for (const application of ['new', 'in_progress']) for (const recruitment of ['draft', 'open'])
    assert.ok(behaviorEditingOpen(application, recruitment, 'active'));
  for (const application of ['hired', 'rejected', 'withdrawn', 'unknown']) assert.equal(behaviorEditingOpen(application, 'open', 'active'), false);
  for (const recruitment of ['paused', 'closed', 'unknown']) assert.equal(behaviorEditingOpen('new', recruitment, 'active'), false);
  assert.equal(behaviorEditingOpen('new', 'open', 'archived'), false);
  assert.match(behaviorSaveError('40001'), /Skopiuj/);
  assert.match(behaviorSaveError('42501'), /uprawnień/);
  assert.match(behaviorSaveError('55000'), /już/);
  assert.equal(behaviorSchemaMissing('42501'), false);
  assert.equal(behaviorSchemaMissing('PGRST205'), true);
});

test('history cursor cannot change filters or skip through an invalid version', () => {
  assert.equal(parseHistoryBefore(), null); assert.equal(parseHistoryBefore('21'), 21);
  for (const value of ['', '0', '-1', '1.5', '1e2', '01', '2147483648', ['3'], '3&company=other']) assert.throws(() => parseHistoryBefore(value));
});
