import { sha256 } from './canonical.mjs';

export async function preparePromotion(github, policy, records, integrationSha, mainSha) {
  const accepted = Object.values(records).filter(r => r.state === 'ACCEPTED' && r.binding.approval?.gate === 'A' && r.binding.merge?.mergeCommitSha);
  if (!accepted.length || integrationSha === mainSha) return null;
  const diff = await github.readComparison(mainSha, integrationSha);
  if (diff.status !== 'ahead') throw new Error('PROMOTION_HISTORY_DIVERGED');
  const covered = new Set();
  const tasks = [];
  for (const record of accepted) {
    const mergeSha = record.binding.merge.mergeCommitSha;
    if (!diff.commits.some(c => c.sha === mergeSha)) continue;
    const taskDiff = await github.readComparison(record.base_sha, record.head_sha);
    for (const commit of taskDiff.commits) covered.add(commit.sha);
    covered.add(mergeSha);
    tasks.push({ task_id: record.task_id, head_sha: record.head_sha, merge_sha: mergeSha,
      approval_request_id: record.approval_request_id, approval_digest: record.binding.approval.digest,
      approval_run_id: record.binding.approval.run_id });
  }
  const runbook = await github.readReleasePlan(mainSha);
  const complete = tasks.length > 0 && diff.commits.every(c => covered.has(c.sha));
  const validRunbook = runbook && typeof runbook.id === 'string' && Array.isArray(runbook.operations)
    && runbook.operations.length > 0 && typeof runbook.rollback === 'string' && runbook.rollback.length > 0
    && Array.isArray(runbook.smoke_tests) && runbook.smoke_tests.length > 0;
  const manifest = { integration_sha: integrationSha, main_sha: mainSha, tasks,
    commits: diff.commits.map(c => c.sha), files: diff.files.map(f => f.filename), runbook };
  return { taskId: `SC-PROMOTE-${sha256(manifest).slice(0, 16).toUpperCase()}`,
    issueNumber: accepted[0].issue_number, manifest, runbook: validRunbook && complete ? runbook : null,
    blockedReason: !complete ? 'PROMOTION_SCOPE_UNACCOUNTED' : !validRunbook ? 'MISSING_RUNBOOK' : null,
    tasks, operations: runbook?.operations ?? [], rollback: runbook?.rollback ?? null,
    smokeTests: runbook?.smoke_tests ?? [], secretNames: runbook?.secret_names ?? [] };
}
