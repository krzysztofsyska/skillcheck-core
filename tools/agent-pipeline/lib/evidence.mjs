import { basename } from 'node:path';

export async function findRun(github, policy, kind, requestId, recordedId) {
  let run;
  if (recordedId) run = await github.readRun(recordedId);
  else {
    const runs = await github.listWorkflowRuns(basename(policy.workflows[kind]));
    const matches = runs.filter(r => r.display_title === `sc-agent:${requestId}`);
    if (matches.length !== 1) return null;
    run = matches[0];
  }
  if (run.workflow_id !== policy.workflow_ids[kind] || run.path !== policy.workflows[kind]
      || run.event !== 'workflow_dispatch' || run.head_branch !== 'main'
      || run.actor?.id !== policy.controller_actor_id
      || run.display_title !== `sc-agent:${requestId}`) return null;
  return run;
}

export async function artifactFromRun(github, run, name) {
  const artifacts = await github.listArtifacts(run.id);
  const matches = artifacts.filter(a => a.name === name && !a.expired && a.workflow_run?.id === run.id);
  if (matches.length !== 1) return null;
  return github.downloadArtifactJson(matches[0].id);
}

export async function readEvidence(github, policy, records) {
  const evidence = {};
  for (const record of Object.values(records)) {
    if (!record.review_request_id || !record.head_sha) continue;
    const pair = {};
    for (const kind of ['verify', 'review']) {
      const run = await findRun(github, policy, kind, record.review_request_id, kind === 'verify' ? record.ci_run_id : record.review_run_id);
      if (!run || run.run_attempt !== 1 || run.head_sha !== record.policy_sha || run.status !== 'completed') continue;
      if (kind === 'review' && run.conclusion !== 'success') continue;
      const body = await artifactFromRun(github, run, kind === 'verify' ? 'sc-agent-ci' : 'sc-agent-review');
      if (!body || body.run_id !== run.id || body.run_attempt !== run.run_attempt || body.policy_sha !== run.head_sha
          || body.workflow_id !== run.workflow_id || body.workflow_path !== run.path) continue;
      if (kind === 'verify') {
        if (body.head_sha !== record.head_sha || body.base_sha !== record.base_sha) continue;
        const jobs = await github.readJobs(run.id);
        pair.ci = { ...body, conclusion: run.conclusion, jobs: jobs.map(j => ({ name: j.name, conclusion: j.conclusion })) };
      } else pair.review = body;
    }
    evidence[record.task_id] = pair;
  }
  return evidence;
}

export async function readApprovals(github, policy, records) {
  const approvals = {};
  for (const record of Object.values(records)) {
    const request = record.binding?.approval;
    if (!request) continue;
    const kind = request.gate === 'A' ? 'accept' : 'promote';
    const run = await findRun(github, policy, kind, request.request_id, request.run_id);
    if (!run || run.head_sha !== record.policy_sha) continue;
    const expectedEnvironment = request.gate === 'A' ? policy.environments.owner_acceptance : policy.environments.production_approval;
    const history = await github.readApprovals(run.id);
    let payload = (history ?? []).filter(entry => entry.state === 'rejected');
    if (run.status === 'completed' && run.conclusion === 'success' && run.run_attempt === 1) {
      const marker = await artifactFromRun(github, run, request.gate === 'A' ? 'sc-agent-accept' : 'sc-agent-promote');
      if (!marker || marker.request_id !== request.request_id || marker.digest !== request.digest || marker.gate !== request.gate) continue;
      payload = history;
    }
    approvals[request.request_id] = { request_id: request.request_id, run_id: run.id,
      run_attempt: run.run_attempt, workflow_id: run.workflow_id, workflow_path: run.path,
      ref: `refs/heads/${run.head_branch}`, environment: expectedEnvironment, payload,
      html_url: run.html_url, conclusion: run.conclusion, gate: request.gate };
  }
  return approvals;
}
