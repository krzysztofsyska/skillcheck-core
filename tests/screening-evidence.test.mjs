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
test('restored original longer than the 2000-unit DB limit is dropped', () => {
  const spaced = `${'a'.repeat(1000)}${' '.repeat(10)}${'b'.repeat(995)}`;
  const proposal = `${'a'.repeat(1000)} ${'b'.repeat(995)}`;
  assert.ok(proposal.length <= 2000);
  assert.deepEqual(verifySnapshotQuotes(spaced, documentId, [proposal]), []);
});
test('a citation spanning several CV lines verifies as one quote', () => {
  const multiline = 'Linia 1\nLinia 2\nLinia 3\nLinia 4\nLinia 5\nLinia 6';
  const [result] = verifySnapshotQuotes(multiline, documentId, [multiline]);
  assert.equal(result.quote, multiline);
});
