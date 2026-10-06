import { sha256, canonicalJson } from './canonical.mjs';

const conflict = () => Object.assign(new Error('AGENT_STATE_CONFLICT'), { code: 'AGENT_STATE_CONFLICT' });
// Same CAS path is used by the production adapter and the two-process tests.
export function createLiveJournal(github, holder, runId) {
  async function commit(snapshot, changes, entry = null) {
    const result = await github.commitProjection({ ...snapshot, ...changes, expectedHead: snapshot.head,
      previousHash: snapshot.index?.journal_hash ?? null,
      journalEntries: entry ? [entry] : [], message: entry ? `agent-state ${entry.task_id} ${entry.after}` : 'agent-state controller lock' });
    if (!result.ok) throw conflict(); // caller reloads AND replans; never retry a stale record
    return result;
  }
  async function owned() {
    const snapshot = await github.readProjection();
    if (snapshot.mergeLock?.holder !== holder) throw conflict();
    return snapshot;
  }
  return {
    holder,
    async acquire() {
      const snapshot = await github.readProjection();
      const old = snapshot.mergeLock;
      if (old) {
        // Never expire a lock by wall clock. A stalled process may still mutate.
        if (!old.run_id || old.run_id === runId) throw Object.assign(new Error('CONTROLLER_LOCKED'), { code: 'CONTROLLER_LOCKED' });
        const run = await github.readRun(old.run_id);
        if (run.status !== 'completed') throw Object.assign(new Error('CONTROLLER_LOCKED'), { code: 'CONTROLLER_LOCKED' });
      }
      await commit(snapshot, { mergeLock: { holder, run_id: runId, acquired_at: new Date().toISOString() } });
    },
    async release() {
      const snapshot = await owned();
      await commit(snapshot, { mergeLock: null });
    },
    assertOwned: owned,
    async save(record, journal, expected = null) {
      const snapshot = await owned();
      const current = snapshot.tasks[record.task_id] ?? null;
      if (canonicalJson(current) !== canonicalJson(expected)) throw conflict();
      if (canonicalJson(current) === canonicalJson(record)) return;
      const entry = { schema_version: 1, task_id: record.task_id, state_revision: record.state_revision,
        previous_hash: snapshot.index?.journal_hash ?? null, operation_key: journal?.operation_key ?? null,
        before: current?.state ?? null, after: record.state, at: record.last_transition_at,
        before_hash: sha256(current), after_hash: sha256(record), effect_ids: journal?.effect_ids ?? null,
        response_hash: journal?.response_hash ?? null };
      entry.entry_hash = sha256(entry);
      await commit(snapshot, { tasks: { ...snapshot.tasks, [record.task_id]: record } }, entry);
    },
  };
}
