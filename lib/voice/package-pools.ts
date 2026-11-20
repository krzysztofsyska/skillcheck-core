/**
 * R6-2 (packages), trusted-server-only: the voice interview pool that a
 * company's packages give it (owner 20.11.2026: FREE 1 trial interview;
 * PRESELEKCJA, WERYFIKACJA and ASSESSMENT CENTER 10 each). The numbers live only
 * in private.sc19_voice_package_allowance; any other package gives nothing.
 *
 * `ensurePackageVoicePool` first gives the company every package pool it does
 * not have yet (private.sc19_voice_sync_package_pools, idempotent, owner-only),
 * then names the pool the next interview should use: an eligible pool of THIS
 * company with a free unit, the one that ends first. The caller passes that id
 * as `entitlementId` to prepareOfflineVoiceDraft, which locks and rechecks it.
 * If another order takes that pool's last unit in between, the order is refused
 * (QUOTA_EXHAUSTED) even when another pool still has units: the caller may call
 * this helper once more and retry with the fresh pick.
 *
 * The caller supplies a trusted server connection; the company id comes from
 * the authenticated server session, never from a browser. No provider, no
 * network, nothing sent; not visible to customers.
 */
import type {SqlClient} from "./trusted-source-verifier.ts";

export type PackageVoicePool = Readonly<{
  /** Packages of the company that have a voice pool (FREE and paid). */
  packagePools: number;
  /** Pools created by this call (0 on every retry). */
  created: number;
  /** Pool for the next interview, or null when no interview is left. */
  entitlementId: string | null;
  /** Free interviews across all eligible pools of the company. */
  available: number;
}>;

export class PackageVoicePoolError extends Error {
  constructor() { super("VOICE_PACKAGE_POOL_UNAVAILABLE"); this.name = "PackageVoicePoolError"; }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const count = (value: unknown): number => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new PackageVoicePoolError();
  return n;
};

export async function ensurePackageVoicePool(db: SqlClient, companyId: string): Promise<PackageVoicePool> {
  if (typeof companyId !== "string" || !uuid.test(companyId)) throw new PackageVoicePoolError();
  try {
    const synced = (await db.query(
      "select package_pools,created from private.sc19_voice_sync_package_pools($1)", [companyId])).rows;
    if (synced.length !== 1) throw new PackageVoicePoolError();
    const next = (await db.query([
      "select e.id from private.sc19_voice_entitlements e",
      "where e.company_id=$1 and private.sc19_voice_entitlement_eligible(e) and e.used+e.reserved<e.total",
      "order by e.expires_at,e.id limit 1",
    ].join(" "), [companyId])).rows[0]?.id;
    const balance = (await db.query(
      "select available from private.sc19_voice_interview_balance($1)", [companyId])).rows;
    if (balance.length !== 1) throw new PackageVoicePoolError();
    if (next !== undefined && (typeof next !== "string" || !uuid.test(next))) throw new PackageVoicePoolError();
    return Object.freeze({
      packagePools: count(synced[0].package_pools),
      created: count(synced[0].created),
      entitlementId: next ?? null,
      available: count(balance[0].available),
    });
  } catch {
    // No raw database error (or another company's data) escapes to the caller.
    throw new PackageVoicePoolError();
  }
}
