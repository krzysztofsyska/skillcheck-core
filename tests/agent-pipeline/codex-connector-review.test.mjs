import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CODEX_CONNECTOR_BOT, verifyCodexConnectorReview } from '../../tools/agent-pipeline/lib/codex-connector-review.mjs';

const HEAD = 'a'.repeat(40), OTHER = 'b'.repeat(40);
const state = (code = {}, security = {}) => ({
  code_review: { commit_sha: HEAD, status: 'completed', has_any_findings: false,
    has_unresolved_findings: false, ...code },
  security_review: { commit_sha: null, status: null, has_any_findings: null,
    has_unresolved_findings: null, ...security },
});
const summary = (data = state(), extra = '') => ({
  id: 6851727812,
  user: { id: CODEX_CONNECTOR_BOT.id, login: CODEX_CONNECTOR_BOT.login },
  body: `<!-- codex-pull-request-review-summary -->
<!-- codex-review-state:v1 ${JSON.stringify(data)} -->
<details><summary>Codex Review Summary</summary>${extra}</details>`,
});
const args = (override = {}) => ({
  comments: [summary()], threads: [], headSha: HEAD, builderActorId: 222297538, ...override,
});
const reason = (override, expected) => {
  const actual = verifyCodexConnectorReview(args(override));
  assert.equal(actual.ok, false);
  assert.equal(actual.reason, expected);
};

test('completed exact-HEAD review by pinned GitHub bot is accepted as read-only evidence', () => {
  const value = verifyCodexConnectorReview(args());
  assert.deepEqual(value, { ok: true, source: 'github_codex_connector', headSha: HEAD,
    reviewerId: CODEX_CONNECTOR_BOT.id, commentId: 6851727812,
    codeReview: 'completed', securityReview: 'not_requested' });
  const withSecurity = verifyCodexConnectorReview(args({
    comments: [summary(state({}, { commit_sha: HEAD, status: 'completed',
      has_any_findings: false, has_unresolved_findings: false }))],
  }));
  assert.equal(withSecurity.ok, true);
  assert.equal(withSecurity.securityReview, 'completed');
});

test('forged, missing, duplicate, malformed and unknown-source evidence fails closed', () => {
  reason({ comments: [] }, 'CODEX_SUMMARY_MISSING_OR_AMBIGUOUS');
  reason({ comments: [summary(), summary()] }, 'CODEX_SUMMARY_MISSING_OR_AMBIGUOUS');
  reason({ comments: [{ ...summary(), id: 25, user: { id: 1, login: 'malicious' } }] }, 'CODEX_SUMMARY_MISSING_OR_AMBIGUOUS');
  assert.equal(verifyCodexConnectorReview(args({ comments: [summary(), { ...summary(), id: 25, user: { id: 1, login: 'malicious' } }] })).ok, true);
  reason({ comments: [summary()], threads: null }, 'CODEX_GITHUB_DATA_INCOMPLETE');
  reason({ comments: null }, 'CODEX_GITHUB_DATA_INCOMPLETE');
  reason({ comments: [summary()], headSha: 'wrong' }, 'CODEX_HEAD_INVALID');
  reason({ comments: [summary()], builderActorId: undefined }, 'CODEX_BUILDER_IDENTITY_UNKNOWN');
  reason({ comments: [summary()], builderActorId: CODEX_CONNECTOR_BOT.id }, 'CODEX_SELF_REVIEW');
  reason({ comments: [{ ...summary(), id: 'unknown' }] }, 'CODEX_SUMMARY_INVALID');
  reason({ comments: [{ ...summary(), body: '<!-- codex-pull-request-review-summary -->\nnot-json' }] }, 'CODEX_STATE_MISSING_OR_AMBIGUOUS');
  reason({ comments: [{ ...summary(), body: '<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 {bad} -->' }] }, 'CODEX_STATE_INVALID_JSON');
});

test('stale, running, finding and ambiguous reviews never count as PASS', () => {
  reason({ comments: [summary(state({ commit_sha: OTHER }))] }, 'CODEX_REVIEW_STALE_HEAD');
  reason({ comments: [summary(state({ status: 'running' }))] }, 'CODEX_REVIEW_PENDING');
  reason({ comments: [summary(state({ has_any_findings: true }))] }, 'CODEX_REVIEW_FINDINGS_OR_UNKNOWN');
  reason({ comments: [summary(state({ has_unresolved_findings: null }))] }, 'CODEX_REVIEW_FINDINGS_OR_UNKNOWN');
  reason({ comments: [summary(state({ status: 'completed' }, { status: 'running' }))] }, 'CODEX_SECURITY_REVIEW_UNCONFIRMED');
  reason({ comments: [summary({ code_review: state().code_review, security_review: 'unknown' })] }, 'CODEX_SECURITY_REVIEW_UNCONFIRMED');
  reason({ comments: [summary({ code_review: state().code_review })] }, 'CODEX_SECURITY_REVIEW_UNCONFIRMED');
  reason({ comments: [summary(state({}, { has_any_findings: true }))] }, 'CODEX_SECURITY_REVIEW_UNCONFIRMED');
  reason({ comments: [summary(state({}, { has_unresolved_findings: true }))] }, 'CODEX_SECURITY_REVIEW_UNCONFIRMED');
  reason({ comments: [summary({ code_review: state().code_review, security_review: { status: null } })] }, 'CODEX_SECURITY_REVIEW_UNCONFIRMED');
  reason({ comments: [summary(state({}, { status: 'completed', commit_sha: OTHER,
    has_any_findings: false, has_unresolved_findings: false }))] }, 'CODEX_SECURITY_REVIEW_UNCONFIRMED');
  reason({ threads: [{ isResolved: false }] }, 'CODEX_REVIEW_THREAD_OPEN');
  reason({ threads: [{}] }, 'CODEX_REVIEW_THREAD_OPEN');
  const repeated = summary();
  repeated.body += '\n<!-- codex-review-state:v1 ' + JSON.stringify(state()) + ' -->';
  reason({ comments: [repeated] }, 'CODEX_STATE_MISSING_OR_AMBIGUOUS');
});

test('adapter is read-only and contains no billed provider or dispatch path', () => {
  const source = readFileSync(new URL('../../tools/agent-pipeline/lib/codex-connector-review.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /OPENAI_API_KEY|ANTHROPIC_API_KEY|CURSOR_API_KEY|createAgent|dispatch|fetch\(/);
});
