import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const allowed = [
  /^tools\/agent-pipeline\//,
  /^tests\/agent-pipeline\//,
  /^\.github\/agent-pipeline\//,
  /^\.github\/workflows\/agent-reconcile\.yml$/,
  /^\.github\/workflows\/agent-verify\.yml$/,
  /^\.github\/workflows\/agent-review\.yml$/,
  /^\.github\/workflows\/agent-accept\.yml$/,
  /^\.github\/workflows\/agent-promote\.yml$/,
  /^\.github\/workflows\/agent-gates\.yml$/,
  /^\.github\/workflows\/checks\.yml$/,
  /^package\.json$/,
  /^AGENTS\.md$/,
  /^\.cursor\/rules\/skillcheck-agent-pipeline\.mdc$/,
  /^docs\/AGENT_PIPELINE\.md$/,
  /^docs\/AGENT_WORKFLOW\.md$/,
  /^docs\/sc-ops-002a-agent-orchestration\.md$/,
  /^docs\/sc-ops-002b-cursor-prompt\.md$/,
  /^docs\/sc-ops-002b-handoff\.md$/,
  /^docs\/sc-ops-002c-bootstrap-runbook\.md$/,
  /^docs\/BACKLOG\.md$/,
];

test('the branch stays inside the SC-OPS-002B allowlist', () => {
  const diff = spawnSync('git', ['diff', '--name-only', '579da382f976971392bc15239fded5417945c0f0'], { encoding: 'utf8' });
  assert.equal(diff.status, 0, diff.stderr);
  const files = diff.stdout.split('\n').filter(Boolean);
  assert.equal(files.length > 0, true);
  const outside = files.filter(file => !allowed.some(pattern => pattern.test(file)));
  assert.deepEqual(outside, []);
});
