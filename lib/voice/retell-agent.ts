/**
 * SC-011 Retell Preview foundation: read-only metadata lookup.
 * This module must run server-side. It never creates calls, edits agents,
 * receives CVs, stores recordings, or logs credentials/provider payloads.
 */
export type RetellAgentStatus = Readonly<{
  agentId: string;
  name: string | null;
  published: boolean;
  version: number;
  language: string | readonly string[] | null;
  voiceId: string | null;
  responseEngineType: string | null;
}>;

export type RetellAgentEnvironment = Readonly<{
  RETELL_API_KEY?: string;
  RETELL_AGENT_ID?: string;
}>;

type AgentFetch = (
  url: string,
  init: RequestInit,
) => Promise<Pick<Response, "status" | "json">>;

export type RetellAgentErrorCode =
  | "RETELL_NOT_CONFIGURED"
  | "RETELL_AUTH_FAILED"
  | "RETELL_AGENT_NOT_FOUND"
  | "RETELL_UNAVAILABLE"
  | "RETELL_INVALID_RESPONSE";

export class RetellAgentError extends Error {
  readonly code: RetellAgentErrorCode;
  constructor(code: RetellAgentErrorCode) {
    super(code);
    this.code = code;
    this.name = "RetellAgentError";
  }
}

const agentIdPattern = /^(?:agent_[A-Za-z0-9]{16,64}|[A-Za-z0-9]{32})$/;

// Validate Retell's full AgentResponse response-engine discriminated union.
// A malformed configuration must not pass the read-only preflight.
function isValidResponseEngine(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const engine = value as Record<string, unknown>;
  const requiredField =
    engine.type === "retell-llm" ? "llm_id" :
    engine.type === "custom-llm" ? "llm_websocket_url" :
    engine.type === "conversation-flow" ? "conversation_flow_id" : null;
  if (requiredField === null) return false;
  const identifier = engine[requiredField];
  return typeof identifier === "string" &&
    identifier.trim().length > 0 && identifier.length <= 2048;
}

/**
 * GET /get-agent/{agent_id} only. Fail closed when the credential or agent ID
 * is absent, and never propagate provider response bodies or thrown messages.
 * The caller must separately authorize access; this is NOT a public API route.
 */
export async function readRetellAgent(
  env: RetellAgentEnvironment = {
    RETELL_API_KEY: process.env.RETELL_API_KEY,
    RETELL_AGENT_ID: process.env.RETELL_AGENT_ID,
  },
  http: AgentFetch = fetch,
): Promise<RetellAgentStatus> {
  const key = env.RETELL_API_KEY;
  const agentId = env.RETELL_AGENT_ID;
  if (
    typeof key !== "string" || key.trim().length < 16 ||
    /[\r\n]/.test(key) ||
    typeof agentId !== "string" || !agentIdPattern.test(agentId)
  ) throw new RetellAgentError("RETELL_NOT_CONFIGURED");

  let response: Pick<Response, "status" | "json">;
  try {
    response = await http(
      `https://api.retellai.com/get-agent/${agentId}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      },
    );
  } catch {
    throw new RetellAgentError("RETELL_UNAVAILABLE");
  }
  if (response.status === 401 || response.status === 403)
    throw new RetellAgentError("RETELL_AUTH_FAILED");
  if (response.status === 404 || response.status === 422)
    throw new RetellAgentError("RETELL_AGENT_NOT_FOUND");
  if (response.status !== 200)
    throw new RetellAgentError("RETELL_UNAVAILABLE");

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RetellAgentError("RETELL_INVALID_RESPONSE");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new RetellAgentError("RETELL_INVALID_RESPONSE");
  const data = body as Record<string, unknown>;
  if (
    data.agent_id !== agentId ||
    (data.agent_name != null &&
      (typeof data.agent_name !== "string" || data.agent_name.length > 200)) ||
    typeof data.voice_id !== "string" || data.voice_id.length === 0 || data.voice_id.length > 120 ||
    !isValidResponseEngine(data.response_engine) ||
    typeof data.is_published !== "boolean" ||
    !Number.isInteger(data.version) ||
    (data.version as number) < 0
  ) throw new RetellAgentError("RETELL_INVALID_RESPONSE");

  const engine = data.response_engine;
  const engineType = engine && typeof engine === "object" && !Array.isArray(engine)
    ? (engine as Record<string, unknown>).type : undefined;
  // Retell may return either one locale or a multilingual locale array.
  // Copy/freeze array values to prevent downstream mutation of the status.
  const sourceLanguage = data.language;
  let language: string | readonly string[] | null = null;
  if (typeof sourceLanguage === "string" &&
      sourceLanguage.length > 0 && sourceLanguage.length <= 30) {
    language = sourceLanguage;
  } else if (Array.isArray(sourceLanguage) &&
      sourceLanguage.length > 0 &&
      sourceLanguage.every((value: unknown) =>
        typeof value === "string" && value.length > 0 && value.length <= 30)) {
    language = Object.freeze([...sourceLanguage] as string[]);
  }
  // Return a strict projection, never Retell's raw agent configuration.
  return Object.freeze({
    agentId,
    name: data.agent_name ?? null,
    published: data.is_published,
    version: data.version as number,
    language,
    voiceId: data.voice_id as string,
    responseEngineType: engineType as string,
  });
}
