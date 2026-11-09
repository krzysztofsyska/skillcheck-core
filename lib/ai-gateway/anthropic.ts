// SC-021-A: Anthropic Messages API adapter — INACTIVE.
// 'anthropic' is not on ACTIVE_AI_PROVIDERS, so the gateway never routes to it and refuses to
// register it as a live adapter. It is exercised only by synthetic tests with a fake fetch.
// Activating it needs an owner decision (new costs, new data processor, DPA) and a code change.
import type { AdapterCall, AiProviderAdapter, GatewayRequest, ProviderReply } from './contract.ts';
import { AiGatewayError } from './contract.ts';
import { postJson, record, tokenCount } from './http.ts';

export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

export function buildAnthropicMessagesBody(model: string, request: GatewayRequest) {
  const system = request.jsonSchema
    ? request.system + '\nReturn only JSON matching this schema: ' + JSON.stringify(request.jsonSchema.schema)
    : request.system;
  return {
    model,
    max_tokens: request.maxOutputTokens,
    system,
    messages: [{ role: 'user', content: request.user }],
  };
}

export function parseAnthropicResponse(raw: unknown): ProviderReply {
  const body = record(raw);
  if (!body) throw new AiGatewayError('invalid_response', 'maybe_billed');
  const u = record(body.usage);
  const cacheWrite = u && tokenCount(u.cache_creation_input_tokens) ? u.cache_creation_input_tokens : 0;
  const usage = u && tokenCount(u.input_tokens) && tokenCount(u.output_tokens)
    ? {
      // Cache writes are billed input; cache reads are the cached (cheaper) part.
      inputTokens: u.input_tokens + cacheWrite + (tokenCount(u.cache_read_input_tokens) ? u.cache_read_input_tokens : 0),
      cachedInputTokens: tokenCount(u.cache_read_input_tokens) ? u.cache_read_input_tokens : 0,
      outputTokens: u.output_tokens,
    }
    : null;
  const text = (Array.isArray(body.content) ? body.content : [])
    .map(record).filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p!.text as string).join('');
  const status = body.stop_reason === 'refusal' ? 'refused'
    : body.stop_reason === 'end_turn' && text ? 'completed' : 'incomplete';
  return {
    status, outputText: text || null, usage,
    providerRequestId: typeof body.id === 'string' && body.id.length <= 200 ? body.id : null,
  };
}

export function createAnthropicAdapter(options: { apiKey: string; fetchImpl?: typeof fetch }): AiProviderAdapter {
  if (typeof options.apiKey !== 'string' || !options.apiKey.trim()) {
    throw new AiGatewayError('auth_error', 'not_billed');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    provider: 'anthropic',
    async invoke(call: AdapterCall) {
      const raw = await postJson(fetchImpl, ANTHROPIC_MESSAGES_URL, {
        'x-api-key': options.apiKey,
        'anthropic-version': '2023-06-01',
      }, JSON.stringify(buildAnthropicMessagesBody(call.model, call.request)), call.signal);
      return parseAnthropicResponse(raw);
    },
  };
}
