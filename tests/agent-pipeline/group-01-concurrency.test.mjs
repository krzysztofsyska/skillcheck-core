import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitProjection, initStateRepo, readProjection } from '../../tools/agent-pipeline/lib/journal.mjs';
import { plan } from '../../tools/agent-pipeline/lib/transitions.mjs';
import { observation } from './helpers.mjs';

test('two events produce one deterministic agent and a conflicting write does not replace history', async () => {
  const first = plan(null, observation());
  const second = plan(null, observation());
  assert.equal(first.record.cursor_agent_id, second.record.cursor_agent_id);
  assert.equal(first.effects.length, 0);

  const dir = mkdtempSync(join(tmpdir(), 'agent-race-'));
  initStateRepo(dir);
  const workers = [0, 1].map(id => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['tests/agent-pipeline/race-worker.mjs', dir, `event-${id}`], {
      env: { ...process.env, AGENT_STATE_RACE_DELAY_MS: '300' },
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
  }));
  await Promise.all(workers);
  const projection = readProjection(dir);
  assert.deepEqual(projection.tasks.RACE.events.sort(), ['event-0', 'event-1']);

  const head = projection.head;
  const ancestor = spawnSync('git', ['rev-parse', 'HEAD~1'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  const stale = commitProjection(dir, {
    tasks: { RACE: { ...projection.tasks.RACE, events: ['overwritten'] } },
    journalEntries: [],
    expectedHead: ancestor,
  });
  assert.equal(stale.ok, false);
  assert.equal(readProjection(dir).head, head);
  assert.equal(readFileSync(new URL('../../tools/agent-pipeline/lib/journal.mjs', import.meta.url), 'utf8').includes('update-ref --force'), false);
});
