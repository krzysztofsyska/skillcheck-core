import {
  buildExerciseDraftRequest, ExerciseAiError, EXERCISE_AI_MAX_RESPONSE_CHARS,
  EXERCISE_AI_REQUEST_TIMEOUT_MS, EXERCISE_AI_MAX_REQUEST_BYTES, EXERCISE_AI_MAX_OUTPUT_TOKENS, mapExerciseAiHttpError,
  parseExerciseDraftResponse, type exerciseDraftPayload, type ExerciseAiResponse,
} from './exercise-ai.ts';
import { AiGatewayError, isAiGatewayEnabled } from './ai-gateway/contract.ts';
import { defaultAiPolicy } from './ai-gateway/default-policy.ts';
import { createAiGateway } from './ai-gateway/gateway.ts';
import { createLedgerHook, EXERCISE_LEDGER_ROUTE, type LedgerWriter } from './ai-gateway/ledger.ts';
import { resolveRoute } from './ai-gateway/policy.ts';
import { createOpenAiAdapter } from './ai-gateway/openai.ts';
import type { AiRoutingPolicy } from './ai-gateway/policy.ts';
import { attemptLogEntry, gatewayRequestFromResponsesBody, pinnedRouteModel } from './ai-gateway/responses-bridge.ts';

/**
 * Trusted server context for the AI gateway path (SC-021-A2), built by the server action from the
 * verified company membership — never from browser input.
 */
export type ExerciseGatewayTrust = {
  companyId: string;
  /** The generation request key, already validated as a UUID and bound to the reservation. */
  operationId: string;
  recruitmentId: string;
  /** canEdit && editable, as verified by exerciseContext. */
  mayGenerate: boolean;
  /**
   * SC-021-B: durable ledger write through the server-only ai_ledger_writer connection
   * (lib/ai-ledger-writer.ts), bound in the database to this generation reservation.
   * Required on the gateway path; without it no provider call is made.
   */
  recordAttempt: LedgerWriter | null;
};

/**
 * Exactly one attempt. A lost response may already be billed; never retry here.
 * With `trust` and AI_GATEWAY_ENABLED=true the call goes through the AI gateway; otherwise the
 * direct path below runs unchanged.
 */
export async function requestExerciseDraft(payload: ReturnType<typeof exerciseDraftPayload>, apiKey: string,
  fetcher: typeof fetch = fetch, trust?: ExerciseGatewayTrust) {
  if (trust && isAiGatewayEnabled(process.env.AI_GATEWAY_ENABLED)) {
    return requestExerciseDraftViaGateway(payload, apiKey, trust, { fetcher });
  }
  if (!apiKey) throw new ExerciseAiError('exercise_ai_auth_error', 'Missing provider configuration');
  const body = JSON.stringify(buildExerciseDraftRequest(payload));
  if (Buffer.byteLength(body, 'utf8') > EXERCISE_AI_MAX_REQUEST_BYTES)
    throw new ExerciseAiError('exercise_ai_input_too_large', 'Provider request exceeds byte limit.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXERCISE_AI_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetcher('https://api.openai.com/v1/responses', {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
    });
    if (!response.ok) throw new ExerciseAiError(mapExerciseAiHttpError(response.status), 'Provider failed');
    if (!response.body) throw new ExerciseAiError('exercise_ai_invalid_output', 'Missing response');
    const reader = response.body.getReader(); const decoder = new TextDecoder();
    let text = ''; let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > EXERCISE_AI_MAX_RESPONSE_CHARS * 4) {
          await reader.cancel(); throw new ExerciseAiError('exercise_ai_invalid_output', 'Response too large');
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new ExerciseAiError('exercise_ai_invalid_output', 'Invalid JSON'); }
    return parseExerciseDraftResponse(parsed as ExerciseAiResponse, payload);
  } catch (error) {
    if (error instanceof ExerciseAiError) throw error;
    throw new ExerciseAiError(controller.signal.aborted ? 'exercise_ai_timeout' : 'exercise_ai_network_error', 'Provider unavailable');
  } finally { clearTimeout(timer); }
}


/**
 * SC-021-B: the policy's exercise route must be exactly the entry the ledger allowlists
 * (provider, model, revision, key, policy version, attempts) and the request limits must match
 * its token bounds. Checked before any provider call.
 */
export function exerciseRouteMatchesLedger(policy: AiRoutingPolicy) {
  try {
    const { route, models } = resolveRoute(policy, 'exercise_generation');
    const [m] = models;
    return models.length === 1 && route.strategy === 'pinned'
      && m.provider === EXERCISE_LEDGER_ROUTE.provider && m.model === EXERCISE_LEDGER_ROUTE.model
      && m.revision === EXERCISE_LEDGER_ROUTE.model_revision && m.key === EXERCISE_LEDGER_ROUTE.model_key
      && policy.version === EXERCISE_LEDGER_ROUTE.policy_version && route.maxAttempts === EXERCISE_LEDGER_ROUTE.max_attempts
      && EXERCISE_AI_MAX_REQUEST_BYTES <= EXERCISE_LEDGER_ROUTE.max_input_tokens
      && EXERCISE_AI_MAX_OUTPUT_TOKENS <= EXERCISE_LEDGER_ROUTE.max_output_tokens;
  } catch {
    return false;
  }
}

/** AiGatewayError → the code the direct path produced for the same failure. */
export function exerciseErrorFromGateway(error: unknown): ExerciseAiError {
  if (error instanceof ExerciseAiError) return error;
  // The direct path reported any other failure after the request left as a network error.
  if (!(error instanceof AiGatewayError)) return new ExerciseAiError('exercise_ai_network_error', 'Provider unavailable');
  if (error.httpStatus !== undefined) return new ExerciseAiError(mapExerciseAiHttpError(error.httpStatus), 'Provider failed');
  switch (error.code) {
    // SC-021-B: the attempt could not be recorded; the draft is not returned (the call may be billed).
    case 'ledger_error': return new ExerciseAiError('exercise_ai_server_error', 'Provider unavailable');
    case 'timeout': return new ExerciseAiError('exercise_ai_timeout', 'Provider unavailable');
    case 'network_error': return new ExerciseAiError('exercise_ai_network_error', 'Provider unavailable');
    case 'invalid_response': return new ExerciseAiError('exercise_ai_invalid_output', 'Invalid response');
    case 'payload_too_large': return new ExerciseAiError('exercise_ai_input_too_large', 'Provider request exceeds byte limit.');
    // Missing key, or refused before provider I/O (authorization, policy, request shape).
    default: return new ExerciseAiError('exercise_ai_auth_error', 'Provider configuration unavailable');
  }
}

export async function requestExerciseDraftViaGateway(payload: ReturnType<typeof exerciseDraftPayload>, apiKey: string,
  trust: ExerciseGatewayTrust, options: { fetcher?: typeof fetch; policy?: AiRoutingPolicy;
    log?: (entry: ReturnType<typeof attemptLogEntry>) => void } = {}) {
  if (!apiKey) throw new ExerciseAiError('exercise_ai_auth_error', 'Missing provider configuration');
  // Fail closed before any provider call: no ledger, no billed work.
  if (typeof trust.recordAttempt !== 'function') throw new ExerciseAiError('exercise_ai_auth_error', 'AI ledger unavailable');
  const legacy = buildExerciseDraftRequest(payload);
  if (Buffer.byteLength(JSON.stringify(legacy), 'utf8') > EXERCISE_AI_MAX_REQUEST_BYTES)
    throw new ExerciseAiError('exercise_ai_input_too_large', 'Provider request exceeds byte limit.');
  const policy = options.policy ?? defaultAiPolicy;
  // The ledger accepts only its allowlisted route entry; a mismatch would be refused after a paid call.
  if (!exerciseRouteMatchesLedger(policy)) throw new ExerciseAiError('exercise_ai_auth_error', 'AI ledger route mismatch');
  const log = options.log ?? (entry => console.info(JSON.stringify(entry)));
  const ledger = createLedgerHook(trust.recordAttempt);
  let body: unknown;
  try {
    const { model, request } = gatewayRequestFromResponsesBody(legacy);
    // The draft provenance names this model; the gateway may not route anywhere else.
    if (model !== pinnedRouteModel(policy, 'exercise_generation')) throw new AiGatewayError('route_disabled');
    const gateway = createAiGateway({
      policy,
      adapters: [createOpenAiAdapter({ apiKey, fetchImpl: options.fetcher ?? fetch, maxResponseBytes: EXERCISE_AI_MAX_RESPONSE_CHARS * 4 })],
      authorize: async ctx => trust.mayGenerate === true && ctx.task === 'exercise_generation'
        && ctx.companyId === trust.companyId && ctx.operationId === trust.operationId && ctx.processId === trust.recruitmentId,
      onAttempt: async record => {
        try { log(attemptLogEntry(record)); } catch { /* a log sink failure never fails the draft */ }
        await ledger(record);
      },
    });
    body = (await gateway.runRaw({
      companyId: trust.companyId, operationId: trust.operationId, processId: trust.recruitmentId, task: 'exercise_generation',
    }, request)).providerBody;
  } catch (error) {
    throw exerciseErrorFromGateway(error);
  }
  return parseExerciseDraftResponse(body as ExerciseAiResponse, payload);
}
