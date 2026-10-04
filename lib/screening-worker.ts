import {
  SCREENING_OPENAI_MAX_RETRIES,
  ScreeningProviderError,
  type ScreeningProviderErrorCode,
  type ScreeningWorkerClaim,
  buildScreeningOpenAiRequest,
  isRetryableScreeningError,
  isScreeningAiEnabled,
  mapScreeningHttpError,
  mapScreeningThrownError,
  parseScreeningOpenAiResponse,
  sanitizeScreeningError,
  type ScreeningOpenAiResponse,
} from './screening-ai.ts';

export type ScreeningWorkerLog = {
  attempt_id: string;
  analysis_id?: string;
  status: string;
  error_code?: string;
  provider_response_id?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  duration_ms?: number;
};

export type ScreeningWorkerStore = {
  claim(attemptId: string): Promise<ScreeningWorkerClaim | null>;
  complete(input: {
    attemptId: string;
    leaseToken: string;
    inputFingerprint: string;
    analysisContractHash: string;
    findings: ReturnType<typeof parseScreeningOpenAiResponse>['findings'];
    providerRequestId: string | null;
    providerResponseId: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
  }): Promise<string>;
  fail(input: {
    attemptId: string;
    leaseToken: string;
    inputFingerprint: string;
    analysisContractHash: string;
    errorCode: ScreeningProviderErrorCode;
    errorMessage: string;
    providerRequestId?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cachedInputTokens?: number | null;
  }): Promise<string | null>;
};

export type ScreeningWorkerRuntime = {
  enabled: boolean;
  store: ScreeningWorkerStore;
  callOpenAi(request: ReturnType<typeof buildScreeningOpenAiRequest>): Promise<ScreeningOpenAiResponse>;
  sleep(ms: number): Promise<void>;
  log(entry: ScreeningWorkerLog): void;
  now?: () => number;
};

function backoffMs(attempt: number) {
  return 250 * (3 ** attempt);
}

export async function callOpenAiResponses(
  apiKey: string,
  request: ReturnType<typeof buildScreeningOpenAiRequest>,
  fetchImpl: typeof fetch = fetch,
): Promise<ScreeningOpenAiResponse> {
  const response = await fetchImpl('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new ScreeningProviderError(mapScreeningHttpError(response.status), 'Provider HTTP error.');
  }
  return await response.json() as ScreeningOpenAiResponse;
}

export async function runScreeningAttempt(attemptId: string, runtime: ScreeningWorkerRuntime) {
  const started = runtime.now?.() ?? Date.now();
  if (!runtime.enabled) {
    runtime.log({ attempt_id: attemptId, status: 'disabled' });
    return { status: 'disabled' as const };
  }

  let claim: ScreeningWorkerClaim | null = null;
  try {
    claim = await runtime.store.claim(attemptId);
  } catch (error) {
    const code = mapScreeningThrownError(error);
    if (code === 'worker_internal_error' && /not claimable|55000/i.test(error instanceof Error ? error.message : '')) {
      runtime.log({ attempt_id: attemptId, status: 'duplicate' });
      return { status: 'duplicate' as const };
    }
    runtime.log({ attempt_id: attemptId, status: 'claim_failed', error_code: code });
    return { status: 'claim_failed' as const, code };
  }
  if (!claim) {
    runtime.log({ attempt_id: attemptId, status: 'abandoned' });
    return { status: 'abandoned' as const };
  }

  const request = buildScreeningOpenAiRequest(claim);
  let lastCode: ScreeningProviderErrorCode = 'worker_internal_error';
  for (let attempt = 0; attempt <= SCREENING_OPENAI_MAX_RETRIES; attempt += 1) {
    try {
      const response = await runtime.callOpenAi(request);
      const parsed = parseScreeningOpenAiResponse(response, claim);
      await runtime.store.complete({
        attemptId: claim.attempt_id,
        leaseToken: claim.lease_token,
        inputFingerprint: claim.input_fingerprint,
        analysisContractHash: claim.analysis_contract_hash,
        findings: parsed.findings,
        providerRequestId: parsed.provider_request_id,
        providerResponseId: parsed.provider_response_id,
        inputTokens: parsed.input_tokens,
        outputTokens: parsed.output_tokens,
        cachedInputTokens: parsed.cached_input_tokens,
      });
      runtime.log({
        attempt_id: claim.attempt_id,
        analysis_id: claim.analysis_id,
        status: 'completed',
        provider_response_id: parsed.provider_response_id,
        input_tokens: parsed.input_tokens,
        output_tokens: parsed.output_tokens,
        duration_ms: (runtime.now?.() ?? Date.now()) - started,
      });
      return { status: 'completed' as const, analysis_id: claim.analysis_id };
    } catch (error) {
      lastCode = mapScreeningThrownError(error);
      if (isRetryableScreeningError(lastCode) && attempt < SCREENING_OPENAI_MAX_RETRIES) {
        await runtime.sleep(backoffMs(attempt));
        continue;
      }
      try {
        await runtime.store.fail({
          attemptId: claim.attempt_id,
          leaseToken: claim.lease_token,
          inputFingerprint: claim.input_fingerprint,
          analysisContractHash: claim.analysis_contract_hash,
          errorCode: lastCode,
          errorMessage: sanitizeScreeningError(lastCode),
        });
      } catch {
        lastCode = 'worker_internal_error';
      }
      runtime.log({
        attempt_id: claim.attempt_id,
        analysis_id: claim.analysis_id,
        status: 'failed',
        error_code: lastCode,
        duration_ms: (runtime.now?.() ?? Date.now()) - started,
      });
      return { status: 'failed' as const, code: lastCode };
    }
  }
  return { status: 'failed' as const, code: lastCode };
}

export function screeningAiEnabledFromEnv(env: Record<string, string | undefined> | { get(name: string): string | undefined }) {
  const value = typeof (env as { get?: (name: string) => string | undefined }).get === 'function'
    ? (env as { get(name: string): string | undefined }).get('SCREENING_AI_ENABLED')
    : (env as Record<string, string | undefined>).SCREENING_AI_ENABLED;
  return isScreeningAiEnabled(value);
}
