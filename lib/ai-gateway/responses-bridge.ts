// SC-021-A2: bridge between modules that already build an OpenAI Responses API body (screening,
// exercise generation) and the provider-neutral gateway. No Node-only APIs: the screening worker
// bundles this for Supabase Edge (Deno).
import { AiGatewayError, type AiTask, type GatewayRequest } from './contract.ts';
import type { AttemptRecord } from './gateway.ts';
import { buildOpenAiResponsesBody } from './openai.ts';
import { resolveRoute, type AiRoutingPolicy } from './policy.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Turns a module's existing Responses API body into a gateway request, and proves the adapter will
 * send exactly that body: the round trip through `buildOpenAiResponsesBody` must serialise to the
 * same bytes, or the call is refused before any provider I/O (`invalid_request`).
 */
export function gatewayRequestFromResponsesBody(body: unknown): { model: string; request: GatewayRequest } {
  const fail = () => new AiGatewayError('invalid_request');
  if (!isRecord(body) || typeof body.model !== 'string' || !Array.isArray(body.input) || body.input.length !== 2) throw fail();
  const [instructions, payload] = body.input as unknown[];
  const format = isRecord(body.text) && isRecord(body.text.format) ? body.text.format : null;
  const reasoning = isRecord(body.reasoning) ? body.reasoning : null;
  if (!isRecord(instructions) || !isRecord(payload) || payload.role !== 'user'
    || (instructions.role !== 'system' && instructions.role !== 'developer')
    || typeof instructions.content !== 'string' || typeof payload.content !== 'string'
    || typeof body.max_output_tokens !== 'number'
    || (body.reasoning !== undefined && (!reasoning || !['low', 'medium', 'high'].includes(reasoning.effort as string)))
    || (body.text !== undefined && (!format || typeof format.name !== 'string' || !isRecord(format.schema)))) {
    throw fail();
  }
  const request: GatewayRequest = {
    system: instructions.content,
    user: payload.content,
    maxOutputTokens: body.max_output_tokens,
    instructionRole: instructions.role,
    ...(reasoning ? { reasoningEffort: reasoning.effort as 'low' | 'medium' | 'high' } : {}),
    ...(format ? { jsonSchema: { name: format.name as string, schema: format.schema as Record<string, unknown> } } : {}),
  };
  let same = false;
  try {
    same = JSON.stringify(buildOpenAiResponsesBody(body.model, request)) === JSON.stringify(body);
  } catch {
    same = false;
  }
  if (!same) throw fail();
  return { model: body.model, request };
}

/**
 * The model a pinned route will call. A module whose result contract names a model may only go
 * through the gateway when the policy routes to that same model; otherwise null.
 */
export function pinnedRouteModel(policy: AiRoutingPolicy, task: AiTask): string | null {
  try {
    const { route, models } = resolveRoute(policy, task);
    return route.strategy === 'pinned' && models.length === 1 ? models[0].model : null;
  } catch {
    return null;
  }
}

/** Minimal structured log line for one physical attempt (SC-021-A2; the ledger is SC-021-B). */
export function attemptLogEntry(record: AttemptRecord) {
  return {
    event: 'ai_gateway_attempt',
    task: record.task,
    company_id: record.companyId,
    operation_id: record.operationId,
    attempt_id: record.attemptId,
    attempt: record.attempt,
    policy_version: record.policyVersion,
    model_key: record.modelKey,
    provider: record.provider,
    model: record.model,
    outcome: record.outcome,
    billing: record.billing,
    latency_ms: record.latencyMs,
    input_tokens: record.usage?.inputTokens ?? null,
    cached_input_tokens: record.usage?.cachedInputTokens ?? null,
    output_tokens: record.usage?.outputTokens ?? null,
    provider_request_id: record.providerRequestId,
  };
}
