import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPolicy } from '../lib/policy.mjs';
import { sha256 } from '../lib/canonical.mjs';
import { requiredReviewChecks } from '../lib/transitions.mjs';
import { tick } from '../lib/controller.mjs';
import { initStateRepo, updateState } from '../lib/journal.mjs';

const H1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const H2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BASE = 'cccccccccccccccccccccccccccccccccccccccc';
const MAIN = 'dddddddddddddddddddddddddddddddddddddddd';

export async function runCompleteCycle() {
  const policy = loadPolicy();
  const policySha = MAIN;
  const calls = [];
  const network = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    network.push(String(url));
    throw new Error(`external effect forbidden: ${url}`);
  };
  const dir = join(tmpdir(), `agent-cycle-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  initStateRepo(dir);
  const journal = gitJournal(dir);
  const world = createWorld(policy, policySha);
  let record = null;
  try {
    for (let step = 0; step < 40 && !world.taskStopped; step += 1) {
      const observation = world.observe(record);
      const result = await tick({ record, observation, journal, ports: world.ports(calls) });
      record = result.record;
      world.note(record, result);
    }
    let promotion = null;
    for (let step = 0; step < 8 && !world.promotionStopped; step += 1) {
      const observation = world.promotionObservation();
      const result = await tick({ record: promotion, observation, journal, ports: world.ports(calls) });
      promotion = result.record;
      world.notePromotion(promotion, result);
    }
    const mergeCalls = calls.filter(call => call === 'github.merge');
    return {
      ok: world.taskStopped && world.promotionStopped && mergeCalls.length === 0 && network.length === 0 && record?.repair_round === 1 && record?.state === 'READY_FOR_OWNER' && promotion?.state === 'READY_FOR_PROD',
      record,
      promotion,
      calls,
      network,
      taskStopped: world.taskStopped,
      promotionStopped: world.promotionStopped,
      flags: { enabled: policy.flags.AGENT_PIPELINE_ENABLED, mergeEnabled: policy.flags.AGENT_PIPELINE_MERGE_ENABLED },
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function gitJournal(dir) {
  return {
    async save(record) {
      await updateState(dir, current => {
        current.tasks[record.task_id] = record;
        current.journalEntries = [{
          schema_version: 1,
          task_id: record.task_id,
          state_revision: record.state_revision,
          operation_key: `${record.repository_id}/${record.task_id}/${record.task_revision}/${record.head_sha ?? '-'}/${record.base_sha ?? '-'}/save/${record.repair_round}`,
          before: record.state,
          after: record.state,
          at: record.last_transition_at,
          previous_hash: null,
        }];
        return current;
      });
    },
  };
}

function createWorld(policy, policySha) {
  const state = { phase: 'build', runs: [], taskStopped: false, promotionStopped: false };
  const contract = [
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
  return {
    get taskStopped() { return state.taskStopped; },
    get promotionStopped() { return state.promotionStopped; },
    observe(record) {
      return baseObservation({ policy, policySha, contract, state, record });
    },
    promotionObservation() {
      return {
        ...baseObservation({ policy, policySha, contract, state, record: null }),
        kind: 'promotion',
        simulation: true,
        promotion: {
          taskId: 'SC-DEMO-001-promotion',
          manifest: { tasks: ['SC-DEMO-001'], operations: ['merge integration to main'] },
          runbook: { steps: ['smoke'], rollback: 'revert main' },
          operations: ['merge'],
          tasks: [{ task_id: 'SC-DEMO-001', gate: 'A', request_id: 'synthetic-a' }],
          smokeTests: ['smoke'],
          rollback: 'revert',
        },
        github: {
          ...baseObservation({ policy, policySha, contract, state, record: null }).github,
          pull: {
            number: 90,
            headRef: 'integration',
            baseRef: 'main',
            headSha: H2,
            baseSha: MAIN,
            headRepositoryId: policy.repository_id,
            baseRepositoryId: policy.repository_id,
            body: 'promotion',
            merged: false,
          },
        },
      };
    },
    note(record, result) {
      for (const item of result.executed ?? []) {
        if (item.effect.type === 'cursor.create') state.runs = [{ id: 'run-1', status: 'CREATING', createdAt: '2026-10-06T12:00:00.000Z' }];
        if (item.effect.type === 'cursor.followup') state.runs.push({ id: 'run-2', status: 'CREATING', createdAt: '2026-10-06T12:20:00.000Z' });
      }
      if (record?.state === 'BUILDING' && record.cursor_run_id === 'run-1') {
        state.runs[0].status = 'FINISHED';
        state.phase = 'review-fix';
      }
      if (record?.state === 'FIXING' && record.cursor_run_id === 'run-2') {
        state.runs[1].status = 'FINISHED';
        state.phase = 'review-pass';
      }
      if (record?.state === 'READY_FOR_OWNER' && record.binding.approval?.phase === 'armed') state.taskStopped = true;
      if ((result.executed ?? []).some(item => item.effect.type === 'github.merge')) state.taskStopped = false;
    },
    notePromotion(record) {
      if (record?.state === 'READY_FOR_PROD' && record.binding.approval?.request_id && record.binding.approval.phase !== 'intent') state.promotionStopped = true;
      if (record?.state === 'BLOCKED') state.promotionStopped = false;
    },
    ports(calls) {
      return {
        async execute(effect) {
          calls.push(effect.type);
          if (effect.payload && Object.prototype.hasOwnProperty.call(effect.payload, 'envVars')) throw new Error('envVars forbidden');
          if (effect.type === 'cursor.create') return { agent: { id: effect.agentId }, run: { id: 'run-1', status: 'CREATING' } };
          if (effect.type === 'cursor.followup') return { run: { id: 'run-2', status: 'CREATING' } };
          if (effect.type === 'github.createPr') return { number: 50 };
          if (effect.type === 'github.dispatch') return { run_id: effect.workflow === 'verify' ? 100 : effect.workflow === 'review' ? (state.phase === 'review-pass' ? 202 : 201) : 300, run_attempt: 1 };
          if (effect.type === 'notify') return { ok: true };
          if (effect.type === 'github.merge') throw new Error('merge must not run in dry-run');
          throw new Error(`unexpected effect ${effect.type}`);
        },
      };
    },
  };
}

function baseObservation({ policy, policySha, contract, state, record }) {
  const head = record?.repair_round > 0 || state.phase === 'review-pass' ? H2 : H1;
  const branchSha = state.phase === 'build' && !(record?.state === 'BUILDING' && record.cursor_run_id) ? null : head;
  const showEvidence = record?.review_request_id && record.state === 'PR_REVIEW';
  const pass = state.phase === 'review-pass';
  return {
    now: pass ? '2026-10-06T12:40:00.000Z' : '2026-10-06T12:10:00.000Z',
    kind: 'task',
    simulation: true,
    flags: { enabled: false, mergeEnabled: false },
    policy,
    policySha,
    secrets: { cursor: false, openai: false, githubApp: false },
    issue: { number: 41, authorId: policy.owner.id, authorLogin: policy.owner.login, body: contract },
    github: {
      repositoryId: policy.repository_id,
      fork: false,
      integrationSha: BASE,
      mainSha: MAIN,
      branch: branchSha ? { name: 'feat/sc-demo-001-demo', sha: branchSha, repositoryId: policy.repository_id, files: ['app/demo/page.tsx'] } : null,
      pull: record?.pr_number ? {
        number: record.pr_number,
        headRef: 'feat/sc-demo-001-demo',
        baseRef: 'integration',
        headSha: branchSha,
        baseSha: BASE,
        headRepositoryId: policy.repository_id,
        baseRepositoryId: policy.repository_id,
        body: 'skillcheck-task:SC-DEMO-001',
        merged: false,
      } : null,
      pulls: [],
      protection: { exclusiveWritersConfirmed: false, mainProtected: false, integrationProtected: false, agentStateProtected: false },
      ci: showEvidence ? ciEnvelope(policy, policySha, pass ? H2 : H1) : null,
      review: showEvidence ? reviewEnvelope(policy, policySha, record, pass) : null,
    },
    cursor: state.runs.length ? { agent: { id: record?.cursor_agent_id, latestRunId: state.runs[state.runs.length - 1].id, status: 'ACTIVE' }, runs: state.runs } : null,
    approval: null,
  };
}

function ciEnvelope(policy, policySha, head) {
  return {
    workflow_id: policy.workflow_ids.verify,
    workflow_path: policy.workflows.verify,
    run_id: 100,
    run_attempt: 1,
    policy_sha: policySha,
    head_sha: head,
    base_sha: BASE,
    conclusion: 'success',
    jobs: [{ name: 'verify', conclusion: 'success' }],
    commands_executed: policy.required_ci_commands,
  };
}

function reviewEnvelope(policy, policySha, record, pass) {
  return {
    workflow_id: policy.workflow_ids.review,
    workflow_path: policy.workflows.review,
    run_id: pass ? 202 : 201,
    run_attempt: 1,
    policy_sha: policySha,
    payload: {
      schema_version: 1,
      request_id: record.review_request_id,
      repository_id: policy.repository_id,
      pr_number: record.pr_number,
      head_sha: pass ? H2 : H1,
      base_sha: BASE,
      contract_hash: record.contract_hash,
      verdict: pass ? 'PASS' : 'PASS_WITH_FIXES',
      acceptance_checks: requiredReviewChecks(record).map(id => ({ id, status: 'PASS', required: true })),
      findings: pass ? [] : [{ id: 'fix-copy', severity: 'minor', path: 'app/demo/page.tsx', line: 3, description: 'Copy is unclear', required_fix: 'Rewrite the heading' }],
      limitations: [],
    },
  };
}
