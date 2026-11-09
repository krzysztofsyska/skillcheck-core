// SC-021-A2: CV screening through the AI gateway, behind AI_GATEWAY_ENABLED (default off).
// Bundled into the screening worker on Supabase Edge (Deno): relative `.ts` imports only, no Node APIs.
//
// Parity with the direct path (`callOpenAiResponses`):
// - the provider receives the same request body, byte for byte (checked on every call);
// - the gateway route makes exactly one physical attempt; runScreeningAttempt keeps its own retry
//   loop, so retry counts and backoff do not change;
// - the raw provider envelope is returned to parseScreeningOpenAiResponse, so refusals, truncation,
//   usage and evidence are parsed by the same code as before;
// - gateway errors map to the same ScreeningProviderError codes (HTTP status → mapScreeningHttpError).
import { AiGatewayError } from './ai-gateway/contract.ts';
import { defaultAiPolicy } from './ai-gateway/default-policy.ts';
import { createAiGateway } from './ai-gateway/gateway.ts';
import { createOpenAiAdapter } from './ai-gateway/openai.ts';
import type { AiRoutingPolicy } from './ai-gateway/policy.ts';
import { attemptLogEntry, gatewayRequestFromResponsesBody, pinnedRouteModel } from './ai-gateway/responses-bridge.ts';
import {
  ScreeningProviderError, mapScreeningHttpError,
  type ScreeningOpenAiResponse, type ScreeningWorkerClaim, type buildScreeningOpenAiRequest,
} from './screening-ai.ts';

export type ScreeningOpenAiRequest = ReturnType<typeof buildScreeningOpenAiRequest>;

/** AiGatewayError → the code the direct path produced for the same failure. */
export function screeningErrorFromGateway(error: unknown): ScreeningProviderError {
  if (error instanceof ScreeningProviderError) return error;
  // Anything else (attempt hook failure, unexpected bug) is not retried: the model may already have run.
  if (!(error instanceof AiGatewayError)) return new ScreeningProviderError('worker_internal_error', 'AI gateway failure.');
  if (error.httpStatus !== undefined) {
    return new ScreeningProviderError(mapScreeningHttpError(error.httpStatus), 'Provider HTTP error.', 'http_error', error.httpStatus);
  }
  switch (error.code) {
    case 'timeout': return new ScreeningProviderError('openai_timeout', 'Provider timed out.');
    case 'network_error': return new ScreeningProviderError('openai_network_error', 'Provider unavailable.');
    case 'invalid_response': return new ScreeningProviderError('openai_invalid_output', 'Response was not JSON.', 'response_not_json');
    // Missing API key: the direct path sent the request and got 401.
    case 'auth_error': return new ScreeningProviderError('openai_auth_error', 'Provider configuration unavailable.');
    // Refused before any provider I/O (context, authorization, policy, request shape). Not retryable.
    default: return new ScreeningProviderError('worker_internal_error', 'AI gateway refused the call.');
  }
}

/** The worker claim is the trusted principal: a leased attempt that passed the contract check. */
export function screeningClaimAuthorizes(claim: ScreeningWorkerClaim, operationId: string, nowMs: number) {
  const leaseUntil = Date.parse(claim.lease_expires_at);
  return typeof claim.attempt_id === 'string' && claim.attempt_id === operationId
    && typeof claim.lease_token === 'string' && claim.lease_token.length > 0
    && Number.isFinite(leaseUntil) && leaseUntil > nowMs;
}

export type ScreeningGatewayOptions = {
  apiKey: string;
  log: (entry: ReturnType<typeof attemptLogEntry>) => void;
  fetchImpl?: typeof fetch;
  policy?: AiRoutingPolicy;
  now?: () => number;
};

/**
 * Returns a drop-in for ScreeningWorkerRuntime.callOpenAi. A fresh gateway per call keeps the
 * direct path's behaviour exactly (no breaker state shared between calls or analyses).
 */
export function createScreeningGatewayCall(options: ScreeningGatewayOptions) {
  const policy = options.policy ?? defaultAiPolicy;
  const now = options.now ?? Date.now;
  return async function callScreeningViaGateway(request: ScreeningOpenAiRequest, claim: ScreeningWorkerClaim): Promise<ScreeningOpenAiResponse> {
    try {
      const { model, request: gatewayRequest } = gatewayRequestFromResponsesBody(request);
      // The analysis contract names the model; the gateway may not route anywhere else.
      if (model !== pinnedRouteModel(policy, 'cv_screening') || model !== claim.model) {
        throw new ScreeningProviderError('contract_mismatch', 'Analysis contract mismatch.', 'contract_mismatch');
      }
      const gateway = createAiGateway({
        policy,
        adapters: [createOpenAiAdapter({ apiKey: options.apiKey, fetchImpl: options.fetchImpl })],
        authorize: async ctx => ctx.task === 'cv_screening' && ctx.companyId === null
          && screeningClaimAuthorizes(claim, ctx.operationId, now()),
        onAttempt: async record => {
          try { options.log(attemptLogEntry(record)); } catch { /* a log sink failure never fails the analysis */ }
        },
        now,
      });
      // companyId: the worker claim does not carry the tenant yet; SC-021-B binds it before budgets.
      const result = await gateway.runRaw({ companyId: null, operationId: claim.attempt_id, task: 'cv_screening' }, gatewayRequest);
      return result.providerBody as ScreeningOpenAiResponse;
    } catch (error) {
      throw screeningErrorFromGateway(error);
    }
  };
}
