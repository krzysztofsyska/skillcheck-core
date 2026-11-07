import { randomUUID, timingSafeEqual } from 'node:crypto';
import { signTrialAuto, trialAutoEnabled } from './sc19-trial-auto.ts';
import {
  declaredMarketingConsent, marketingConsentDeclaration, type MarketingConsentDeclaration,
  type VerifiedMarketingConsent,
} from './marketing-consent.ts';

/** SC-CONSENT-001 server side: signs the registration-time consent snapshot and
 * verifies it again before it is recorded against the new company.
 *
 * The snapshot lives in the Supabase user metadata, which the user can write
 * (auth.updateUser), so without a signature a user could set
 * `marketing_consent.granted = true` after confirming their address and have the
 * append-only ledger certify a consent they never gave. The HMAC below binds the
 * snapshot to the account's e-mail address, the version and the declaration
 * time; lib/marketing-consent.ts explains why the address and not the user id
 * (the id does not exist yet when the snapshot is written).
 *
 * SAME SECRET, OWN LABEL. It is the one server secret used by the rest of this
 * change, SC19_TRIAL_AUTO_SECRET, under the operation label 'consent'. That
 * label is deliberately NOT in the database's whitelist
 * (private.sc19_trial_auto_verify_signature accepts auto_claim, auto_failure,
 * digest and consent_registration), so the snapshot signature can never be
 * presented to an RPC, and no RPC signature can be replayed as a snapshot.
 *
 * AND THE SECOND SIGNATURE, FOR THE DATABASE. Verifying the snapshot in Node was
 * not enough on its own: public.marketing_consent_grant used to take the source
 * as a parameter and was executable by any signed-in user, so an owner could
 * call it through the Data API with consent_source='registration' and have the
 * append-only ledger certify a sign-up consent that never happened (bot review
 * finding, 2026-11-03). The source is no longer a parameter of that RPC at all;
 * a registration-sourced row is written only by
 * public.marketing_consent_grant_registration, which verifies the request
 * signTrialAuto('consent_registration', ...) below produces. A browser never
 * holds the secret, so only this server path can record that provenance.
 *
 * FAIL-CLOSED. No secret configured means no snapshot can be signed and none can
 * be verified, so no registration consent is ever recorded. The company owner
 * can still give the consent in one click in /dashboard/<id>/zgody, where it is
 * recorded directly against the company and no snapshot is involved.
 *
 * This module carries no 'server-only' guard so that tests can exercise it
 * directly, exactly as ./sc19-trial-auto-flow.ts does. Application code imports
 * ./marketing-consent-server.ts, whose guard keeps the secret out of any client
 * bundle.
 */

const CONSENT_STAMP = 0; // a snapshot carries its own declared_at; there is no request window here.

function secret(env: NodeJS.ProcessEnv = process.env): string | null {
  return trialAutoEnabled(env) ? env.SC19_TRIAL_AUTO_SECRET! : null;
}

/** The snapshot to store in the user metadata at sign-up. Returns an unsigned,
 * not-granted snapshot when the box was unticked or no secret is configured. */
export function signedConsentDeclaration(granted: boolean, subject: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env, now?: Date): MarketingConsentDeclaration {
  const key = secret(env);
  if (!granted || !subject || !key) return marketingConsentDeclaration(false, { now });
  return marketingConsentDeclaration(true, {
    subject, now,
    sign: (payload, requestId) => signTrialAuto('consent', requestId, CONSENT_STAMP, payload, key),
  });
}

/** The consent version to record AND the moment the customer declared it, or
 * null. Null for an absent, malformed, withdrawn, unsigned, wrongly signed or
 * foreign-account snapshot. `declaredAt` is null only when the verified
 * timestamp does not parse; the consent is still recorded then, stamped by the
 * database's own clock. */
export function verifiedConsentVersion(metadata: unknown, subject: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env): VerifiedMarketingConsent | null {
  const key = secret(env);
  if (!key) return null;
  return declaredMarketingConsent(metadata, {
    subject,
    verify: (payload, requestId, signature) => {
      let expected: string;
      try { expected = signTrialAuto('consent', requestId, CONSENT_STAMP, payload, key); }
      catch { return false; }
      // Same length by construction (both hex SHA-256), but a forged value need
      // not be, and timingSafeEqual throws on a length mismatch.
      const supplied = Buffer.from(signature.toLowerCase(), 'utf8');
      const reference = Buffer.from(expected, 'utf8');
      return supplied.length === reference.length && timingSafeEqual(supplied, reference);
    },
  });
}

/** What a registration-sourced consent must carry so the database will accept
 * the provenance: a fresh request id, the time, and an HMAC over this company,
 * this version and the DECLARED TIME. Mirrors the payload rebuilt in
 * public.marketing_consent_grant_registration exactly. Null when no secret is
 * configured — then no registration consent is recorded at all, and the owner
 * gives it in one click in the company panel instead.
 *
 * THE DECLARED TIME IS SIGNED (bot review finding, 2026-11-03). It is the fact
 * the ledger exists to prove, and it reaches the database as a request parameter,
 * so leaving it out of the signature would let an owner calling the Data API
 * himself choose the date his consent is recorded under. It is canonicalised to
 * the UTC form Date.prototype.toISOString() produces, which is exactly what
 * to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') rebuilds on the database side;
 * `declaredAt: null` is signed as '-' and means "no usable time", which the
 * database answers by stamping now() rather than dropping the consent. */
export type RegistrationConsentRequest = Readonly<{
  requestId: string; issuedAtMs: number; signature: string; declaredAt: string | null;
}>;

export function signRegistrationConsentGrant(companyId: string, version: string,
  declaredAt: string | null, env: NodeJS.ProcessEnv = process.env, now?: Date): RegistrationConsentRequest | null {
  const key = secret(env);
  if (!key) return null;
  const parsed = declaredAt === null ? NaN : Date.parse(declaredAt);
  const canonical = Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  const requestId = randomUUID(), issuedAtMs = (now ?? new Date()).getTime();
  const payload = [companyId.toLowerCase(), version, canonical ?? '-'].join('\n');
  return Object.freeze({
    requestId, issuedAtMs, declaredAt: canonical,
    signature: signTrialAuto('consent_registration', requestId, issuedAtMs, payload, key),
  });
}
