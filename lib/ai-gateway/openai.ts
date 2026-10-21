import { ProviderPreInvocationRejection, type ProviderAdapter } from './runtime.ts';
import type { TokenUsage } from './core.ts';

type JsonObject = Record<string, unknown>;
export type OpenAiAdapterOptions<T> = {
  apiKey: string; // Trusted server-side secret; never pass into a Next.js client component.
  input: unknown; // Already redacted and allowlisted by calling task module.
  maxOutputTokens: number;
  parseResult(response: unknown): T;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : null;
}
function token(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

const revisionName = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
// Request-validation and auth failures happen before a billable generation.
// 408/5xx and transport errors stay ambiguous: the provider may already have run.
function definitiveRejection(status: number) {
  return status === 400 || status === 401 || status === 403
    || status === 404 || status === 422 || status === 429;
}

function responseUsage(body: unknown): TokenUsage | null {
  const usage = object(object(body)?.usage);
  if (!usage || !token(usage.input_tokens) || !token(usage.output_tokens)) return null;
  const details = object(usage.input_tokens_details);
  // A missing cache breakdown is not evidence that every input token was uncached.
  if (!details || !Object.hasOwn(details, 'cached_tokens')) return null;
  const cached = details.cached_tokens;
  if (!token(cached) || Number(cached) > Number(usage.input_tokens)) return null;
  return {
    inputTokens: usage.input_tokens as number,
    cachedInputTokens: cached as number,
    outputTokens: usage.output_tokens as number,
  };
}

export function createOpenAiResponsesAdapter<T>(options: OpenAiAdapterOptions<T>): ProviderAdapter<T> {
  if (typeof options.apiKey !== 'string' || !options.apiKey.trim()
    || !Number.isSafeInteger(options.maxOutputTokens)
    || options.maxOutputTokens <= 0 || options.maxOutputTokens > 16000
    || typeof options.parseResult !== 'function') {
    throw new Error('SC021_OPENAI_CONFIGURATION_MISSING');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = options.timeoutMs ?? 60000;
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 180000) {
    throw new Error('SC021_OPENAI_CONFIGURATION_INVALID');
  }
  return async (rate, correlationId) => {
    if (rate.provider !== 'openai' || !/^[0-9a-f-]{36}$/i.test(correlationId)
      || !revisionName.test(rate.revision)) {
      throw new ProviderPreInvocationRejection('SC021_OPENAI_INVALID_ROUTE');
    }
    let requestBody: string;
    try {
      requestBody = JSON.stringify({
        model: rate.model,
        store: false,
        input: options.input,
        max_output_tokens: options.maxOutputTokens,
        metadata: { model_revision: rate.revision },
      });
    } catch {
      throw new ProviderPreInvocationRejection('SC021_PROVIDER_REJECTED');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      let response: Awaited<ReturnType<typeof fetchImpl>>;
      try {
        response = await fetchImpl('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + options.apiKey,
            'content-type': 'application/json',
            'X-Client-Request-Id': correlationId,
          },
          body: requestBody,
          signal: controller.signal,
        });
      } catch {
        throw new Error('SC021_OPENAI_PROVIDER_ERROR');
      }
      if (!response.ok) {
        if (definitiveRejection(response.status)) {
          throw new ProviderPreInvocationRejection('SC021_PROVIDER_REJECTED');
        }
        throw new Error('SC021_OPENAI_PROVIDER_ERROR');
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error('SC021_OPENAI_INVALID_RESPONSE');
      }
      const obj = object(body);
      if (!obj) throw new Error('SC021_OPENAI_INVALID_RESPONSE');
      const usage = responseUsage(body);
      const providerRequestId = typeof obj.id === 'string' ? obj.id : null;
      // A completed but malformed result (or explicitly incomplete response) can
      // still incur provider charges. Return its usage to the metering boundary
      // rather than throwing away the only available settlement evidence.
      if (obj.status !== 'completed') {
        return { parseError: 'SC021_PROVIDER_OUTPUT_INVALID', usage, providerRequestId };
      }
      try {
        return { data: options.parseResult(body), usage, providerRequestId };
      } catch {
        return { parseError: 'SC021_PROVIDER_OUTPUT_INVALID', usage, providerRequestId };
      }
    } finally {
      clearTimeout(timer);
    }
  };
}
