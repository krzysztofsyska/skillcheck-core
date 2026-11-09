// SC-021-A: versioned routing policy. Pure functions, no I/O.
// A policy is trusted server-side configuration; it is validated in full before use and an
// invalid policy fails closed (no route), never falls back to a guess.
import {
  AI_TASKS, QUALITY_TIERS, isAiProvider, isAiTask, isActiveProvider,
  type AiProvider, type AiTask, type QualityTier,
} from './contract.ts';

export type ModelEntry = {
  provider: AiProvider;
  model: string;
  revision: string | null;
  quality: QualityTier;
  /** Relative cost, lower is cheaper. Real prices are versioned in SC-021-B, not here. */
  costRank: number;
  enabled: boolean;
};

export type RouteStrategy = 'pinned' | 'cheapest' | 'best_quality';

export type TaskRoute = {
  /** pinned = exactly the first candidate, no fallback (the task's result contract names the model). */
  strategy: RouteStrategy;
  candidates: string[];
  minQuality: QualityTier;
  timeoutMs: number;
  maxAttempts: number;
  /** Retry after a timeout / 5xx / network error, when the model may already have been billed. */
  retryMaybeBilled: boolean;
  /** Reject a payload that still contains an e-mail or phone number. */
  blockContactData: boolean;
  maxInputBytes: number;
};

export type AiRoutingPolicy = {
  version: string;
  models: Record<string, ModelEntry>;
  routes: Partial<Record<AiTask, TaskRoute>>;
};

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const STRATEGIES: readonly RouteStrategy[] = ['pinned', 'cheapest', 'best_quality'];
const qualityRank = (tier: QualityTier) => QUALITY_TIERS.indexOf(tier);

function invalid(): never {
  throw new Error('SC021_INVALID_POLICY');
}
function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const present = Object.keys(value);
  if (present.some(key => !keys.includes(key)) || keys.some(key => !present.includes(key))) invalid();
}
function int(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid();
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid();
  return value;
}

export function validatePolicy(raw: unknown): AiRoutingPolicy {
  const root = obj(raw);
  exactKeys(root, ['version', 'models', 'routes']);
  if (typeof root.version !== 'string' || !NAME.test(root.version)) invalid();

  const models: Record<string, ModelEntry> = Object.create(null);
  const rawModels = obj(root.models);
  for (const [key, value] of Object.entries(rawModels)) {
    if (!NAME.test(key)) invalid();
    const m = obj(value);
    exactKeys(m, ['provider', 'model', 'revision', 'quality', 'costRank', 'enabled']);
    if (!isAiProvider(m.provider)) invalid();
    if (typeof m.model !== 'string' || !NAME.test(m.model)) invalid();
    if (m.revision !== null && (typeof m.revision !== 'string' || !NAME.test(m.revision))) invalid();
    if (!(QUALITY_TIERS as readonly unknown[]).includes(m.quality)) invalid();
    models[key] = {
      provider: m.provider, model: m.model, revision: m.revision as string | null,
      quality: m.quality as QualityTier, costRank: int(m.costRank, 0, 1_000_000), enabled: bool(m.enabled),
    };
  }
  if (Object.keys(models).length === 0) invalid();

  const routes: Partial<Record<AiTask, TaskRoute>> = {};
  for (const [task, value] of Object.entries(obj(root.routes))) {
    if (!isAiTask(task)) invalid();
    const r = obj(value);
    exactKeys(r, ['strategy', 'candidates', 'minQuality', 'timeoutMs', 'maxAttempts',
      'retryMaybeBilled', 'blockContactData', 'maxInputBytes']);
    if (!STRATEGIES.includes(r.strategy as RouteStrategy)) invalid();
    if (!Array.isArray(r.candidates) || r.candidates.length === 0 || r.candidates.length > 8) invalid();
    const candidates = r.candidates.map(c => {
      if (typeof c !== 'string' || !Object.hasOwn(models, c)) invalid();
      return c;
    });
    if (new Set(candidates).size !== candidates.length) invalid();
    if (r.strategy === 'pinned' && candidates.length !== 1) invalid();
    if (!(QUALITY_TIERS as readonly unknown[]).includes(r.minQuality)) invalid();
    routes[task] = {
      strategy: r.strategy as RouteStrategy,
      candidates,
      minQuality: r.minQuality as QualityTier,
      timeoutMs: int(r.timeoutMs, 1_000, 180_000),
      maxAttempts: int(r.maxAttempts, 1, 4),
      retryMaybeBilled: bool(r.retryMaybeBilled),
      blockContactData: bool(r.blockContactData),
      maxInputBytes: int(r.maxInputBytes, 1, 2_000_000),
    };
  }
  for (const m of Object.values(models)) Object.freeze(m);
  for (const r of Object.values(routes)) { Object.freeze(r!.candidates); Object.freeze(r); }
  return Object.freeze({ version: root.version, models: Object.freeze(models), routes: Object.freeze(routes) });
}

export type ResolvedModel = ModelEntry & { key: string };

/**
 * Ordered list of models the task may use right now.
 * Filters: enabled in policy, provider on the code allowlist, quality floor, availability.
 * The result is empty rather than reaching outside those filters.
 */
export function resolveRoute(policy: AiRoutingPolicy, task: AiTask,
  isAvailable: (key: string) => boolean = () => true): { route: TaskRoute; models: ResolvedModel[] } {
  if (!isAiTask(task) || !(AI_TASKS as readonly string[]).includes(task)) throw new Error('SC021_UNKNOWN_TASK');
  const route = policy.routes[task];
  if (!route) throw new Error('SC021_ROUTE_DISABLED');
  const eligible = route.candidates
    .map(key => ({ key, ...policy.models[key] }))
    .filter(m => m.enabled && isActiveProvider(m.provider)
      && qualityRank(m.quality) >= qualityRank(route.minQuality));
  if (route.strategy === 'cheapest') {
    // Stable: equal cost keeps the policy order.
    eligible.sort((a, b) => a.costRank - b.costRank);
  } else if (route.strategy === 'best_quality') {
    eligible.sort((a, b) => (qualityRank(b.quality) - qualityRank(a.quality)) || (a.costRank - b.costRank));
  }
  return { route, models: eligible.filter(m => isAvailable(m.key)) };
}
