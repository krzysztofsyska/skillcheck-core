/**
 * ROADMAP R6 (#542): read-only view of finished voice interview transcripts for
 * ONE application, shown to the recruiter on a Preview-only page.
 *
 * - Same server-side flag as the interview plan preview (voicePlanPreviewEnabled):
 *   never on when VERCEL_ENV=production; the page then answers 404.
 * - Only the company owner or a recruiter (canEdit) gets the page; the database
 *   function public.read_voice_interview_transcripts re-checks membership and the
 *   company -> recruitment -> application binding and logs every read.
 * - Transcript text is candidate data: it is rendered, never logged, exported or
 *   sent anywhere. Only {speaker, text} per line is kept from the RPC result.
 */
import { voicePlanPreviewEnabled } from "./plan-preview.ts";

type Env = Readonly<Record<string, string | undefined>>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Page guard. Without `canEdit` it is the pre-check run before any database
 * access (flag + route shape); with it, the viewer check after company access.
 * Any `false` means the page answers 404.
 */
export function voiceTranscriptPageAllowed(input: {
  route: Readonly<Record<string, unknown>>;
  canEdit?: boolean;
  env?: Env;
}): boolean {
  if (!voicePlanPreviewEnabled(input.env ?? process.env)) return false;
  const keys = ["companyId", "recruitmentId", "applicationId"];
  const route = input.route;
  if (!route || Object.keys(route).length !== keys.length) return false;
  if (!keys.every(key => typeof route[key] === "string" && uuidPattern.test(route[key] as string))) return false;
  return input.canEdit === undefined || input.canEdit === true;
}

export type VoiceTranscriptState = "available" | "erased_retention" | "not_received";
export type VoiceTranscriptLine = Readonly<{ speaker: "agent" | "candidate"; text: string }>;
export type VoiceTranscriptCall = Readonly<{
  callNo: number;
  callAt: string;
  state: VoiceTranscriptState;
  lines: readonly VoiceTranscriptLine[];
}>;

export const voiceTranscriptStateLabels: Record<Exclude<VoiceTranscriptState, "available">, string> = {
  erased_retention: "Dane rozmowy usunięte zgodnie z retencją (90 dni po zamknięciu rekrutacji).",
  not_received: "Rozmowa zakończona, ale transkrypt jeszcze nie dotarł.",
};

export const voiceTranscriptSpeakerLabels: Record<VoiceTranscriptLine["speaker"], string> = {
  agent: "Asystent rozmowy",
  candidate: "Kandydat",
};

export type VoiceTranscriptLoadState = "not_found" | "withdrawn" | "unavailable";
export const voiceTranscriptLoadLabels: Record<Exclude<VoiceTranscriptLoadState, "not_found">, string> = {
  withdrawn: "Transkrypt jest niedostępny: zgłoszenie zostało wycofane albo dane kandydata są w trakcie usuwania.",
  unavailable: "Nie udało się wczytać transkryptów. Odśwież stronę.",
};
export const voiceTranscriptEmptyLabel = "Dla tego zgłoszenia nie ma zakończonych rozmów głosowych.";

/** Maps an RPC error to a page state. 42501 (forbidden or foreign record) is a 404. */
export function voiceTranscriptErrorState(error: { code?: string } | null | undefined): VoiceTranscriptLoadState {
  if (error?.code === "42501") return "not_found";
  if (error?.code === "55000") return "withdrawn";
  return "unavailable";
}

const states: readonly string[] = ["available", "erased_retention", "not_received"];
const speakers: readonly string[] = ["agent", "candidate"];

/**
 * Validates the RPC rows and keeps only the fields the page shows. Any
 * unexpected shape returns null (the page then shows "unavailable").
 */
export function parseVoiceTranscriptRows(data: unknown): VoiceTranscriptCall[] | null {
  if (!Array.isArray(data) || data.length > 1000) return null;
  const calls: VoiceTranscriptCall[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") return null;
    const { call_no: callNo, call_at: callAt, transcript_state: state, utterances } = row as Record<string, unknown>;
    if (!Number.isInteger(callNo) || (callNo as number) < 1 || typeof callAt !== "string" || Number.isNaN(Date.parse(callAt))) return null;
    if (typeof state !== "string" || !states.includes(state)) return null;
    if (state !== "available") {
      if (utterances !== null && utterances !== undefined) return null;
      calls.push({ callNo: callNo as number, callAt, state: state as VoiceTranscriptState, lines: [] });
      continue;
    }
    if (!Array.isArray(utterances) || utterances.length < 1 || utterances.length > 400) return null;
    const lines: VoiceTranscriptLine[] = [];
    for (const line of utterances) {
      const { speaker, text } = (line ?? {}) as Record<string, unknown>;
      if (typeof speaker !== "string" || !speakers.includes(speaker) || typeof text !== "string") return null;
      lines.push({ speaker: speaker as VoiceTranscriptLine["speaker"], text });
    }
    calls.push({ callNo: callNo as number, callAt, state: "available", lines });
  }
  return calls;
}
