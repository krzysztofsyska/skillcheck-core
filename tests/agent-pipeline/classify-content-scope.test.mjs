import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../../tools/agent-pipeline/classify-pr.mjs';

// #399: content/** (e.g. content/kalkulator-demo.html, moved from public/ in #398) is FRONTEND.
const body = (scope, level = 'L2') => [
  'TASK: SC-TEST', `SCOPE: ${scope}`, `LEVEL: ${level}`, 'OWNER_APPROVAL: NOT_REQUIRED',
  'PRODUCTION_APPROVAL: NOT_REQUIRED', 'REVIEW_VERDICT: PENDING', 'PROMOTION: NO',
].join('\n');
const run = (files, scope, level) => classify({ files, body: body(scope, level), base: 'integration', headRef: 'claude/x' });

test('content/** alone classifies as FRONTEND', () => {
  assert.deepEqual(run(['content/kalkulator-demo.html'], 'FRONTEND').errors ?? [], []);
  assert.match(run(['content/kalkulator-demo.html'], 'OPERATIONS').errors.join('\n'), /classify as FRONTEND/);
});

test('content/** with backend files is FULLSTACK; other classifications unchanged', () => {
  assert.deepEqual(run(['content/kalkulator-demo.html', 'lib/x.ts'], 'FULLSTACK').errors ?? [], []);
  assert.deepEqual(run(['public/x.html'], 'FRONTEND').errors ?? [], []);
  assert.deepEqual(run(['lib/x.ts'], 'BACKEND').errors ?? [], []);
  assert.deepEqual(run(['docs/x.md'], 'OPERATIONS').errors ?? [], []);
  // only a top-level content/ directory counts, not a path that merely contains it
  assert.match(run(['docs/content/x.md'], 'FRONTEND').errors.join('\n'), /classify as OPERATIONS/);
});
