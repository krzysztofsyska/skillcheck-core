/**
 * ROADMAP R6 ("Podpięcie do limitów pakietów"): the recruiter's "order a voice
 * interview" step checks the company's voice interview pool and the monthly voice
 * cost cap, behind the same server-side flag as the interview plan preview
 * (voicePlanPreviewEnabled: never on when VERCEL_ENV=production).
 *
 * The database function public.voice_interview_order_check
 * (supabase/migrations/20261121170000_r6_voice_order_check.sql) re-checks the
 * caller (company owner or recruiter), the company -> recruitment -> application
 * binding and the candidate state, syncs the package pools (idempotent) and
 * returns only two values: interviews left and whether the cost cap blocks new
 * calls. No amounts, no other company's data.
 *
 * Nothing is reserved, written to a provider or sent to the candidate here:
 * real ordering (reservation of a unit and the call) stays switched off until
 * the owner opens it. The result only words the recruiter's message.
 */
import { voicePlanPreviewEnabled } from "./plan-preview.ts";
import { VOICE_COST_CAP_RECRUITER_MESSAGE } from "./cost-cap.ts";

type Env = Readonly<Record<string, string | undefined>>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type VoiceOrderRoute = Readonly<{ companyId: string; recruitmentId: string; applicationId: string }>;

/** Flag + route shape (+ canEdit when known). Any `false`: no panel, no action. */
export function voiceOrderAllowed(input: { route: Readonly<Record<string, unknown>>; canEdit?: boolean; env?: Env }): boolean {
  if (!voicePlanPreviewEnabled(input.env ?? process.env)) return false;
  const route = input.route;
  if (!route) return false;
  if (!["companyId", "recruitmentId", "applicationId"].every(key =>
    typeof route[key] === "string" && uuidPattern.test(route[key] as string))) return false;
  return input.canEdit === undefined || input.canEdit === true;
}

export type VoiceOrderCheck =
  | Readonly<{ state: "ready" | "pool_empty" | "cost_cap"; available: number }>
  | Readonly<{ state: "forbidden" | "withdrawn" | "unavailable" }>;

/** One row {available, cost_cap_blocked}; anything else fails closed. */
export function parseVoiceOrderCheck(data: unknown, error: unknown): VoiceOrderCheck {
  if (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code === "42501") return { state: "forbidden" };
    if (code === "55000") return { state: "withdrawn" };
    return { state: "unavailable" };
  }
  if (!Array.isArray(data) || data.length !== 1) return { state: "unavailable" };
  const row = data[0] as { available?: unknown; cost_cap_blocked?: unknown } | null;
  if (!row || typeof row.cost_cap_blocked !== "boolean") return { state: "unavailable" };
  const available = row.available;
  if (typeof available !== "number" || !Number.isSafeInteger(available) || available < 0) return { state: "unavailable" };
  // The pool is checked first: it is the company's own limit and tells it what to do.
  if (available === 0) return { state: "pool_empty", available };
  if (row.cost_cap_blocked) return { state: "cost_cap", available };
  return { state: "ready", available };
}

export const VOICE_POOL_EMPTY_MESSAGE =
  "Pula rozmów głosowych Twojej firmy jest wyczerpana. Rozmowa nie została zlecona.";
export const VOICE_ORDER_READY_MESSAGE =
  "Pula rozmów i miesięczny limit pozwalają zlecić tę rozmowę. To jest podgląd: zlecanie prawdziwych rozmów " +
  "jest jeszcze wyłączone, więc nic nie zostało zarezerwowane ani wysłane do kandydata.";

export const voiceOrderMessages: Record<VoiceOrderCheck["state"], string> = {
  ready: VOICE_ORDER_READY_MESSAGE,
  pool_empty: VOICE_POOL_EMPTY_MESSAGE,
  cost_cap: VOICE_COST_CAP_RECRUITER_MESSAGE,
  forbidden: "Nie masz uprawnień do zlecania rozmów w tej rekrutacji.",
  withdrawn: "Rozmowy nie można zlecić: zgłoszenie zostało wycofane albo dane kandydata są w trakcie usuwania.",
  unavailable: "Nie udało się sprawdzić puli rozmów. Odśwież stronę i spróbuj ponownie.",
};

/** Remaining pool in plain Polish, or null when it is unknown. */
export function voicePoolLabel(check: VoiceOrderCheck): string | null {
  return "available" in check ? `Pozostałe rozmowy głosowe w puli firmy: ${check.available}.` : null;
}

type RpcClient = { rpc: (fn: string, args: Record<string, string>) => PromiseLike<{ data: unknown; error: unknown }> };

/**
 * Calls the database check with the signed-in user's client. Not in the generated
 * database types yet, so the client is narrowed to this one call here.
 */
export async function loadVoiceOrderCheck(client: unknown, route: VoiceOrderRoute): Promise<VoiceOrderCheck> {
  try {
    const { data, error } = await (client as RpcClient).rpc("voice_interview_order_check", {
      target_company: route.companyId, target_recruitment: route.recruitmentId, target_application: route.applicationId,
    });
    return parseVoiceOrderCheck(data, error);
  } catch {
    return { state: "unavailable" };
  }
}
