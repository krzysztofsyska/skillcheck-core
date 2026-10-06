import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCreatePayload } from '../../tools/agent-pipeline/lib/cursor.mjs';
import { evaluatePreflight } from '../../tools/agent-pipeline/lib/merge.mjs';
import { filesOutside } from '../../tools/agent-pipeline/lib/scope.mjs';
import { plan } from '../../tools/agent-pipeline/lib/transitions.mjs';
import { classify } from '../../tools/agent-pipeline/classify-pr.mjs';
import { observation, taskRecord } from './helpers.mjs';

test('forks, main as a Cursor ref, out-of-scope files, and SC-OPS-001 are rejected', () => {
  const policy = observation().policy;
  assert.throws(() => buildCreatePayload({
    repoUrl: policy.repository_url, startingRef: 'main', prompt: 'x', agentId: 'bc-1', repositoryId: policy.repository_id, expectedRepositoryId: policy.repository_id, fork: false, allowedRepoUrls: policy.allowed_repo_urls,
  }), error => error.code === 'REF_FORBIDDEN');
  assert.throws(() => buildCreatePayload({
    repoUrl: policy.repository_url, startingRef: 'feat/sc-demo-001-demo', prompt: 'x', agentId: 'bc-1', repositoryId: 1, expectedRepositoryId: policy.repository_id, fork: true, allowedRepoUrls: policy.allowed_repo_urls,
  }), error => error.code === 'FORK_REJECTED');

  const record = taskRecord({ state: 'BUILDING', technical_state: null, cursor_run_id: 'run-1', pr_number: null, head_sha: null });
  record.binding.dispatch = { phase: 'settled', action: 'create' };
  const obs = observation();
  obs.github.fork = true;
  obs.github.branch = { name: 'feat/sc-demo-001-demo', sha: 'a'.repeat(40), repositoryId: policy.repository_id, files: ['supabase/migrations/new.sql'] };
  obs.cursor = { agent: { latestRunId: 'run-1' }, runs: [{ id: 'run-1', status: 'FINISHED', createdAt: obs.now }] };
  const scoped = plan(record, obs);
  assert.equal(scoped.record.blocked_reason, 'REF_FORBIDDEN');
  assert.deepEqual(filesOutside(['supabase/migrations/new.sql'], record.binding.allowed_files), ['supabase/migrations/new.sql']);

  const gate = classify({
    files: ['.github/workflows/agent-gates.yml'],
    body: 'TASK: SC-OPS-001\nSCOPE: OPERATIONS\nLEVEL: L1\nOWNER_APPROVAL: APPROVED\nPRODUCTION_APPROVAL: APPROVED\nREVIEW_VERDICT: PASS\nPROMOTION: YES\n',
    base: 'main',
    headRef: 'integration',
  });
  assert.equal(gate.ok, false);
  assert.equal(readFileSync('.github/workflows/agent-gates.yml', 'utf8').includes('SC-OPS-001'), false);
  assert.equal(evaluatePreflight({ exclusiveWritersConfirmed: true, scOps001Exception: true, mainProtected: true, integrationProtected: true, agentStateProtected: true, qualityGatesBypass: false, administrationWriteUsed: false, requiredChecksPinnedToApp: true }).reason, 'SC_OPS_001_REJECTED');
});
