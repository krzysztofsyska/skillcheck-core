import type { ProviderAdapter } from './runtime.ts';
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

function responseUsage(body: unknown): TokenUsage | null {
  const usage = object(object(body)?.usage);
  if (!usage || !token(usage.input_tokens) || !token(usage.output_tokens)) return null;
  const details = object(usage.input_tokens_details);
  const cached = details?.cached_tokens ?? 0;
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
    if (rate.provider !== 'openai' || !/^[0-9a-f-]{36}$/i.test(correlationId)) {
      throw new Error('SC021_OPENAI_INVALID_ROUTE');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchImpl('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + options.apiKey,
          'content-type': 'application/json',
          'X-Client-Request-Id': correlationId,
        },
        body: JSON.stringify({
          model: rate.model, store: false, input: options.input,
          max_output_tokens: options.maxOutputTokens,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('SC021_OPENAI_PROVIDER_ERROR');
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error('SC021_OPENAI_INVALID_RESPONSE');
      }
      const obj = object(body);
      if (!obj || obj.status !== 'completed') throw new Error('SC021_OPENAI_INCOMPLETE');
      return {
        data: options.parseResult(body),
        usage: responseUsage(body),
        providerRequestId: typeof obj.id === 'string' ? obj.id : null,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
