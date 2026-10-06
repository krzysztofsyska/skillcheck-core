import { canonicalJson, sha256 } from './canonical.mjs';
import { fold, plan } from './transitions.mjs';

export async function tick({ record, observation, journal, ports }) {
  const decision = plan(record, observation);
  if (!decision.record && decision.effects.length === 0) return { ...decision, executed: [] };
  const effects = decision.effects ?? [];
  if (effects.length === 0) {
    if (decision.record && journal) await journal.save(decision.record, decision.journal, record);
    return { ...decision, executed: [] };
  }
  const guarded = guardEffects(effects, observation);
  if (guarded.suppressed.length > 0 && guarded.allowed.length === 0) {
    const next = structuredClone(record ?? decision.record);
    next.binding.suppressed.push(...guarded.suppressed.map(effect => ({ type: effect.type, reason: 'SUPPRESSED', at: observation.now })));
    if (journal) await journal.save(next, decision.journal, record);
    return { record: next, effects: [], executed: [], suppressed: guarded.suppressed };
  }
  const pre = decision.preEffectRecord ?? decision.record;
  if (journal) await journal.save(pre, decision.journal, record);
  let folded = pre;
  const executed = [];
  for (const effect of guarded.allowed) {
    try {
      const result = await ports.execute(effect);
      executed.push({ effect, result });
      folded = fold(folded, effect, result, observation);
    } catch (error) {
      if (error.code === 'LOST_RESPONSE') {
        return { record: pre, effects, executed, lost: true, error };
      }
      executed.push({ effect, error: { status: error.status ?? null, code: error.code ?? null, message: error.message } });
      folded = fold(folded, effect, { error }, observation);
    }
  }
  if (journal) await journal.save(folded, { ...decision.journal, action: 'response', response_hash: sha256(canonicalJson(executed.map(item => item.result ?? item.error))) }, pre);
  return { record: folded, effects: guarded.allowed, executed, journal: decision.journal };
}

export function guardEffects(effects, observation) {
  const allowed = [];
  const suppressed = [];
  for (const effect of effects) {
    if (!effect.external) {
      allowed.push(effect);
      continue;
    }
    if (!observation.simulation && observation.flags?.enabled !== true) {
      suppressed.push(effect);
      continue;
    }
    if (effect.type === 'github.merge' && observation.flags?.mergeEnabled !== true) {
      suppressed.push(effect);
      continue;
    }
    allowed.push(effect);
  }
  return { allowed, suppressed };
}

export function createMemoryJournal() {
  const tasks = new Map();
  const entries = [];
  return {
    entries,
    async save(record, journal) {
      const previous = entries.length ? entries[entries.length - 1].entry_hash : null;
      const entry = {
        schema_version: 1,
        task_id: record.task_id,
        state_revision: record.state_revision,
        previous_hash: previous,
        operation_key: journal?.operation_key ?? null,
        before: journal?.before ?? null,
        after: record.state,
        at: record.last_transition_at,
        effect_ids: journal?.effect_ids ?? null,
      };
      entry.entry_hash = sha256(entry);
      entries.push(entry);
      tasks.set(record.task_id, structuredClone(record));
    },
    load(taskId) {
      return tasks.has(taskId) ? structuredClone(tasks.get(taskId)) : null;
    },
  };
}
