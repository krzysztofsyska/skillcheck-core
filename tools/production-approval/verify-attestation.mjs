// Production approval attestation for PRs into main (SC-OPS-PROD-ATTEST).
// Runs only from the main revision via pull_request_target; it never checks out
// or executes pull request code. The result is a commit status on the exact PR
// head SHA, so a new push always needs a new owner approval.

export const STATUS_CONTEXT = 'production-approval-attestation';
export const WORKFLOW_PATH = '.github/workflows/production-approval-attestation.yml';
export const ENVIRONMENT = 'production-approval';

// Pure decision: GitHub API facts in, pass/fail with reasons out.
export function evaluate({ expected, run, approvals, pr, approvalResult }) {
  const reasons = [];
  if (approvalResult !== 'success') reasons.push(`approval job result is ${approvalResult ?? 'missing'}`);
  if (!run || run.id !== expected.runId) reasons.push('workflow run mismatch');
  else {
    if (run.event !== 'pull_request_target') reasons.push(`unexpected event ${run.event}`);
    if (run.path !== WORKFLOW_PATH && !String(run.path).startsWith(`${WORKFLOW_PATH}@`)) reasons.push(`unexpected workflow ${run.path}`);
  }
  if (!pr) reasons.push('pull request missing');
  else {
    if (pr.state !== 'open') reasons.push(`pull request is ${pr.state}`);
    if (pr.base?.ref !== 'main') reasons.push(`base is ${pr.base?.ref}, not main`);
    if (pr.head?.sha !== expected.headSha) reasons.push('pull request head moved since this approval run started');
  }
  const list = Array.isArray(approvals) ? approvals : [];
  const forEnv = list.filter(a => (a.environments ?? []).some(e => e?.name === ENVIRONMENT));
  if (forEnv.some(a => a.state !== 'approved')) reasons.push('a reviewer rejected the environment');
  const owner = forEnv.filter(a => a.state === 'approved'
    && a.user?.login === expected.ownerLogin && a.user?.id === expected.ownerId);
  if (owner.length === 0) reasons.push(`no approval of ${ENVIRONMENT} by ${expected.ownerLogin} for this run`);
  return { ok: reasons.length === 0, reasons };
}

async function api(path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'x-github-api-version': '2022-11-28',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${init.method ?? 'GET'} ${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function setStatus(repo, sha, state, description) {
  await api(`/repos/${repo}/statuses/${sha}`, {
    method: 'POST',
    body: JSON.stringify({ state, context: STATUS_CONTEXT, description: description.slice(0, 140) }),
  });
}

async function main() {
  const env = name => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} required`);
    return value;
  };
  const repo = env('REPOSITORY');
  const headSha = env('HEAD_SHA');
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error('HEAD_SHA must be a full commit SHA');
  const mode = process.argv[2];
  if (mode === 'pending') {
    await setStatus(repo, headSha, 'pending', `Waiting for owner approval in environment ${ENVIRONMENT}`);
    return;
  }
  if (mode !== 'verify') throw new Error('usage: verify-attestation.mjs pending|verify');
  const expected = {
    runId: Number(env('RUN_ID')), headSha,
    ownerLogin: env('OWNER_LOGIN'), ownerId: Number(env('OWNER_ID')),
  };
  let result;
  try {
    const [run, approvals, pr] = await Promise.all([
      api(`/repos/${repo}/actions/runs/${expected.runId}`),
      api(`/repos/${repo}/actions/runs/${expected.runId}/approvals`),
      api(`/repos/${repo}/pulls/${env('PR_NUMBER')}`),
    ]);
    result = evaluate({ expected, run, approvals, pr, approvalResult: process.env.APPROVAL_RESULT });
  } catch (error) {
    // Fail closed: any API error is a failed attestation, never a pass.
    result = { ok: false, reasons: [String(error.message ?? error)] };
  }
  const summary = result.ok
    ? `Approved by ${expected.ownerLogin} for ${headSha.slice(0, 12)}`
    : `Not approved: ${result.reasons.join('; ')}`;
  console.log(summary);
  await setStatus(repo, headSha, result.ok ? 'success' : 'failure', summary);
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
