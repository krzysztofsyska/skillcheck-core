/** SC-FREE-AUTO-001: automatic FREE activation for a company whose NIP the
 * Ministry of Finance "Wykaz podatników VAT" (biała lista) confirms as a
 * registered taxpayer — 'Czynny' or 'Zwolniony'. Owner decision 2026-11-03.
 *
 * FAIL-CLOSED, ALWAYS. FREE is granted only on a positive, parsed registry
 * answer. Not found, an unknown status, malformed, rate-limited, unreachable or
 * timed out all mean "grant nothing" — the company stays on the existing manual
 * list in /operator/billing, which is untouched and remains the fallback.
 *
 * WHY THIS MODULE SIGNS ITS REQUEST. A checksum-valid NIP does not prove the
 * caller represents that company (the reason the operator approval exists), so
 * the registry answer must be the gate. The RPC is reachable by any signed-in
 * user through the Data API, so the database refuses any auto-approval whose
 * evidence is not HMAC-signed with the server-held secret: without it a caller
 * could claim a confirmation that never happened and mint FREE packs at will.
 * The same reasoning as lib/cv-bulk-server.ts and lib/sales-mail.ts.
 */

import { createHmac, createHash } from 'node:crypto';
import { WhitelistError, type CompanyRecord, type WhitelistErrorCode } from './mf-whitelist.ts';

export const SC19_TRIAL_AUTO_SECRET_MIN_BYTES = 32;
/** The registry call is a user action on the activation form; keep it short. */
export const SC19_TRIAL_AUTO_TIMEOUT_MS = 8000;

/** `granted` is the only outcome that activates FREE. `refused` means the
 * registry answered and the answer does not qualify; `unavailable` means we have
 * no answer at all. Both non-granted outcomes behave identically for the
 * company (manual review) and are kept apart only for the audit trail. */
export type TrialAutoOutcome = 'granted' | 'refused' | 'unavailable';

export type TrialAutoDecision = Readonly<{
  outcome: TrialAutoOutcome;
  /** Present only when the registry answered with a subject. */
  mfRequestId: string;
  mfStatus: string;
  mfName: string;
  errorCode: WhitelistErrorCode | 'STATUS_NOT_ACTIVE' | null;
}>;

const EMPTY = { mfRequestId: '', mfStatus: '', mfName: '', errorCode: null } as const;

/** Registry answers that mean "this company does not qualify" rather than "we
 * could not ask". Anything else is treated as no answer. */
const REFUSING_CODES = new Set<WhitelistErrorCode>([
  'NIP_INVALID', 'NIP_NOT_FOUND', 'NIP_NOT_ACTIVE', 'WHITELIST_ADDRESS_UNPARSEABLE',
]);

/** Both registry statuses that mean "this company is in the VAT register" are
 * granted automatically: 'Czynny' (active taxpayer) and 'Zwolniony' (VAT-exempt;
 * owner decision 2026-11-03 — many small Polish companies are exempt and they
 * are real companies). Anything else, including an empty or unknown status, is
 * refused. lib/mf-whitelist.ts already rejects every other status with
 * NIP_NOT_ACTIVE before the record reaches this function; the check below is the
 * second, independent gate, so a widened parser cannot widen the grant. */
export const SC19_TRIAL_AUTO_GRANTING_STATUSES: readonly string[] = Object.freeze(['Czynny', 'Zwolniony']);

export function decideTrialAuto(result: CompanyRecord | WhitelistError | unknown): TrialAutoDecision {
  if (result instanceof WhitelistError) {
    return Object.freeze({
      ...EMPTY,
      outcome: REFUSING_CODES.has(result.code) ? 'refused' : 'unavailable',
      errorCode: result.code,
    });
  }
  if (!result || typeof result !== 'object') return Object.freeze({ ...EMPTY, outcome: 'unavailable' });
  const record = result as Partial<CompanyRecord>;
  if (typeof record.requestId !== 'string' || typeof record.name !== 'string' || typeof record.statusVat !== 'string') {
    return Object.freeze({ ...EMPTY, outcome: 'unavailable' });
  }
  const evidence = {
    mfRequestId: record.requestId.slice(0, 64),
    mfStatus: record.statusVat.slice(0, 32),
    mfName: record.name.slice(0, 300),
  };
  if (!SC19_TRIAL_AUTO_GRANTING_STATUSES.includes(record.statusVat)) {
    return Object.freeze({ ...evidence, outcome: 'refused', errorCode: 'STATUS_NOT_ACTIVE' });
  }
  return Object.freeze({ ...evidence, outcome: 'granted', errorCode: null });
}

export type TrialAutoSignatureInput = Readonly<{
  requestId: string;
  issuedAtMs: number;
  companyId: string;
  nip: string;
  mfRequestId: string;
  mfStatus: string;
  mfName: string;
}>;

/** Operations signed with the one server-held secret. Distinct labels keep a
 * signature valid for one operation from being replayed as another.
 *
 * `auto_claim` and `auto_failure` are two different RPCs whose payloads happen
 * to be structurally similar (company, NIP, then either registry evidence or an
 * error code). They had the same label at first, which left the two apart only
 * by the number of payload lines; separate labels make the separation explicit.
 * `consent` is verified in Node only (lib/marketing-consent.ts) and is
 * deliberately NOT in the database's whitelist, so a consent signature can
 * never be presented to any RPC.
 *
 * `consent_registration` is the opposite direction and a separate label: it is
 * the fresh request the server action makes AFTER it has verified the `consent`
 * snapshot, and it is what proves to the database that a registration-sourced
 * consent came through our server rather than straight from a browser. Keeping
 * the two labels apart is what stops the client-writable snapshot signature
 * being presented to the RPC. */
export type TrialAutoOp = 'auto_claim' | 'auto_failure' | 'digest' | 'consent' | 'consent_registration';

/** `payload` is the operation's own canonical tail, hashed so the signed string
 * has a fixed shape whatever the operation carries. */
export function trialAutoCanonical(op: TrialAutoOp, requestId: string, issuedAtMs: number, payload: string): string {
  if (!Number.isSafeInteger(issuedAtMs)) throw new Error('sc19_trial_auto_invalid_stamp');
  const digest = createHash('sha256').update(payload, 'utf8').digest('hex');
  return ['sc19-trial-auto-v1', op, requestId.toLowerCase(), String(issuedAtMs), digest].join('\n');
}

/** Mirrors the payload built in private.sc19_trial_auto_claim exactly, including
 * the name digest — the company name travels as data and must not be
 * substitutable for another registry answer. */
export function trialAutoClaimPayload(input: TrialAutoSignatureInput): string {
  const nameDigest = createHash('sha256').update(input.mfName, 'utf8').digest('hex');
  return [input.companyId.toLowerCase(), input.nip, input.mfRequestId || '-', input.mfStatus || '-', nameDigest].join('\n');
}

/** Pure builder: no environment, headers or network. */
export function signTrialAuto(op: TrialAutoOp, requestId: string, issuedAtMs: number, payload: string, secret: string): string {
  if (Buffer.byteLength(secret, 'utf8') < SC19_TRIAL_AUTO_SECRET_MIN_BYTES) {
    throw new Error('sc19_trial_auto_secret_invalid');
  }
  return createHmac('sha256', secret).update(trialAutoCanonical(op, requestId, issuedAtMs, payload), 'utf8').digest('hex');
}

/** Automatic activation runs only with a long enough server-held secret. Without
 * it nothing is attempted and the company goes to manual review, which is the
 * same path as a registry failure. The database holds a second switch
 * (private.sc19_trial_auto_settings.auto_free_enabled, default false), so the
 * feature stays off until an operator turns it on. */
export function trialAutoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Buffer.byteLength(env.SC19_TRIAL_AUTO_SECRET ?? '', 'utf8') >= SC19_TRIAL_AUTO_SECRET_MIN_BYTES;
}

/** Panel notices. A refused and an unavailable registry answer deliberately
 * read the same to the company: both mean "we will check this by hand". */
export const trialAutoNotices = {
  manual: 'Nie mogliśmy potwierdzić firmy automatycznie w wykazie podatników VAT. '
    + 'Zgłoszenie trafiło do sprawdzenia przez obsługę SkillCheck — odezwiemy się do Ciebie.',
} as const;
