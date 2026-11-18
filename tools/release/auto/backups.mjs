// #491: evidence for `backupGate` (policy.mjs) — the list of Supabase database backups of the
// production project, read from the Supabase Management API, the source `backupGate` was written
// for. Read only (one GET). The publisher reads it only when the migration executor is present.
// Fail closed: no token, an HTTP error or an unexpected shape all return null, which the policy
// turns into BACKUP_EVIDENCE_MISSING. Only `status` and `inserted_at` are kept.
export const PRODUCTION_PROJECT_REF = 'wsvjawuikxfzjyivxgsu';

export async function readBackups({ token, projectRef = PRODUCTION_PROJECT_REF, fetchImpl = fetch } = {}) {
  const auth = typeof token === 'string' ? token.trim() : '';
  if (!auth) return null;
  try {
    const res = await fetchImpl(`https://api.supabase.com/v1/projects/${projectRef}/database/backups`, {
      method: 'GET', headers: { authorization: `Bearer ${auth}`, accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!Array.isArray(json?.backups)) return null;
    return json.backups.map(b => ({ status: b?.status ?? null, inserted_at: b?.inserted_at ?? null }));
  } catch {
    return null;
  }
}
