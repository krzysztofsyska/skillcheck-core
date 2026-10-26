import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySnapshotQuotes } from '../lib/screening-evidence.ts';

const documentId = '5c04044b-57c5-4b66-b77d-99b95f117015';
const source = 'Praca z SQL  i raportami. Wdrożono „CRM”.';

test('exact quote is preserved with document and real position', () => {
  assert.deepEqual(verifySnapshotQuotes(source, documentId, ['SQL  i raportami']), [{
    start: 8, end: 24, quote: 'SQL  i raportami', document_id: documentId,
  }]);
});
test('whitespace and typographic quotation normalization retains original offsets', () => {
  const result = verifySnapshotQuotes(source, documentId, ['SQL i\nraportami', '"CRM"']);
  assert.deepEqual(result.map(r => r.quote), ['SQL  i raportami', '„CRM”']);
  assert.ok(result.every(r => source.slice(r.start, r.end) === r.quote));
});
test('fabricated quote is dropped, not promoted to evidence', () => {
  assert.deepEqual(verifySnapshotQuotes(source, documentId, ['Zarządzał zespołem 90 osób']), []);
});
test('partially changed quote is not fuzzy-matched', () => {
  assert.deepEqual(verifySnapshotQuotes(source, documentId, ['SQL i zestawieniami']), []);
});
test('empty CV snapshot never produces evidence', () => {
  assert.deepEqual(verifySnapshotQuotes('  \n ', documentId, ['SQL']), []);
});
