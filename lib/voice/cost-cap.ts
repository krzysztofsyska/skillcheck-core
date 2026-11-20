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

/**
 * USD to grosze for recording Retell's real call cost: the same conservative
 * 4.50 zł/USD the migration (20261121120000_r7_voice_cost_cap.sql) uses to size
 * the per-call reservation. A fixed constant, never a live exchange rate.
 */
export const VOICE_COST_GROSZE_PER_USD = 450;
/** The database's upper limit for one recorded call cost (`charges.cost_grosze`). */
export const VOICE_COST_MAX_GROSZE = 1_000_000;

/**
 * Retell's `combined_cost` (USD cents, may be fractional) to whole grosze,
 * rounded UP so a recorded cost is never below the real one. A cost above the
 * database limit is clamped to it: still far above any reservation, so the month
 * fails closed (reserve_exceeded). Null for anything that is not a cost.
 */
export function retellCostCentsToGrosze(cents: unknown): number | null {
  if (typeof cents !== "number" || !Number.isFinite(cents) || cents < 0) return null;
  if (cents > 1e9) return VOICE_COST_MAX_GROSZE;
  // Exact decimal arithmetic, no rounding before the ceil: `String(cents)` is the
  // shortest decimal that round-trips to the number (e.g. "40.00001", "1e-7"), and
  // grosze = cents × 450 / 100 = mantissa × 450 × 10^exp / 100, rounded up with BigInt.
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(cents));
  if (!match) return null;
  const [, integerPart, fractionPart = "", exponentPart = "0"] = match;
  const mantissa = BigInt(integerPart + fractionPart);
  const exponent = Number(exponentPart) - fractionPart.length;
  // BigInt(...) instead of literals and `**`: the project targets below ES2020.
  const powerOfTen = (n: number) => BigInt("1" + "0".repeat(n));
  let numerator = mantissa * BigInt(VOICE_COST_GROSZE_PER_USD);
  let denominator = BigInt(100);
  if (exponent >= 0) numerator *= powerOfTen(exponent);
  else denominator *= powerOfTen(-exponent);
  const grosze = (numerator + denominator - BigInt(1)) / denominator;
  const limit = BigInt(VOICE_COST_MAX_GROSZE);
  return Number(grosze > limit ? limit : grosze);
}
