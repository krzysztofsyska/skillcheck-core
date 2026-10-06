import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryJournal, tick } from '../../tools/agent-pipeline/lib/controller.mjs';
import { fold, plan } from '../../tools/agent-pipeline/lib/transitions.mjs';
import { observation, taskRecord } from './helpers.mjs';

test('a lost create response resumes by read and does not allocate another agent', async () => {
  const journal = createMemoryJournal();
  const ports = { async execute() { const error = new Error('lost'); error.code = 'LOST_RESPONSE'; throw error; } };
  let record = null;
  record = (await tick({ record, observation: observation(), journal, ports })).record;
  record = (await tick({ record, observation: observation(), journal, ports })).record;
  const lost = await tick({ record, observation: observation(), journal, ports });
  assert.equal(lost.lost, true);
  const confirm = plan(lost.record, observation());
  assert.equal(confirm.effects[0].type, 'cursor.get');
  assert.equal(confirm.effects[0].agentId, lost.record.cursor_agent_id);
  assert.equal(confirm.effects.some(effect => effect.type === 'cursor.create'), false);
});

test('an ambiguous follow-up stays BLOCKED instead of posting again', () => {
  const record = taskRecord({
    state: 'FIXING',
    technical_state: 'DISPATCH_PENDING',
    cursor_agent_id: 'bc-11111111-1111-5111-8111-111111111111',
    repair_round: 1,
  });
  record.binding.known_run_ids = ['run-1'];
  record.binding.dispatch = { action: 'followup', phase: 'awaiting_confirmation', marker: 'marker-1' };
  const decision = plan(record, observation());
  assert.equal(decision.effects[0].type, 'cursor.listRuns');
  const blocked = fold(record, decision.effects[0], { runs: [{ id: 'run-2' }, { id: 'run-3' }] }, observation());
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(blocked.blocked_reason, 'DISPATCH_UNKNOWN');
  assert.equal(blocked.technical_state, 'DISPATCH_UNKNOWN');
  assert.equal(blocked.cursor_agent_id, record.cursor_agent_id);
});
