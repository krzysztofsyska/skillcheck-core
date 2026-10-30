/**
 * SC-011-B6: platform-operator resolution of `unknown` Retell dispatches on a
 * trusted server connection whose session carries the operator's auth.uid()
 * (db/isolated/sc011b6-voice-dispatch-resolution.sql). Nothing here contacts
 * Retell: the operator checks the Retell dashboard and records the result.
 */
import type { SqlClient } from "./trusted-source-verifier.ts";
import type { RetellCallOutcome } from "./retell-webhook.ts";

export type UnknownVoiceDispatch = Readonly<{
  companyId: string; preparationId: string; startedAt: string; lastAttemptAt: string; attempts: number;
}>;
export type UnknownVoiceDispatchResolution =
  | Readonly<{ resolution: "not_placed" }>
  | Readonly<{ resolution: "placed"; providerCallId: string; outcome: RetellCallOutcome; agentId: string }>;

export class VoiceDispatchResolutionError extends Error {
  readonly code: "VOICE_RESOLUTION_FORBIDDEN" | "VOICE_RESOLUTION_CONFLICT" | "VOICE_RESOLUTION_INVALID" |
    "VOICE_RESOLUTION_UNAVAILABLE";
  constructor(code: VoiceDispatchResolutionError["code"]) { super(code); this.code = code; }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const outcomes: readonly RetellCallOutcome[] =
  ["completed", "dnc_requested", "no_answer", "busy", "voicemail", "provider_error", "other"];

function mapped(error: unknown): VoiceDispatchResolutionError {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "42501") return new VoiceDispatchResolutionError("VOICE_RESOLUTION_FORBIDDEN");
  if (["PT409", "23505", "55P03", "40001", "40P01"].includes(code))
    return new VoiceDispatchResolutionError("VOICE_RESOLUTION_CONFLICT");
  if (["PT422", "23514", "22023"].includes(code)) return new VoiceDispatchResolutionError("VOICE_RESOLUTION_INVALID");
  return new VoiceDispatchResolutionError("VOICE_RESOLUTION_UNAVAILABLE");
}

export async function listUnknownVoiceDispatches(db: SqlClient, limit = 50): Promise<readonly UnknownVoiceDispatch[]> {
  try {
    const rows = (await db.query("select * from private.sc011b_list_unknown_dispatches($1)",
      [Number.isSafeInteger(limit) ? limit : 50])).rows;
    return Object.freeze(rows.map(r => Object.freeze({
      companyId: String(r.company_id), preparationId: String(r.preparation_id),
      startedAt: new Date(r.started_at as string).toISOString(),
      lastAttemptAt: new Date(r.last_attempt_at as string).toISOString(), attempts: Number(r.attempts),
    })));
  } catch (e) { throw mapped(e); }
}

/** Records the operator's finding for one unknown claim, atomically. */
export async function resolveUnknownVoiceDispatch(
  db: SqlClient, target: Readonly<{ companyId: string; preparationId: string }>,
  decision: UnknownVoiceDispatchResolution,
): Promise<void> {
  if (!target || !uuid.test(target.companyId ?? "") || !uuid.test(target.preparationId ?? "") || !decision ||
      (decision.resolution === "placed" && (!outcomes.includes(decision.outcome) ||
        typeof decision.providerCallId !== "string" || typeof decision.agentId !== "string")) ||
      (decision.resolution !== "placed" && decision.resolution !== "not_placed"))
    throw new VoiceDispatchResolutionError("VOICE_RESOLUTION_INVALID");
  const placed = decision.resolution === "placed" ? decision : null;
  try {
    await db.query("select private.sc011b_resolve_unknown_dispatch($1,$2,$3,$4,$5,$6)", [
      target.companyId, target.preparationId, decision.resolution,
      placed?.agentId ?? null, placed?.providerCallId ?? null, placed?.outcome ?? null,
    ]);
  } catch (e) { throw mapped(e); }
}
