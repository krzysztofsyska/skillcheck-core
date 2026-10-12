// SC-021: pure, provider-neutral routing, price accounting and package economics.
// Configuration and rates are trusted server-side inputs, never client-supplied.
export const AI_TASKS = [
  'cv_screening', 'interview_plan', 'voice_analysis', 'competency_test', 'assessment_case',
] as const;
export type AiTask = typeof AI_TASKS[number];
export type ModelRate = {
  provider: 'openai';
  model: string;
  revision: string;
  priceVersion: string;
  // Integer USD micro-units per 1,000,000 tokens; never floating-point USD.
  inputMicroUsdPerMillion: number;
  cachedInputMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
};
export type AiRoutingPolicy = {
  version: string;
  tasks: Partial<Record<AiTask, string>>;
  models: Record<string, ModelRate>;
};
export type TokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};
export type PackageFinancials = {
  revenueNetPlnGrosze: number;
  aiCostPlnGrosze: number | null;
  voiceAndTelephonyPlnGrosze: number | null;
  otherVariablePlnGrosze: number | null;
};

function nonNegativeSafe(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function positiveName(value: unknown, max = 128): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) && value.length <= max;
}
function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('SC021_INVALID_CONFIGURATION');
  }
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error('SC021_INVALID_CONFIGURATION');
  }
}

export function validatePolicy(raw: unknown): AiRoutingPolicy {
  const obj = asObject(raw);
  exactKeys(obj, ['version', 'tasks', 'models']);
  if (!positiveName(obj.version, 80)) throw new Error('SC021_INVALID_CONFIGURATION');
  const taskObj = asObject(obj.tasks);
  const modelObj = asObject(obj.models);
  if (Object.keys(taskObj).length === 0 || Object.keys(modelObj).length === 0) {
    throw new Error('SC021_INVALID_CONFIGURATION');
  }
  const tasks: Partial<Record<AiTask, string>> = {};
  const models: Record<string, ModelRate> = Object.create(null);
  for (const [task, modelKey] of Object.entries(taskObj)) {
    if (!AI_TASKS.includes(task as AiTask) || !positiveName(modelKey)) {
      throw new Error('SC021_INVALID_CONFIGURATION');
    }
    tasks[task as AiTask] = modelKey;
  }
  for (const [key, rawRate] of Object.entries(modelObj)) {
    if (!positiveName(key)) throw new Error('SC021_INVALID_CONFIGURATION');
    const rate = asObject(rawRate);
    exactKeys(rate, [
      'provider', 'model', 'revision', 'priceVersion',
      'inputMicroUsdPerMillion', 'cachedInputMicroUsdPerMillion',
      'outputMicroUsdPerMillion',
    ]);
    if (rate.provider !== 'openai' || !positiveName(rate.model)
      || !positiveName(rate.revision) || !positiveName(rate.priceVersion)
      || !nonNegativeSafe(rate.inputMicroUsdPerMillion)
      || !nonNegativeSafe(rate.cachedInputMicroUsdPerMillion)
      || !nonNegativeSafe(rate.outputMicroUsdPerMillion)
      || rate.cachedInputMicroUsdPerMillion > rate.inputMicroUsdPerMillion) {
      throw new Error('SC021_INVALID_CONFIGURATION');
    }
    models[key] = rate as unknown as ModelRate;
  }
  for (const key of Object.values(tasks)) {
    if (!Object.hasOwn(models, key)) throw new Error('SC021_UNKNOWN_MODEL');
  }
  return { version: obj.version, tasks, models };
}

export function selectModel(policy: AiRoutingPolicy, task: AiTask): ModelRate {
  if (!AI_TASKS.includes(task)) throw new Error('SC021_UNKNOWN_TASK');
  const key = policy.tasks[task];
  if (!key || !Object.hasOwn(policy.models, key)) throw new Error('SC021_ROUTE_DISABLED');
  return policy.models[key];
}

function ceilDiv(value: bigint, divisor: bigint) {
  return (value + divisor - BigInt(1)) / divisor;
}
export function usageCostMicroUsd(rate: ModelRate, usage: TokenUsage): number {
  if (![usage.inputTokens, usage.cachedInputTokens, usage.outputTokens].every(nonNegativeSafe)
      || usage.cachedInputTokens > usage.inputTokens) {
    throw new Error('SC021_INVALID_USAGE');
  }
  const uncached = BigInt(usage.inputTokens - usage.cachedInputTokens);
  const total = uncached * BigInt(rate.inputMicroUsdPerMillion)
    + BigInt(usage.cachedInputTokens) * BigInt(rate.cachedInputMicroUsdPerMillion)
    + BigInt(usage.outputTokens) * BigInt(rate.outputMicroUsdPerMillion);
  const microUsd = ceilDiv(total, BigInt(1000000));
  if (microUsd > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('SC021_COST_OVERFLOW');
  return Number(microUsd);
}

export function usdMicroToPlnGrosze(usdMicro: number, plnGroszePerUsd: number): number {
  if (!nonNegativeSafe(usdMicro) || !nonNegativeSafe(plnGroszePerUsd)) {
    throw new Error('SC021_INVALID_FX');
  }
  const total = ceilDiv(BigInt(usdMicro) * BigInt(plnGroszePerUsd), BigInt(1000000));
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('SC021_COST_OVERFLOW');
  return Number(total);
}

export function packageMargin(financials: PackageFinancials) {
  const { revenueNetPlnGrosze, aiCostPlnGrosze, voiceAndTelephonyPlnGrosze, otherVariablePlnGrosze } = financials;
  if (![revenueNetPlnGrosze, aiCostPlnGrosze, voiceAndTelephonyPlnGrosze, otherVariablePlnGrosze]
    .every(value => value === null || nonNegativeSafe(value)) || revenueNetPlnGrosze === null) {
    throw new Error('SC021_INVALID_FINANCIALS');
  }
  // Unknown provider FX, invoice or external cost must remain unknown, never zero.
  if (aiCostPlnGrosze === null || voiceAndTelephonyPlnGrosze === null || otherVariablePlnGrosze === null) {
    return { known: false as const, marginPlnGrosze: null, marginPercent: null };
  }
  const margin = revenueNetPlnGrosze - aiCostPlnGrosze
    - voiceAndTelephonyPlnGrosze - otherVariablePlnGrosze;
  return {
    known: true as const,
    marginPlnGrosze: margin,
    marginPercent: revenueNetPlnGrosze > 0
      ? Math.round((margin / revenueNetPlnGrosze) * 10_000) / 100 : null,
  };
}
