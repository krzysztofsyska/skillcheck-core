import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { plan } from '../../tools/agent-pipeline/lib/transitions.mjs';
import { buildCiEnvelope } from '../../tools/agent-pipeline/lib/ci.mjs';
import { CODEX_CONNECTOR_BOT } from '../../tools/agent-pipeline/lib/codex-connector-review.mjs';
import { BASE, HEAD, NEXT_HEAD, observation, taskRecord } from './helpers.mjs';

// SC-436-WIRE-VALIDATOR: Codex connector evidence drives PR_REVIEW in
// SUBSCRIPTION_ONLY. Offline only; no network, no paid API.
const BUILDER = 338844913;
const subscription = obs => { obs.policy.execution_mode = 'SUBSCRIPTION_ONLY'; obs.policy.builder_provider = 'claude-code'; return obs; };
const summary = (code = {}) => ({
  id: 6851727812,
  user: { id: CODEX_CONNECTOR_BOT.id, login: CODEX_CONNECTOR_BOT.login },
  body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({
    code_review: { commit_sha: HEAD, status: 'completed', has_any_findings: false, has_unresolved_findings: false, ...code },
    security_review: { commit_sha: null, status: null, has_any_findings: null, has_unresolved_findings: null },
  })} -->`,
});

function setup({ comments = [summary()], threads = [], codex = true, ci = 'success', author = BUILDER, record: patch = {} } = {}) {
  const obs = subscription(observation());
  const record = taskRecord({ state: 'PR_REVIEW', review_request_id: 'e'.repeat(64), ci_run_id: 900, ...patch });
  obs.github.pull = { number: 50, authorId: author, headSha: HEAD, baseSha: BASE };
  obs.github.branch = { name: record.binding.branch, sha: HEAD, repositoryId: record.repository_id, files: [] };
  obs.github.ci = ci ? buildCiEnvelope({ policy: obs.policy, policySha: record.policy_sha, headSha: HEAD, baseSha: BASE,
    runId: 900, runAttempt: 1, commandsExecuted: obs.policy.required_ci_commands, conclusion: ci }) : null;
  obs.github.codexReview = codex ? { comments, threads } : null;
  return { record, obs };
}
const step = opts => { const { record, obs } = setup(opts); return { before: record, result: plan(record, obs) }; };

test('clean exact-HEAD Codex review + green CI reaches READY_FOR_OWNER and never arms a merge', () => {
  const { result } = step();
  assert.equal(result.record.state, 'READY_FOR_OWNER');
  assert.equal(result.record.technical_state, 'CODEX_REVIEW_PASSED');
  assert.equal(result.record.binding.evidence.codex.ok, true);
  assert.deepEqual(result.effects ?? [], []);
  assert.equal(result.record.binding.merge ?? null, null);
  assert.equal(result.record.binding.approval ?? null, null);
  // Next cycle holds: Codex evidence is not a signed review envelope.
  const { obs } = setup();
  const held = plan(result.record, obs);
  assert.equal(held.record.state, 'READY_FOR_OWNER');
  assert.deepEqual(held.effects ?? [], []);
  assert.equal(held.record.binding.merge ?? null, null);
});

test('missing evidence, stale SHA and unfinished review never PASS (wait, then timeout)', () => {
  for (const opts of [{ codex: false }, { comments: [] }, { comments: [summary({ commit_sha: NEXT_HEAD })] },
    { comments: [summary({ status: 'running' })] }]) {
    const { before, result } = step(opts);
    assert.equal(result.record.state, 'PR_REVIEW');
    assert.equal(result.record, before, 'nothing recorded while waiting');
    const late = setup(opts);
    late.obs.now = '2026-10-07T12:00:00.000Z';
    const timed = plan(late.record, late.obs);
    assert.equal(timed.record.state, 'BLOCKED');
    assert.equal(timed.record.blocked_reason, 'CI_REVIEW_TIMEOUT');
  }
});

test('open threads or findings go to FIXING with the thread ids as findings', () => {
  const open = step({ threads: [{ id: 'PRRT_1', isResolved: false }, { id: 'PRRT_2', isResolved: true }] }).result;
  assert.equal(open.record.state, 'FIXING');
  assert.deepEqual(open.record.binding.dispatch.findings.map(f => f.id), ['PRRT_1']);
  const findings = step({ comments: [summary({ has_any_findings: true })] }).result;
  assert.equal(findings.record.state, 'FIXING');
  assert.deepEqual(findings.record.binding.dispatch.findings.map(f => f.id), ['codex:CODEX_REVIEW_FINDINGS_OR_UNKNOWN']);
});

test('stale review and older unresolved thread wait, with no repeated repair', () => {
  const { before, result } = step({
    comments: [summary({ commit_sha: NEXT_HEAD })],
    threads: [{ id: 'PRRT_OLD', isResolved: false }],
  });
  assert.equal(result.record, before);
  assert.deepEqual(result.effects ?? [], []);
});

test('repair preserves Codex bot review text and location', () => {
  const { result } = step({ threads: [{
    id: 'PRRT_DETAIL', isResolved: false, path: 'lib/verification.mjs', line: 42,
    comments: [{ author: { login: 'chatgpt-codex-connector' }, body: 'Guard against stale HEAD before repairing.' }],
  }] });
  assert.equal(result.record.state, 'FIXING');
  assert.deepEqual(result.record.binding.dispatch.findings, [{
    id: 'PRRT_DETAIL', source: 'github_codex_connector', path: 'lib/verification.mjs',
    line: 42, description: 'Guard against stale HEAD before repairing.',
    required_fix: 'Guard against stale HEAD before repairing.',
  }]);
});

test('reviewer identity equal to builder, unknown builder or forged comment is rejected', () => {
  for (const [opts, reason] of [[{ author: CODEX_CONNECTOR_BOT.id }, 'CODEX_SELF_REVIEW'],
    [{ author: null }, 'CODEX_BUILDER_IDENTITY_UNKNOWN'],
    [{ threads: null }, 'CODEX_GITHUB_DATA_INCOMPLETE']]) {
    const { result } = step(opts);
    assert.equal(result.record.state, 'BLOCKED');
    assert.equal(result.record.blocked_reason, 'EVIDENCE_REJECTED');
    assert.equal(result.record.binding.reports.at(-1).review, reason);
  }
  const forged = step({ comments: [{ ...summary(), user: { id: BUILDER, login: 'skillcheck-agent-ks[bot]' } }] }).result;
  assert.equal(forged.record.state, 'PR_REVIEW', 'a forged summary is not evidence');
});

test('completed Codex review without CI evidence cannot pass or authorize merge', () => {
  const { record, obs } = setup({ ci: null });
  const pending = plan(record, obs);
  assert.equal(pending.record.state, 'PR_REVIEW');
  assert.deepEqual(pending.effects ?? [], []);
  assert.equal(pending.record.binding.merge ?? null, null);
  const timed = setup({ ci: null });
  timed.obs.now = '2026-10-07T12:00:00.000Z';
  const expired = plan(timed.record, timed.obs);
  assert.equal(expired.record.state, 'BLOCKED');
  assert.equal(expired.record.blocked_reason, 'CI_REVIEW_TIMEOUT');
});

test('failed CI with a clean Codex review is repaired, not passed', () => {
  const { result } = step({ ci: 'failure' });
  assert.equal(result.record.state, 'FIXING');
});

test('first review step dispatches only verify, never the billed review workflow', () => {
  const { record, obs } = setup({ record: { review_request_id: null, ci_run_id: null } });
  const result = plan(record, obs);
  assert.deepEqual(result.effects.map(e => e.workflow), ['verify']);
});

test('legacy mode keeps the review workflow; subscription mode never dispatches it', () => {
  const legacy = setup({ codex: false });
  legacy.obs.policy.execution_mode = 'LEGACY';
  assert.deepEqual(plan(legacy.record, legacy.obs).effects.map(e => e.workflow), ['review']);
  const sub = setup({ codex: false });
  assert.deepEqual(plan(sub.record, sub.obs).effects ?? [], []);
  const source = readFileSync(new URL('../../tools/agent-pipeline/lib/transitions.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /OPENAI_API_KEY|ANTHROPIC_API_KEY|CURSOR_API_KEY/);
});
