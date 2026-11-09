// SC-021-A: OpenAI Responses API adapter (the only active provider).
import type { AdapterCall, AiProviderAdapter, GatewayRequest, ProviderReply, TokenUsage } from './contract.ts';
import { AiGatewayError } from './contract.ts';
import { postJson, record, tokenCount } from './http.ts';

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

/**
 * Builds the Responses API body. Field set and order match what `buildScreeningOpenAiRequest`
 * sends today, so routing screening through the gateway does not change the provider input.
 */
export function buildOpenAiResponsesBody(model: string, request: GatewayRequest) {
  return {
    model,
    store: false,
    ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort } } : {}),
    max_output_tokens: request.maxOutputTokens,
    input: [
      { role: request.instructionRole ?? 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
    ...(request.jsonSchema ? {
      text: { format: { type: 'json_schema', name: request.jsonSchema.name, strict: true, schema: request.jsonSchema.schema } },
    } : {}),
  };
}

function usageOf(body: Record<string, unknown>): TokenUsage | null {
  const usage = record(body.usage);
  if (!usage || !tokenCount(usage.input_tokens) || !tokenCount(usage.output_tokens)) return null;
  const details = record(usage.input_tokens_details);
  // A missing cache breakdown is unknown, not zero: report usage as unavailable.
  if (!details || !tokenCount(details.cached_tokens) || details.cached_tokens > usage.input_tokens) return null;
  return { inputTokens: usage.input_tokens, cachedInputTokens: details.cached_tokens, outputTokens: usage.output_tokens };
}

export function parseOpenAiResponse(raw: unknown): ProviderReply {
  const body = record(raw);
  if (!body) throw new AiGatewayError('invalid_response', 'maybe_billed');
  const usage = usageOf(body);
  const providerRequestId = typeof body.id === 'string' && body.id.length <= 200 ? body.id : null;
  const chunks: string[] = [];
  let refused = false;
  for (const item of Array.isArray(body.output) ? body.output : []) {
    const row = record(item);
    if (!row) continue;
    if (row.type === 'refusal') refused = true;
    for (const piece of Array.isArray(row.content) ? row.content : []) {
      const part = record(piece);
      if (!part) continue;
      if (part.type === 'refusal' || typeof part.refusal === 'string') refused = true;
      else if (part.type === 'output_text' && typeof part.text === 'string') chunks.push(part.text);
    }
  }
  const outputText = chunks.length ? chunks.join('') : null;
  const status = refused ? 'refused' : body.status === 'completed' ? 'completed' : 'incomplete';
  return { status, outputText, usage, providerRequestId };
}

export function createOpenAiAdapter(options: { apiKey: string; fetchImpl?: typeof fetch }): AiProviderAdapter {
  if (typeof options.apiKey !== 'string' || !options.apiKey.trim()) {
    throw new AiGatewayError('auth_error', 'not_billed');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    provider: 'openai',
    async invoke(call: AdapterCall) {
      let body: string;
      try {
        body = JSON.stringify(buildOpenAiResponsesBody(call.model, call.request));
      } catch {
        throw new AiGatewayError('invalid_request', 'not_billed');
      }
      const raw = await postJson(fetchImpl, OPENAI_RESPONSES_URL, {
        authorization: 'Bearer ' + options.apiKey,
        'x-client-request-id': call.attemptId,
      }, body, call.signal);
      return parseOpenAiResponse(raw);
    },
  };
}
