// R1-AUTO-ACCESS: wynik public.issue_exercise_ai_auto_access (20261117200000_r1_auto_competency_access.sql).
// Baza wydaje dostęp tylko w trybie automatycznym i tylko krótkiej liście (R1); tu jedynie
// sprawdzamy kształt odpowiedzi. Nic nie jest wysyłane kandydatom, sekret linku nie przychodzi.
const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export type ExerciseAiAutoAccessRow = {
  grantId: string; applicationId: string; definitionId: string; candidateName: string;
  title: string; version: number; revision: number; startBy: string; revoked: boolean;
};
export type ExerciseAiAutoAccess = { autoRelease: boolean; issued: number; access: ExerciseAiAutoAccessRow[] };

/** Ten sam warunek co wydawanie i rotacja dostępu w competency-actions.ts: test kandydata działa tylko w Preview/dev. */
export function exerciseAiAutoAccessEnabled(env: Record<string, string | undefined> = process.env) {
  return env.EXERCISE_AI_ENABLED === 'true' && env.COMPETENCY_CANDIDATE_PREVIEW === 'true' &&
    (env.VERCEL_ENV === 'preview' || env.NODE_ENV === 'development');
}

/** Zwraca null przy każdym nieoczekiwanym kształcie (fail closed: nic nie pokazujemy jako wydane). */
export function parseExerciseAiAutoAccess(value: unknown): ExerciseAiAutoAccess | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.autoRelease !== 'boolean' || !Number.isSafeInteger(v.issued) || (v.issued as number) < 0 || !Array.isArray(v.access)) return null;
  const access: ExerciseAiAutoAccessRow[] = [];
  for (const item of v.access) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const r = item as Record<string, unknown>;
    if (![r.grantId, r.applicationId, r.definitionId].every(id => typeof id === 'string' && uuid.test(id)) ||
      typeof r.candidateName !== 'string' || typeof r.title !== 'string' || typeof r.startBy !== 'string' ||
      !Number.isSafeInteger(r.version) || !Number.isSafeInteger(r.revision) || typeof r.revoked !== 'boolean') return null;
    access.push({ grantId: r.grantId as string, applicationId: r.applicationId as string, definitionId: r.definitionId as string,
      candidateName: r.candidateName, title: r.title, version: r.version as number, revision: r.revision as number,
      startBy: r.startBy, revoked: r.revoked });
  }
  return { autoRelease: v.autoRelease, issued: v.issued as number, access };
}
