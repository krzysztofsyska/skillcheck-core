import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ENVIRONMENT, WORKFLOW_PATH, evaluate } from '../tools/production-approval/verify-attestation.mjs';

const owner = { login: 'krzysztofsyska', id: 222297538 };
const current = 'a'.repeat(40), old = 'b'.repeat(40);
const base = () => ({
  expected: { runId: 7, headSha: current, ownerLogin: owner.login, ownerId: owner.id },
  run: { id: 7, event: 'pull_request_target', path: WORKFLOW_PATH },
  approvals: [{ state: 'approved', user: owner, environments: [{ name: ENVIRONMENT }] }],
  pr: { state: 'open', base: { ref: 'main' }, head: { sha: current } },
  approvalResult: 'success',
});

test('owner approval for the current head SHA passes', () => {
  assert.deepEqual(evaluate(base()), { ok: true, reasons: [] });
});

test('no approval fails', () => {
  const input = { ...base(), approvals: [], approvalResult: 'skipped' };
  const result = evaluate(input);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some(r => r.includes('no approval')));
});

test('approval given for an older SHA fails after a new push', () => {
  const input = base();
  input.expected.headSha = old; // the approved run was started for the old head
  const result = evaluate(input);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some(r => r.includes('head moved')));
});

test('approval by anyone other than the owner, or for another environment, fails', () => {
  for (const approvals of [
    [{ state: 'approved', user: { login: 'skillcheck-agent-ks[bot]', id: 1 }, environments: [{ name: ENVIRONMENT }] }],
    [{ state: 'approved', user: { login: owner.login, id: 999 }, environments: [{ name: ENVIRONMENT }] }],
    [{ state: 'approved', user: owner, environments: [{ name: 'owner-acceptance' }] }],
  ]) assert.equal(evaluate({ ...base(), approvals }).ok, false);
});

test('rejection, wrong event, wrong workflow, closed PR or non-main base fails', () => {
  const cases = [
    i => { i.approvals.push({ state: 'rejected', user: owner, environments: [{ name: ENVIRONMENT }] }); },
    i => { i.approvalResult = 'failure'; },
    i => { i.run.event = 'pull_request'; },
    i => { i.run.path = '.github/workflows/other.yml'; },
    i => { i.run.id = 8; },
    i => { i.pr.state = 'closed'; },
    i => { i.pr.base.ref = 'integration'; },
  ];
  for (const mutate of cases) { const input = base(); mutate(input); assert.equal(evaluate(input).ok, false); }
});

test('workflow never checks out PR code and keeps permissions minimal', async () => {
  const yml = await readFile(new URL(`../${WORKFLOW_PATH}`, import.meta.url), 'utf8');
  assert.match(yml, /pull_request_target:\s*\n\s*branches: \[main\]/);
  assert.match(yml, /^permissions: \{\}$/m);
  assert.doesNotMatch(yml, /pull_request\.head\.(ref|repo)/);
  assert.doesNotMatch(yml, /ref:\s*\$\{\{/, 'checkout ref must be the literal main');
  assert.equal((yml.match(/ref: main/g) ?? []).length, (yml.match(/actions\/checkout@/g) ?? []).length);
  assert.match(yml, /environment: production-approval/);
  assert.doesNotMatch(yml, /write-all|contents: write|pull-requests: write|actions: write/);
  assert.match(yml, /if: always\(\) && needs\.pending\.result == 'success'/, 'rejection must produce a failure status, not a skip');
});
