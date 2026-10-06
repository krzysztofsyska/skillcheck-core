import { updateState } from '../../tools/agent-pipeline/lib/journal.mjs';

const [dir, id] = process.argv.slice(2);
await updateState(dir, current => {
  const task = current.tasks.RACE ?? { schema_version: 1, task_id: 'RACE', state_revision: 0, events: [], state: 'READY' };
  if (!task.events.includes(id)) {
    task.events.push(id);
    task.state_revision += 1;
  }
  current.tasks.RACE = task;
  current.journalEntries = [{
    schema_version: 1,
    task_id: 'RACE',
    state_revision: task.state_revision,
    operation_key: `1043384454/RACE/1/-/-/append/${id}`,
    before: 'READY',
    after: 'READY',
    at: '2026-10-06T12:00:00.000Z',
    previous_hash: null,
  }];
  return current;
});
console.log(id);
