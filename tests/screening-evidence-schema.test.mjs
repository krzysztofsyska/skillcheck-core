import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceOutputSchema, parseEvidenceOutput } from '../lib/screening-evidence-schema.ts';
const claim = { candidate_document_id: '5c04044b-57c5-4b66-b77d-99b95f117015',
  input_cv_text_snapshot: 'Zarządzał „CRM”  i wdrożeniami.', criteria_snapshot: [{ id: 'task:1' }] };
const valid = { criteria: [{ criterion_id: 'task:1', verdict: 'supported',
  evidence_quotes: ['"CRM" i wdrożeniami'], missing_info: '',
  suggested_question: '', explanation: 'Wskazane w CV' }] };
test('verified evidence keeps raw quote, position and document', () => {
  const finding = parseEvidenceOutput(valid, claim)[0];
  assert.equal(finding.verdict, 'supported');
  assert.equal(finding.evidence[0].quote, '„CRM”  i wdrożeniami');
  assert.equal(finding.evidence[0].document_id, claim.candidate_document_id);
});
test('invented quote is removed and verdict becomes missing', () => {
  const finding = parseEvidenceOutput({ criteria: [{ ...valid.criteria[0], evidence_quotes: ['SAP'] }] }, claim)[0];
  assert.equal(finding.verdict, 'missing');
  assert.deepEqual(finding.evidence, []);
});
test('Zod rejects overall rating, score, hiring recommendations and nested fields', () => {
  for (const bad of [
    { ...valid, overall_score: 95 }, { ...valid, recommendation: 'hire' },
    { criteria: [{ ...valid.criteria[0], hire_recommendation: 'reject' }] },
    { criteria: [{ ...valid.criteria[0], overall_rating: 5 }] },
  ]) assert.equal(evidenceOutputSchema.safeParse(bad).success, false);
});
test('criterion allowlist forbids unknown IDs', () => {
  assert.throws(() => parseEvidenceOutput({ criteria: [{ ...valid.criteria[0], criterion_id: 'fake' }] }, claim));
});
