import { sha256 } from '../../tools/agent-pipeline/lib/canonical.mjs';
import { parseContract } from '../../tools/agent-pipeline/lib/contract.mjs';
import { loadPolicy } from '../../tools/agent-pipeline/lib/policy.mjs';
import { newRecord } from '../../tools/agent-pipeline/lib/record.mjs';

export const HEAD = 'a'.repeat(40);
export const NEXT_HEAD = 'b'.repeat(40);
export const BASE = 'c'.repeat(40);

export function contractBody() {
  return [
    'TASK: SC-DEMO-001',
    'LEVEL: L2',
    'SCOPE: FRONTEND',
    'STATUS: READY',
    'OWNER: Cursor',
    'REVIEWER: Codex',
    'DEPENDS_ON: NONE',
    'ACCEPTANCE_CRITERIA:',
    '- Show the demo',
    'SECURITY_CHECKS:',
    '- No credentials in the client',
    'BRANCH_SLUG: demo',
    'ALLOWED_FILES:',
    '- app/demo/**',
    'REQUIRED_TESTS:',
    '- npm run typecheck',
  ].join('\n');
}

export function loadedPolicy() {
  const policy = loadPolicy();
  return { policy, policySha: 'd'.repeat(40) };
}

export function observation(patch = {}) {
  const { policy, policySha } = loadedPolicy();
  return {
    now: '2026-10-06T12:00:00.000Z',
    kind: 'task',
    simulation: true,
    flags: { enabled: false, mergeEnabled: false },
    policy,
    policySha,
    secrets: { cursor: true, openai: false, githubApp: false },
    issue: { number: 7, authorId: policy.owner.id, authorLogin: 'krzysztofsyska', body: contractBody() },
    github: {
      repositoryId: policy.repository_id,
      fork: false,
      integrationSha: BASE,
      mainSha: 'd'.repeat(40),
      branch: null,
      pull: null,
      pulls: [],
      protection: {
        exclusiveWritersConfirmed: false,
        scOps001Exception: false,
        mainProtected: false,
        integrationProtected: false,
        agentStateProtected: false,
        qualityGatesBypass: false,
        administrationWriteUsed: false,
        requiredChecksPinnedToApp: false,
      },
      ci: null,
      review: null,
    },
    cursor: null,
    approval: null,
    ...patch,
  };
}

export function taskRecord(patch = {}) {
  const { policy, policySha } = loadedPolicy();
  const contract = parseContract(contractBody());
  const record = newRecord({ repositoryId: policy.repository_id, taskId: contract.task_id, issueNumber: 7, policySha, now: '2026-10-06T12:00:00.000Z' });
  record.contract_hash = contract.hash;
  record.base_sha = BASE;
  record.head_sha = HEAD;
  record.pr_number = 50;
  record.binding.branch = 'feat/sc-demo-001-demo';
  record.binding.allowed_files = contract.allowed_files;
  record.binding.required_tests = contract.required_tests;
  return Object.assign(record, patch);
}
