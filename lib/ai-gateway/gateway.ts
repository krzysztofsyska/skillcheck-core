// SC-021-A: the single entry point for model calls.
// Order of checks on every call: server-only → context → authorization → route → payload
// privacy → adapter allowlist → physical attempt(s). Every physical attempt is reported to
// `onAttempt` (the SC-021-B ledger hook) with its own attemptId, so retries are visible.
// No Node-only APIs (Buffer, node:crypto): the screening worker bundles this for Supabase Edge (Deno).
import { detectEmail, detectPhone } from '../cv-bulk.ts';
import { normalizeForRedaction } from '../cv-normalize.ts';
import {
  AiGatewayError, isAiTask, isActiveProvider, isTransient,
  type AiProvider, type AiProviderAdapter, type AiTask, type BillingCertainty,
  type GatewayRequest, type ProviderReply, type TokenUsage,
} from './contract.ts';
import { resolveRoute, type AiRoutingPolicy, type ResolvedModel } from './policy.ts';

/** Identity of the business operation. Built by trusted server code, never from browser JSON. */
export type AiCallContext = {
  /**
   * Tenant of the operation, from trusted server state. `null` only for `cv_screening`, whose trusted
   * principal does not carry the tenant yet: the screening worker claim (SC-021-A2). SC-021-B binds the company into
   * the claim before any per-company ledger or budget relies on it. Missing (`undefined`) is invalid.
   */
  companyId: string | null;
  /** Stable across retries of one business operation (correlation ID). */
  operationId: string;
  task: AiTask;
  processId?: string | null;
  candidatePseudonym?: string | null;
};

export type AttemptRecord = {
  attemptId: string;
  operationId: string;
  companyId: string | null;
  task: AiTask;
  policyVersion: string;
  modelKey: string;
  provider: AiProvider;
  model: string;
  revision: string | null;
  attempt: number;
  outcome: 'completed' | 'refused' | 'incomplete' | AiGatewayError['code'];
  /** `billed` once the provider answered with a result; see BillingCertainty otherwise. */
  billing: 'billed' | BillingCertainty;
  usage: TokenUsage | null;
  providerRequestId: string | null;
  latencyMs: number;
};

export type AiCallResult = {
  outputText: string;
  usage: TokenUsage | null;
  provider: AiProvider;
  model: string;
  revision: string | null;
  modelKey: string;
  policyVersion: string;
  operationId: string;
  attemptId: string;
  attempts: number;
};

/**
 * `runRaw` result: the provider answered (completed, refused or incomplete). The caller's own result
 * contract parses `providerBody` exactly as it parsed a direct provider response before the gateway.
 */
export type AiRawCallResult = Omit<AiCallResult, 'outputText'> & {
  status: 'completed' | 'refused' | 'incomplete';
  outputText: string | null;
  providerBody: unknown;
};

export type AiGatewayOptions = {
  policy: AiRoutingPolicy;
  adapters: AiProviderAdapter[];
  /** Must prove the caller may act for ctx.companyId (membership, worker claim, …). Fail closed. */
  authorize: (ctx: AiCallContext) => Promise<boolean>;
  /**
   * Ledger hook (SC-021-B). Required, so no physical attempt goes unrecorded. Awaited, bounded by
   * ATTEMPT_HOOK_TIMEOUT_MS; if it throws or times out, the call fails instead of returning unrecorded work.
   */
  onAttempt: (record: AttemptRecord) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  breaker?: { failureThreshold: number; cooldownMs: number };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PSEUDONYM = /^[A-Za-z0-9:_-]{1,80}$/;
export const ATTEMPT_HOOK_TIMEOUT_MS = 10_000;

/** Rejects when `promise` does not settle within `ms`; the timer never outlives the race. */
function withDeadline<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(onTimeout()), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

const BREAKER_CODES = new Set(['server_error', 'timeout', 'network_error', 'model_unavailable']);

function assertContext(ctx: AiCallContext) {
  // A null tenant is allowed only for the task whose trusted principal lacks it today (worker claim).
  if (!ctx || typeof ctx !== 'object'
    || (ctx.companyId === null ? ctx.task !== 'cv_screening' : !UUID.test(ctx.companyId))
    || !UUID.test(ctx.operationId)
    || !isAiTask(ctx.task)
    || (ctx.processId != null && !UUID.test(ctx.processId))
    || (ctx.candidatePseudonym != null && !PSEUDONYM.test(ctx.candidatePseudonym))) {
    throw new AiGatewayError('invalid_context');
  }
}

const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** Validates the request; returns the serialised output schema ('' without one). */
function assertRequest(request: GatewayRequest): string {
  if (!request || typeof request.system !== 'string' || typeof request.user !== 'string'
    || !request.system.trim() || !request.user.trim()
    || !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > 32_000
    || (request.instructionRole !== undefined && !['system', 'developer'].includes(request.instructionRole))
    || (request.reasoningEffort !== undefined && !['low', 'medium', 'high'].includes(request.reasoningEffort))
    || (request.jsonSchema !== undefined && (!/^[A-Za-z0-9_-]{1,64}$/.test(request.jsonSchema.name)
      || !request.jsonSchema.schema || typeof request.jsonSchema.schema !== 'object'))) {
    throw new AiGatewayError('invalid_request');
  }
  if (request.jsonSchema === undefined) return '';
  // A circular or otherwise unserialisable schema (BigInt, throwing toJSON) can never be sent.
  let schema: string | undefined;
  try { schema = JSON.stringify(request.jsonSchema.schema); } catch { throw new AiGatewayError('invalid_request'); }
  if (typeof schema !== 'string') throw new AiGatewayError('invalid_request');
  return schema;
}

/** Contact data in the outgoing payload means redaction failed upstream: stop before the provider. */
export function containsContactData(text: string) {
  const normalized = normalizeForRedaction(text);
  return detectEmail(normalized) !== null || detectPhone(normalized) !== null;
}

export function createAiGateway(options: AiGatewayOptions) {
  // Browser bundles only. Deno (Supabase Edge, the screening worker) may define `window` but is server-side.
  if (typeof window !== 'undefined' && typeof (globalThis as { Deno?: unknown }).Deno === 'undefined') {
    throw new Error('SC021_SERVER_ONLY');
  }
  if (typeof options.authorize !== 'function') throw new Error('SC021_AUTHORIZE_REQUIRED');
  if (typeof options.onAttempt !== 'function') throw new Error('SC021_ATTEMPT_HOOK_REQUIRED');
  const adapters = new Map<AiProvider, AiProviderAdapter>();
  for (const adapter of options.adapters) {
    // An adapter for an inactive provider is refused at construction, not silently ignored.
    if (!isActiveProvider(adapter.provider)) throw new AiGatewayError('provider_inactive');
    if (adapters.has(adapter.provider)) throw new Error('SC021_DUPLICATE_ADAPTER');
    adapters.set(adapter.provider, adapter);
  }
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const breakerCfg = options.breaker ?? { failureThreshold: 3, cooldownMs: 60_000 };
  const failures = new Map<string, { count: number; openUntil: number }>();

  const isAvailable = (key: string) => (failures.get(key)?.openUntil ?? 0) <= now();
  const noteFailure = (key: string) => {
    const state = failures.get(key) ?? { count: 0, openUntil: 0 };
    state.count += 1;
    if (state.count >= breakerCfg.failureThreshold) {
      state.openUntil = now() + breakerCfg.cooldownMs;
      state.count = 0;
    }
    failures.set(key, state);
  };

  const recordAttempt = (r: AttemptRecord) =>
    withDeadline(Promise.resolve().then(() => options.onAttempt(r)), ATTEMPT_HOOK_TIMEOUT_MS, () => new Error('SC021_ATTEMPT_HOOK_TIMEOUT'));

  type Answered = { reply: ProviderReply; model: ResolvedModel; attemptId: string; attempt: number };

  async function execute(ctx: AiCallContext, request: GatewayRequest): Promise<Answered> {
    assertContext(ctx);
    let allowed = false;
    try { allowed = (await options.authorize(ctx)) === true; } catch { allowed = false; }
    if (!allowed) throw new AiGatewayError('unauthorized');

    let resolved: ReturnType<typeof resolveRoute>;
    try {
      resolved = resolveRoute(options.policy, ctx.task, isAvailable);
    } catch {
      throw new AiGatewayError('route_disabled');
    }
    const { route } = resolved;
    const models: ResolvedModel[] = resolved.models.filter(m => adapters.has(m.provider));
    if (models.length === 0) throw new AiGatewayError('no_available_model');

    const schema = assertRequest(request);
    // Everything the adapter sends counts: instructions, payload and the output schema.
    if (utf8Bytes(request.system) + utf8Bytes(request.user) + utf8Bytes(schema) > route.maxInputBytes) {
      throw new AiGatewayError('payload_too_large');
    }
    if (route.blockContactData && (containsContactData(request.user) || containsContactData(request.system)
      || (schema !== '' && containsContactData(schema)))) {
      throw new AiGatewayError('payload_not_redacted');
    }

    let index = 0;
    let lastError: AiGatewayError = new AiGatewayError('no_available_model');
    for (let attempt = 1; attempt <= route.maxAttempts; attempt++) {
      const model = models[index];
      const adapter = adapters.get(model.provider)!;
      const attemptId = globalThis.crypto.randomUUID();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), route.timeoutMs);
      const started = now();
      const base = {
        attemptId, operationId: ctx.operationId, companyId: ctx.companyId, task: ctx.task,
        policyVersion: options.policy.version, modelKey: model.key, provider: model.provider,
        model: model.model, revision: model.revision, attempt,
      };
      let reply: ProviderReply;
      try {
        reply = await withDeadline(
          adapter.invoke({ model: model.model, revision: model.revision, request, attemptId, signal: controller.signal }),
          route.timeoutMs + 50,
          () => { controller.abort(); return new AiGatewayError('timeout', 'maybe_billed'); },
        );
      } catch (raw) {
        const error = raw instanceof AiGatewayError
          ? raw
          : new AiGatewayError(controller.signal.aborted ? 'timeout' : 'network_error', 'maybe_billed');
        clearTimeout(timer);
        await recordAttempt({ ...base, outcome: error.code, billing: error.billing, usage: null, providerRequestId: null, latencyMs: now() - started });
        lastError = error;
        if (BREAKER_CODES.has(error.code)) noteFailure(model.key);
        if (!isTransient(error.code)) throw error;
        if (error.billing === 'maybe_billed' && !route.retryMaybeBilled) throw error;
        // A pinned route has nowhere else to go; resending to a missing model only wastes time.
        if (error.code === 'model_unavailable' && route.strategy === 'pinned') throw error;
        if (attempt === route.maxAttempts) break;
        // Move to the next eligible model when this one is unavailable; pinned routes have one.
        if (error.code === 'model_unavailable' || !isAvailable(model.key)) {
          // The model is out (missing, or its breaker just opened): never resend to it.
          // Pinned routes and the last eligible model end here; others move to the next model.
          if (route.strategy === 'pinned' || index + 1 >= models.length) break;
          index += 1;
        } else {
          await sleep(Math.min(8_000, 500 * 2 ** (attempt - 1)));
        }
        continue;
      }
      clearTimeout(timer);
      failures.delete(model.key);
      await recordAttempt({ ...base, outcome: reply.status, billing: 'billed', usage: reply.usage, providerRequestId: reply.providerRequestId, latencyMs: now() - started });
      return { reply, model, attemptId, attempt };
    }
    throw lastError;
  }

  const meta = (ctx: AiCallContext, { reply, model, attemptId, attempt }: Answered) => ({
    usage: reply.usage, provider: model.provider, model: model.model,
    revision: model.revision, modelKey: model.key, policyVersion: options.policy.version,
    operationId: ctx.operationId, attemptId, attempts: attempt,
  });

  /** Provider-neutral call: refused and incomplete answers become errors. */
  async function run(ctx: AiCallContext, request: GatewayRequest): Promise<AiCallResult> {
    const answered = await execute(ctx, request);
    const { reply } = answered;
    if (reply.status === 'refused') throw new AiGatewayError('refusal', 'maybe_billed');
    if (reply.status !== 'completed' || reply.outputText === null) throw new AiGatewayError('incomplete', 'maybe_billed');
    return { outputText: reply.outputText, ...meta(ctx, answered) };
  }

  /**
   * Same checks, routing, retries and attempt records as `run`, but every provider answer is
   * returned with its parsed envelope, so a module whose result contract predates the gateway
   * (screening, exercise generation) keeps parsing refusals and truncation exactly as before.
   */
  async function runRaw(ctx: AiCallContext, request: GatewayRequest): Promise<AiRawCallResult> {
    const answered = await execute(ctx, request);
    const { reply } = answered;
    return { status: reply.status, outputText: reply.outputText, providerBody: reply.body, ...meta(ctx, answered) };
  }

  return { run, runRaw };
}
