// SC-021-A: provider-neutral contract of the AI gateway.
// Server-only. Nothing here reads secrets; keys are passed in by trusted server code.

/** Business tasks that may call a model. A new task needs a code change and review. */
export const AI_TASKS = [
  'cv_screening',
  'exercise_generation',
  'competency_test_generation',
  'interview_plan',
  'report_summary',
] as const;
export type AiTask = typeof AI_TASKS[number];

/** Providers SkillCheck has an adapter for. Having an adapter does not make a provider usable. */
export const AI_PROVIDERS = ['openai', 'anthropic'] as const;
export type AiProvider = typeof AI_PROVIDERS[number];

/**
 * Providers allowed to receive real traffic (owner decision 2026-11-09: OpenAI only).
 * This is a code constant on purpose: activating another provider is a reviewed code change
 * plus an owner decision (new costs, new data processor), never a configuration or env switch.
 */
export const ACTIVE_AI_PROVIDERS: readonly AiProvider[] = Object.freeze(['openai'] as const);

export const QUALITY_TIERS = ['standard', 'high'] as const;
export type QualityTier = typeof QUALITY_TIERS[number];

export type TokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

/** One provider-neutral request. `user` is the already redacted, allowlisted payload. */
export type GatewayRequest = {
  system: string;
  user: string;
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  maxOutputTokens: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
};

/** What an adapter is asked to run: the request plus the resolved model. */
export type AdapterCall = {
  model: string;
  revision: string | null;
  request: GatewayRequest;
  attemptId: string;
  signal: AbortSignal;
};

export type ProviderReply = {
  status: 'completed' | 'incomplete' | 'refused';
  outputText: string | null;
  usage: TokenUsage | null;
  providerRequestId: string | null;
};

export type AiProviderAdapter = {
  provider: AiProvider;
  invoke(call: AdapterCall): Promise<ProviderReply>;
};

/**
 * `not_billed`: the provider refused before running the model (auth, bad request, rate limit).
 * `maybe_billed`: transport error, timeout or 5xx — the model may have run and may be charged.
 */
export type BillingCertainty = 'not_billed' | 'maybe_billed';

export const AI_GATEWAY_ERROR_CODES = [
  'invalid_context', 'unauthorized', 'unknown_task', 'route_disabled', 'no_available_model',
  'provider_inactive', 'payload_not_redacted', 'payload_too_large', 'invalid_request',
  'bad_request', 'auth_error', 'rate_limit', 'model_unavailable', 'server_error',
  'timeout', 'network_error', 'invalid_response', 'refusal', 'incomplete',
] as const;
export type AiGatewayErrorCode = typeof AI_GATEWAY_ERROR_CODES[number];

export class AiGatewayError extends Error {
  readonly code: AiGatewayErrorCode;
  readonly billing: BillingCertainty;
  constructor(code: AiGatewayErrorCode, billing: BillingCertainty = 'not_billed') {
    // The message is the code only: never echo provider bodies, prompts or CV text.
    super(code);
    this.name = 'AiGatewayError';
    this.code = code;
    this.billing = billing;
  }
}

/** Errors worth another attempt. Others (auth, bad request, refusal) fail the same way again. */
export function isTransient(code: AiGatewayErrorCode) {
  return code === 'rate_limit' || code === 'server_error' || code === 'timeout'
    || code === 'network_error' || code === 'model_unavailable';
}

export function isAiTask(value: unknown): value is AiTask {
  return typeof value === 'string' && (AI_TASKS as readonly string[]).includes(value);
}
export function isAiProvider(value: unknown): value is AiProvider {
  return typeof value === 'string' && (AI_PROVIDERS as readonly string[]).includes(value);
}
export function isActiveProvider(provider: AiProvider) {
  return ACTIVE_AI_PROVIDERS.includes(provider);
}
