import { requiredReviewChecks } from './transitions.mjs';
import { sha256 } from './canonical.mjs';
import { evaluatePreflight, decideMerge } from './merge.mjs';
import { evaluateApproval, approvalStillCurrent } from './approval.mjs';
import { readEvidence, readApprovals } from './evidence.mjs';
import { validateCi } from './ci.mjs';
import { validateReview } from './review.mjs';
import { parseContract } from './contract.mjs';
import { buildNotification } from './notifications.mjs';
import { touch } from './record.mjs';

export function validatePair(record, pair, policy) {
  const common = { policySha: record.policy_sha, headSha: record.head_sha, baseSha: record.base_sha, runAttempt: 1 };
  return {
    ci: validateCi(pair?.ci, { ...common, workflowId: policy.workflow_ids.verify, workflowPath: policy.workflows.verify,
      runId: record.ci_run_id, requiredCommands: policy.required_ci_commands }),
    review: validateReview(pair?.review, { ...common, workflowId: policy.workflow_ids.review, workflowPath: policy.workflows.review,
      runId: record.review_run_id, requestId: record.review_request_id, repositoryId: record.repository_id,
      prNumber: record.pr_number, contractHash: record.contract_hash, requiredChecks: requiredReviewChecks(record) }),
  };
}

export async function publishEvidence(github, policy, record, pair) {
  if (!record.head_sha || !record.review_request_id || !pair?.ci || !pair?.review) return;
  const validated = validatePair(record, pair, policy);
  for (const kind of ['ci', 'review']) {
    await github.publishCheck({ head: record.head_sha, name: `sc-agent/${kind}`,
      externalId: `${record.task_id}:${record.review_request_id}:${kind}`,
      conclusion: validated[kind].pass ? 'success' : 'failure',
      summary: JSON.stringify({ task: record.task_id, head: record.head_sha, base: record.base_sha, policy: record.policy_sha, result: validated[kind] }) });
  }
}

export async function guardedMerge({ github, journal, policy, flags, effect }) {
  if (!flags.enabled || !flags.mergeEnabled) throw new Error('MERGE_DISABLED');
  const snapshot = await journal.assertOwned();
  const record = snapshot.tasks[effect.record.task_id];
  if (!record || record.binding.merge?.phase !== 'awaiting_confirmation') throw new Error('MERGE_INTENT_MISSING');
  const protection = await github.readProtection();
  if (!evaluatePreflight(protection).ok) throw new Error('PROTECTION_UNCONFIRMED');
  const [pull, main, base, evidence, approvals] = await Promise.all([
    github.readPull(record.pr_number), github.readBranch('main'),
    github.readBranch(effect.gate === 'B' ? 'main' : 'integration'),
    readEvidence(github, policy, { [record.task_id]: record }),
    readApprovals(github, policy, { [record.task_id]: record }),
  ]);
  if (pull.merged) return { merged: true, mergeCommitSha: pull.merge_commit_sha };
  if (main.commit.sha !== record.policy_sha || pull.state !== 'open'
      || pull.head.repo?.id !== policy.repository_id || pull.base.repo?.id !== policy.repository_id
      || pull.base.ref !== (effect.gate === 'B' ? 'main' : 'integration')
      || (effect.gate === 'B' && pull.head.ref !== 'integration')) throw new Error('APPROVAL_STALE');
  if (effect.gate === 'A') {
    const issue = await github.readIssue(record.issue_number);
    if (parseContract(issue.body).hash !== record.contract_hash) throw new Error('CONTRACT_EDITED');
  }
  const pair = evidence[record.task_id];
  const checked = validatePair(record, pair, policy);
  if (!checked.ci.pass || !checked.review.pass) throw new Error('EVIDENCE_STALE');
  const request = record.binding.approval;
  if (effect.gate === 'A' && (request.canonical.review_digest !== sha256(pair.review.payload) || request.canonical.ci_digest !== sha256(pair.ci))) throw new Error('EVIDENCE_STALE');
  if (effect.gate === 'B') {
    const frozen = request.canonical.ci_review_evidence?.[0];
    const manifest = record.binding.promotion?.manifest;
    if (!frozen || frozen.ci_digest !== sha256(pair.ci) || frozen.review_digest !== sha256(pair.review)
        || request.canonical.manifest_hash !== sha256(manifest)
        || manifest?.integration_sha !== record.head_sha || manifest?.main_sha !== record.base_sha) throw new Error('PROMOTION_EVIDENCE_STALE');
  }
  const approval = approvals[request.request_id];
  const result = evaluateApproval({ request, run: approval, payload: approval?.payload,
    expectedUser: policy.owner, expectedEnvironment: effect.gate === 'B' ? policy.environments.production_approval : policy.environments.owner_acceptance });
  const decision = decideMerge({ flags, protection, lock: snapshot.mergeLock, holder: journal.holder,
    liveBaseSha: base.commit.sha, expectedBaseSha: record.base_sha, liveHeadSha: pull.head.sha, expectedHeadSha: record.head_sha,
    approval: result, gate: effect.gate, runbook: record.binding.promotion?.runbook,
    owner: policy.repository.split('/')[0], repo: policy.repository.split('/')[1], prNumber: record.pr_number });
  if (!decision.ok) throw new Error(decision.reason);
  if (pull.draft) await github.readyPull(pull.node_id);
  await publishEvidence(github, policy, record, pair);
  const name = effect.gate === 'B' ? 'production-approval' : 'owner-acceptance';
  await github.publishCheck({ head: record.head_sha, name: `sc-agent/${name}`, externalId: request.request_id, conclusion: 'success', summary: JSON.stringify(request.canonical) });
  if (effect.gate === 'B') await github.publishCheck({ head: record.head_sha, name: 'sc-agent/promotion-scope', externalId: request.request_id, conclusion: 'success', summary: JSON.stringify(record.binding.promotion) });
  // No writer except this holder can move the base; GitHub strict rules apply.
  await journal.assertOwned();
  return github.merge({ prNumber: record.pr_number, sha: record.head_sha });
}

export async function drainOutbox({ github, journal, policy, record, now }) {
  const kinds = ['READY_FOR_OWNER', 'READY_FOR_PROD', 'BLOCKED', 'DONE'];
  let pending = record.binding.pending_notification;
  if (!pending && kinds.includes(record.state) && record.binding.last_notified_state !== record.state) {
    const next = touch(record, now);
    next.binding.pending_notification = buildNotification({ taskId: record.task_id, stateRevision: record.state_revision,
      recipient: policy.notification_recipient, kind: record.state, headSha: record.head_sha, baseSha: record.base_sha,
      result: record.blocked_reason || record.state, evidenceUrl: record.pr_number ? `${policy.repository_url}/pull/${record.pr_number}` : `${policy.repository_url}/issues/${record.issue_number}`, actionUrl: null });
    await journal.save(next, { action: 'outbox-intent' }, record); record = next; pending = next.binding.pending_notification;
  }
  if (!pending || !record.issue_number || (pending.retry_at && Date.parse(pending.retry_at) > Date.parse(now))) return record;
  if (pending.kind.startsWith('READY_') && !record.binding.approval?.run_id) return record;
  const runUrl = record.binding.approval?.run_id ? `${policy.repository_url}/actions/runs/${record.binding.approval.run_id}` : null;
  const comments = await github.readComments(record.issue_number);
  const marker = `skillcheck-report:${record.task_id}`;
  const matches = comments.filter(c => c.user?.id === policy.controller_actor_id && c.body?.includes(marker));
  if (matches.length > 1) return record; // ambiguous report ownership: do not create more
  const delivered = matches[0]?.body?.includes(pending.marker);
  if (!delivered && pending.delivery_phase === 'unknown') return record;
  if (!delivered) {
    const next = touch(record, now); next.binding.pending_notification.delivery_phase = 'unknown';
    await journal.save(next, { action: 'outbox-send' }, record); record = next;
    const body = `${marker}\n${pending.body}\naction: ${runUrl || pending.action_url || ''}\n\nApproval scope (immutable digest ${record.binding.approval?.digest ?? 'none'}):\n${JSON.stringify(record.binding.approval?.canonical ?? null, null, 2)}\n`;
    try {
      if (matches[0]) await github.updateComment(matches[0].id, body);
      else await github.comment({ issueNumber: record.issue_number, body });
    } catch (error) {
      // Unknown delivery is reconciled by marker on subsequent ticks, never
      // blindly posted twice. Definite rate-limit rejection can be retried.
      if (error.status === 429) {
        const retry = touch(record, now); const item = retry.binding.pending_notification;
        item.attempts = (item.attempts ?? 0) + 1;
        if (item.attempts < 3) item.delivery_phase = 'retry';
        item.retry_at = new Date(Date.parse(now) + Math.max(item.attempts === 1 ? 60000 : 300000, Number(error.retryAfter || 0) * 1000)).toISOString();
        await journal.save(retry, { action: 'outbox-rate-limit' }, record); return retry;
      }
      return record;
    }
  }
  const next = touch(record, now); next.binding.pending_notification = null; next.binding.last_notified_state = pending.kind;
  await journal.save(next, { action: 'outbox-delivered' }, record); return next;
}
