import { parseContract } from './contract.mjs';

export function assembleWork({ policy, policySha, now, secrets, prompts = null, snapshot }) {
  const integrationSha = snapshot.integrationSha ?? null;
  const mainSha = snapshot.mainSha ?? null;
  const records = snapshot.records ?? {};
  const pulls = (snapshot.pulls ?? []).map(normalizePull).filter(Boolean);
  const issues = (snapshot.issues ?? []).filter(issue => issue && !issue.pull_request);
  const items = [];
  const seen = new Set();

  for (const issue of issues) {
    const contract = parseContract(issue.body ?? '');
    if (!contract.task_id) continue;
    seen.add(contract.task_id);
    const record = records[contract.task_id] ?? null;
    items.push({ record, observation: observe({ policy, policySha, now, secrets, prompts, snapshot, issue, record, pulls, integrationSha, mainSha }) });
  }
  for (const [taskId, record] of Object.entries(records)) {
    if (seen.has(taskId)) continue;
    items.push({ record, observation: observe({ policy, policySha, now, secrets, prompts, snapshot, issue: null, record, pulls, integrationSha, mainSha }) });
  }
  if (snapshot.promotion && !records[snapshot.promotion.taskId]) {
    const obs = observe({ policy, policySha, now, secrets, prompts, snapshot, issue: null, record: null, pulls, integrationSha, mainSha });
    obs.kind = 'promotion'; obs.promotion = snapshot.promotion;
    obs.github.pull = pulls.find(p => p.headRef === 'integration' && p.baseRef === 'main' && p.headRepositoryId === policy.repository_id && p.baseRepositoryId === policy.repository_id) ?? null;
    items.push({ record: null, observation: obs });
  }
  const active = items.filter(i => i.record && !['ACCEPTED', 'DONE', 'BLOCKED'].includes(i.record.state));
  const terminal = items.filter(i => i.record && ['ACCEPTED', 'DONE', 'BLOCKED'].includes(i.record.state));
  const fresh = items.filter(i => !i.record && (i.observation.kind === 'promotion' || (i.observation.dependenciesReady && parseContract(i.observation.issue?.body).ready && [policy.owner.id, ...(policy.orchestrators ?? []).map(a => a.id)].includes(i.observation.issue?.authorId))));
  // One active task per repository. Terminal records still reconcile their outbox.
  const selected = active.length ? active : fresh.length ? [fresh[0]] : terminal.filter(i => i.record.binding?.pending_notification);
  return { items: selected, integrationSha, mainSha, read: snapshot.read ?? 'github' };
}

function observe({ policy, policySha, now, secrets, prompts, snapshot, issue, record, pulls, integrationSha, mainSha }) {
  const taskId = record?.task_id ?? parseContract(issue?.body ?? '').task_id;
  const branchName = record?.binding?.branch ?? null;
  const branch = branchName ? snapshot.branches?.[branchName] ?? null : null;
  const pull = pulls.find(item => matchesPull(item, record, taskId)) ?? null;
  const agentId = record?.cursor_agent_id ?? null;
  const evidence = (taskId && snapshot.evidence?.[taskId]) || (record?.head_sha && snapshot.evidence?.[record.head_sha]) || {};
  const approval = record?.approval_request_id ? snapshot.approvals?.[record.approval_request_id] ?? null : null;
  return {
    now,
    dependenciesReady: String(parseContract(issue?.body ?? '').depends_on ?? '').split(/[, ]+/).filter(x => x && x !== 'NONE').every(id => recordsDependency(snapshot, id)),
    kind: record?.binding?.lane === 'promotion' ? 'promotion' : 'task',
    simulation: false,
    flags: { enabled: false, mergeEnabled: false },
    policy,
    policySha,
    secrets,
    prompts,
    issue: issue ? {
      number: issue.number,
      authorId: issue.user?.id ?? issue.authorId ?? null,
      authorLogin: issue.user?.login ?? issue.authorLogin ?? null,
      body: issue.body ?? '',
    } : null,
    github: {
      repositoryId: policy.repository_id,
      fork: false,
      integrationSha,
      mainSha,
      branch: branch ? {
        name: branchName,
        sha: branch.sha,
        repositoryId: policy.repository_id,
        files: branch.files ?? [],
      } : null,
      pull,
      pulls,
      protection: snapshot.protection ?? null,
      ci: evidence.ci ?? null,
      review: evidence.review ?? null,
    },
    cursor: agentId ? snapshot.cursor?.[agentId] ?? null : null,
    approval,
    promotion: record?.binding?.lane === 'promotion' ? snapshot.promotions?.[record.task_id] ?? null : null,
    mergeLock: snapshot.mergeLock ?? null,
  };
}

function matchesPull(pull, record, taskId) {
  if (record?.pr_number && pull.number === record.pr_number) return true;
  if (record?.binding?.branch && pull.headRef === record.binding.branch && pull.baseRef === 'integration' && pull.headRepositoryId === record.repository_id && pull.baseRepositoryId === record.repository_id && String(pull.body ?? '').includes(`skillcheck-task:${taskId}`)) return true;
  return false;
}

export function normalizePull(pull) {
  if (!pull) return null;
  if (pull.headRef && pull.baseRef) return pull;
  return {
    number: pull.number,
    headRef: pull.head?.ref ?? null,
    baseRef: pull.base?.ref ?? null,
    headSha: pull.head?.sha ?? null,
    baseSha: pull.base?.sha ?? null,
    headRepositoryId: pull.head?.repo?.id ?? null,
    baseRepositoryId: pull.base?.repo?.id ?? null,
    body: pull.body ?? '',
    merged: pull.merged === true,
    mergeCommitSha: pull.merge_commit_sha ?? null,
  };
}

export function cursorSnapshot(agent, runsPayload) {
  const body = agent?.agent ?? agent ?? {};
  const listed = runsPayload?.runs ?? runsPayload?.items ?? (Array.isArray(runsPayload) ? runsPayload : []);
  const runs = listed.map(run => ({
    id: run.id,
    status: run.status,
    result: run.result ?? null, git: run.git ?? null,
    createdAt: run.createdAt ?? run.created_at ?? null,
  })).filter(run => run.id);
  return {
    agent: {
      id: body.id ?? null,
      latestRunId: body.latestRunId ?? body.latest_run_id ?? null,
    },
    runs,
  };
}

function recordsDependency(snapshot, id) { return ['ACCEPTED', 'DONE'].includes(snapshot.records?.[id]?.state); }
