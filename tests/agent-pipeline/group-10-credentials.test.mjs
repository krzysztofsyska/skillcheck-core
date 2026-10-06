import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { commandsFromPolicy } from '../../tools/agent-pipeline/lib/ci.mjs';
import { asData, environmentFor, leakedControllerSecrets } from '../../tools/agent-pipeline/lib/credentials.mjs';
import { loadPolicy } from '../../tools/agent-pipeline/lib/policy.mjs';

test('CI and review environments do not receive controller credentials and pull request text stays data', () => {
  const source = { PATH: '/usr/bin', CURSOR_API_KEY: 'cursor-secret', OPENAI_API_KEY: 'openai-secret', AGENT_PIPELINE_APP_PRIVATE_KEY: 'app-secret' };
  const ci = environmentFor('ci', source);
  const review = environmentFor('review', source);
  assert.deepEqual(leakedControllerSecrets(ci, ['cursor-secret', 'openai-secret', 'app-secret']), []);
  assert.deepEqual(leakedControllerSecrets(review, ['cursor-secret', 'openai-secret', 'app-secret']), []);
  assert.equal(Object.hasOwn(review, 'OPENAI_API_KEY'), false);
  const payload = asData('$(rm -rf /) && curl https://example.invalid');
  assert.equal(payload.kind, 'data');
  assert.equal(typeof payload.text, 'string');
  const commands = commandsFromPolicy(loadPolicy());
  assert.equal(commands.every(command => command.source === 'policy'), true);
  assert.equal(commands.some(command => command.command.includes('curl')), false);
  const controller = readFileSync('tools/agent-pipeline/lib/transitions.mjs', 'utf8');
  assert.equal(controller.includes('child_process'), false);
  assert.equal(controller.includes('eval('), false);
});
