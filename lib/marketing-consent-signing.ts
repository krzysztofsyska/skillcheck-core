import { timingSafeEqual } from 'node:crypto';
import { signTrialAuto, trialAutoEnabled } from './sc19-trial-auto.ts';
import {
  declaredMarketingConsent, marketingConsentDeclaration, type MarketingConsentDeclaration,
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
 * (private.sc19_trial_auto_verify_signature accepts only auto_claim,
 * auto_failure and digest), so a signature produced here can never be presented
 * to an RPC, and no RPC signature can be replayed as a consent.
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

/** The consent version to record, or null. Null for an absent, malformed,
 * withdrawn, unsigned, wrongly signed or foreign-account snapshot. */
export function verifiedConsentVersion(metadata: unknown, subject: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env): string | null {
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
