// Agent Gates (#553 root cause): the PR metadata parser used to keep the LAST
// copy of a repeated field and compare LEVEL as raw text, so a body whose header
// said `LEVEL: L3` could fail with an unexplained "require LEVEL: L3", or pass
// with a different value than the one at the top. The gate is not loosened:
// an L3 change still needs exactly `LEVEL: L3`; ambiguity now fails closed with
// the value that was read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, parseMetadata } from '../../tools/agent-pipeline/classify-pr.mjs';

const header = (over = {}) => Object.entries({
  TASK: 'R6-2', SCOPE: 'BACKEND', LEVEL: 'L3', OWNER_APPROVAL: 'NOT REQUIRED', PRODUCTION_APPROVAL: 'REQUIRED',
  REVIEW_VERDICT: 'PENDING', PROMOTION: 'NO', ...over,
}).map(([k, v]) => `${k}: ${v}`).join('\n');
const migration = ['supabase/migrations/20990101000000_x.sql', 'lib/voice/x.ts'];
const run = (body, files = migration) => classify({ files, body, base: 'integration', headRef: 'claude/x' });

test('a migration with exactly LEVEL: L3 passes; L2 is refused and says what was read and why', () => {
  assert.deepEqual(run(header()).errors, []);
  const refused = run(header({ LEVEL: 'L2' }));
  assert.equal(refused.ok, false);
  assert.match(refused.errors.join('\n'), /require LEVEL: L3 \(read: L2; because of: database migration, security-sensitive path\)/);
  const pipeline = run(header({ LEVEL: 'L2', SCOPE: 'OPERATIONS' }), ['tools/agent-pipeline/classify-pr.mjs']);
  assert.match(pipeline.errors.join('\n'), /because of: agent-pipeline\/controller file/);
});

test('a decorated LEVEL is refused with the value read, never silently accepted', () => {
  for (const value of ['L3 (migration)', '**L3**', 'l3', 'L3.', 'L4']) {
    const out = run(header({ LEVEL: value }));
    assert.equal(out.ok, false, value);
    assert.ok(out.errors.some(e => e.includes('LEVEL must be exactly L1, L2 or L3') && e.includes(JSON.stringify(value))), value);
  }
  // A frontend-only change still accepts L1/L2.
  assert.equal(run(header({ LEVEL: 'L1', SCOPE: 'FRONTEND' }), ['app/x/page.tsx']).ok, true);
});

test('a deciding field written twice with different values fails closed (no last-line override)', () => {
  const body = `${header()}\n\n## Handoff\nLEVEL: L2\n`;
  const out = run(body);
  assert.equal(out.ok, false);
  assert.deepEqual(out.errors, ['Conflicting PR metadata field LEVEL: "L3" and "L2"']);
  // The reverse order (L2 at the top, L3 pasted later) is refused the same way: it used to pass.
  assert.equal(run(header({ LEVEL: 'L2' }) + '\nLEVEL: L3').ok, false);
  assert.equal(run(header() + '\nPROMOTION: YES').ok, false);
  assert.equal(run(header() + '\nSCOPE: FRONTEND').ok, false);
  // The same value repeated is not a conflict.
  assert.equal(run(header() + '\nLEVEL: L3\nSCOPE: BACKEND').ok, true);
});

test('informational fields may repeat (header + handoff); the first value is kept', () => {
  const parsed = parseMetadata(header() + '\nTASK: R6-2 pule rozmów\nREVIEW_VERDICT: PASS');
  assert.deepEqual(parsed.conflicts, []);
  assert.equal(parsed.fields.TASK, 'R6-2');
  assert.equal(parsed.fields.REVIEW_VERDICT, 'PENDING', 'a pasted verdict never overrides the header');
  assert.equal(run(header() + '\nTASK: other').ok, true);
});

test('missing fields are still reported one by one', () => {
  assert.deepEqual(run('TASK: x').errors.sort(), ['LEVEL', 'OWNER_APPROVAL', 'PRODUCTION_APPROVAL', 'PROMOTION', 'REVIEW_VERDICT', 'SCOPE']
    .map(f => `Missing PR metadata field: ${f}`).sort());
});
