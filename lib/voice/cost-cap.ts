/**
 * R7: monthly cost cap for voice interviews (owner decision 19.11.2026,
 * docs/DECYZJE.md: paid provider up to 50 zł a month, enforced in the app).
 *
 * The database is the only enforcement point
 * (supabase/migrations/20261121120000_r7_voice_cost_cap.sql): before a new
 * dispatch claim is written, `voice_budget.reserve_dispatch` refuses it with
 * SQLSTATE PT429 and the message `VOICE_COST_CAP_REACHED` when the month's
 * cost plus one call's reservation would exceed the cap. The reservation is
 * an upper bound of one call's provider cost (600 s at the highest published
 * rate), so unreconciled calls can never push real spend over the cap; a
 * recorded cost above the reservation stops new calls for the rest of the
 * month. This module only recognises that refusal and words it for the
 * recruiter.
 */

/** Mirrors the database default (`voice_budget.settings`); the database value wins. */
export const VOICE_MONTHLY_COST_CAP_GROSZE = 5000;
/** Mirrors the database default: per-call upper bound reserved before a call is ordered. */
export const VOICE_CALL_RESERVE_GROSZE = 1500;
export const VOICE_COST_CAP_SQLSTATE = "PT429";
export const VOICE_COST_CAP_REACHED = "VOICE_COST_CAP_REACHED";

/** Plain Polish text for the recruiter; no amounts, no other company's data. */
export const VOICE_COST_CAP_RECRUITER_MESSAGE =
  "Wyczerpano miesięczny limit rozmów głosowych w SkillCheck. Rozmowa nie została zlecona. " +
  "Nowe rozmowy będzie można zlecić od 1. dnia następnego miesiąca.";

/** True only for the database refusal of the monthly cost cap. */
export function isVoiceCostCapRefusal(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === VOICE_COST_CAP_SQLSTATE && message === VOICE_COST_CAP_REACHED;
}
