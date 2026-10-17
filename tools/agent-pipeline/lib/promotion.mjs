import { sha256 } from './canonical.mjs';

function promotionCandidate(record) {
  const mergeSha = record.binding?.merge?.mergeCommitSha;
  if (record.state !== 'ACCEPTED' || record.binding?.lane === 'promotion' || !mergeSha) return null;
  const approval = record.binding.approval;
  if (approval?.gate === 'B') return null;
  if (approval?.gate === 'A') {
    return {
      task_id: record.task_id, head_sha: record.head_sha, merge_sha: mergeSha,
      approval_request_id: record.approval_request_id, approval_digest: approval.digest,
      approval_run_id: approval.run_id,
    };
  }
  const auto = record.binding.auto_integration;
  if (auto?.source !== 'verified_ci_review' || auto.head_sha !== record.head_sha || auto.base_sha !== record.base_sha
      || auto.policy_sha !== record.policy_sha || auto.contract_hash !== record.contract_hash
      || auto.ci_run_id == null || auto.ci_run_id !== record.ci_run_id
      || auto.review_run_id == null || auto.review_run_id !== record.review_run_id
      || typeof auto.ci_digest !== 'string' || auto.ci_digest.length === 0
      || typeof auto.review_digest !== 'string' || auto.review_digest.length === 0) return null;
  return {
    task_id: record.task_id, head_sha: record.head_sha, merge_sha: mergeSha,
    integration_source: 'verified_ci_review', ci_run_id: auto.ci_run_id, review_run_id: auto.review_run_id,
    ci_digest: auto.ci_digest, review_digest: auto.review_digest, contract_hash: auto.contract_hash,
    policy_sha: auto.policy_sha,
  };
}

export async function preparePromotion(github, policy, records, integrationSha, mainSha) {
  const accepted = Object.values(records).flatMap(record => {
    const task = promotionCandidate(record);
    return task ? [{ record, task }] : [];
  });
  if (!accepted.length || integrationSha === mainSha) return null;
  const diff = await github.readComparison(mainSha, integrationSha);
  if (diff.status !== 'ahead') throw new Error('PROMOTION_HISTORY_DIVERGED');
  const covered = new Set();
  const tasks = [];
  for (const { record, task } of accepted) {
    const mergeSha = task.merge_sha;
    if (!diff.commits.some(c => c.sha === mergeSha)) continue;
    const taskDiff = await github.readComparison(record.base_sha, record.head_sha);
    for (const commit of taskDiff.commits) covered.add(commit.sha);
    covered.add(mergeSha);
    tasks.push(task);
  }
  const runbook = await github.readReleasePlan(mainSha);
  const complete = tasks.length > 0 && diff.commits.every(c => covered.has(c.sha));
  const validRunbook = runbook && typeof runbook.id === 'string' && Array.isArray(runbook.operations)
    && runbook.operations.length > 0 && typeof runbook.rollback === 'string' && runbook.rollback.length > 0
    && Array.isArray(runbook.smoke_tests) && runbook.smoke_tests.length > 0;
  const manifest = { integration_sha: integrationSha, main_sha: mainSha, tasks,
    commits: diff.commits.map(c => c.sha), files: diff.files.map(f => f.filename), runbook };
  return { taskId: `SC-PROMOTE-${sha256(manifest).slice(0, 16).toUpperCase()}`,
    issueNumber: accepted[0].record.issue_number, manifest, runbook: validRunbook && complete ? runbook : null,
    blockedReason: !complete ? 'PROMOTION_SCOPE_UNACCOUNTED' : !validRunbook ? 'MISSING_RUNBOOK' : null,
    tasks, operations: runbook?.operations ?? [], rollback: runbook?.rollback ?? null,
    smokeTests: runbook?.smoke_tests ?? [], secretNames: runbook?.secret_names ?? [] };
}
