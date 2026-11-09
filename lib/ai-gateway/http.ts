// SC-021-A: shared HTTP handling for provider adapters.
import { AiGatewayError, type AiGatewayErrorCode } from './contract.ts';

export const MAX_PROVIDER_RESPONSE_BYTES = 2_000_000;

/**
 * Status → error. 400/401/403/404/422/429 are answered before the model runs (not billed).
 * 408 and 5xx stay `maybe_billed`: the provider may have generated and charged already.
 */
export function httpStatusError(status: number): AiGatewayError {
  const notBilled: Record<number, AiGatewayErrorCode> = {
    400: 'bad_request', 422: 'bad_request', 401: 'auth_error', 403: 'auth_error',
    404: 'model_unavailable', 429: 'rate_limit',
  };
  if (notBilled[status]) return new AiGatewayError(notBilled[status], 'not_billed');
  if (status === 408) return new AiGatewayError('timeout', 'maybe_billed');
  // Any other 4xx (409, 413, 415, …) is a rejection before the model ran: not billed, not retried.
  if (status >= 400 && status < 500) return new AiGatewayError('bad_request', 'not_billed');
  return new AiGatewayError('server_error', 'maybe_billed');
}

export async function postJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>,
  body: string, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST', redirect: 'error', signal,
      headers: { ...headers, 'content-type': 'application/json' },
      body,
    });
  } catch {
    // Once a request may have left the process we cannot prove it was not executed.
    throw new AiGatewayError(signal.aborted ? 'timeout' : 'network_error', 'maybe_billed');
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* ignore */ }
    throw httpStatusError(response.status);
  }
  if (!response.body) throw new AiGatewayError('invalid_response', 'maybe_billed');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AiGatewayError('invalid_response', 'maybe_billed');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof AiGatewayError) throw error;
    throw new AiGatewayError(signal.aborted ? 'timeout' : 'network_error', 'maybe_billed');
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AiGatewayError('invalid_response', 'maybe_billed');
  }
}

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function tokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
