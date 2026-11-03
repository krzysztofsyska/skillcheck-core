/** SC-CONSENT-001: optional consent to commercial contact (marketing of our own
 * services), collected at registration as a SEPARATE, unticked, non-mandatory
 * checkbox next to the mandatory legal acceptance.
 *
 * The wording stored with every consent event is held by the DATABASE
 * (private.marketing_consent_text), not by the browser: the client only names a
 * version, so a forged request can never invent the text it claims was shown.
 * The constant below is the same wording rendered in the form; the migration and
 * tests/marketing-consent.test.mjs keep the two byte-identical.
 *
 * This module collects and stores consent. It never sends anything: there is no
 * mailing, no export and no provider call anywhere in the consent path.
 */

export const MARKETING_CONSENT_VERSION = 'marketing-1.0';

/** Registration/panel form field and the only accepted value. Bump the version
 * when the wording changes, so a stale form cannot record the new version. */
export const MARKETING_CONSENT_FIELD = 'marketing_consent';
export const MARKETING_CONSENT_VALUE = `v${MARKETING_CONSENT_VERSION}`;

/** Byte-identical to private.marketing_consent_text('marketing-1.0'). */
export const MARKETING_CONSENT_TEXT =
  'Zgadzam się na kontakt handlowy ze strony KTIG CONSULTING Sp. z o.o. (SkillCheck) '
  + 'na podany przeze mnie adres e-mail, w celu przedstawienia ofert i informacji o usługach SkillCheck. '
  + 'Zgoda jest dobrowolna, nie jest warunkiem rejestracji ani korzystania z SkillCheck '
  + 'i mogę ją wycofać w każdej chwili jednym kliknięciem w panelu firmy.';

/** True only for the exact current version value; an unticked box is absent. */
export function hasMarketingConsent(form: FormData): boolean {
  return form.get(MARKETING_CONSENT_FIELD) === MARKETING_CONSENT_VALUE;
}

export type MarketingConsentDeclaration = Readonly<{
  version: string;
  granted: boolean;
  declared_at: string;
  sig: string;
}>;

/** WHY THE SNAPSHOT IS SIGNED. The consent is recorded against a company, and
 * the company does not exist yet at sign-up (it is created in /onboarding,
 * possibly after e-mail confirmation), so the choice has to travel in the
 * Supabase user metadata. That metadata is CLIENT-WRITABLE: after confirming
 * the address a user can call auth.updateUser and set
 * `marketing_consent.granted = true` even though the optional box was left
 * unticked, and the append-only ledger would then certify a consent that was
 * never given. Under art. 7(1) GDPR a consent has to be demonstrable, so a
 * snapshot that anyone can write is not good enough.
 *
 * The snapshot therefore carries an HMAC over the ACCOUNT'S E-MAIL ADDRESS, the
 * version and the declaration time, made with the same server-held secret as the
 * rest of this change (SC19_TRIAL_AUTO_SECRET) under its own operation label, so
 * a signature made here can never be presented to a database RPC. The server
 * writes it at sign-up; /onboarding records the consent only if the signature
 * verifies for the account that is signed in. No signature, a wrong one, or one
 * belonging to another account means no consent is recorded — fail-closed. The
 * wording still comes from the database, never from the snapshot.
 *
 * WHY THE E-MAIL AND NOT THE USER ID. The reviewed shape of this fix was
 * HMAC(user.id ‖ version ‖ declared_at), but the user id does not exist yet when
 * the snapshot is written: it is created BY the sign-up call that carries the
 * metadata. Binding to the id would need a second write (auth.updateUser) after
 * sign-up, which is impossible on the normal path, where e-mail confirmation is
 * pending and there is no session. The address is known on both sides, is what
 * the account was created with, and is equally unforgeable without the secret.
 * If the address is later changed the signature simply stops verifying and no
 * consent is recorded, which is the safe direction.
 *
 * This does not move WHERE consent is collected — that is a separate owner
 * decision, not yet taken. It only makes the existing snapshot unforgeable. */
function consentPayload(subject: string, version: string, declaredAt: string): string {
  return [subject.trim().toLowerCase(), version, declaredAt].join('\n');
}

/** Deterministic request id for the signature: a snapshot has no request of its
 * own, and the account is what the signature must be bound to. */
const consentRequestId = (subject: string) => subject.trim().toLowerCase();

export type ConsentSigner = (payload: string, requestId: string) => string;

/** Snapshot written into the Supabase user metadata at sign-up. `sign` receives
 * the canonical payload and returns the HMAC; the caller supplies it so this
 * module never reads the environment. Without a signer the snapshot records
 * `granted: false` and an empty signature, so nothing can be recorded later. */
export function marketingConsentDeclaration(granted: boolean, input: {
  subject?: string | null; sign?: ConsentSigner; now?: Date;
} = {}): MarketingConsentDeclaration {
  const declaredAt = (input.now ?? new Date()).toISOString();
  const subject = (input.subject ?? '').trim();
  if (!granted || !subject || !input.sign) {
    return Object.freeze({ version: MARKETING_CONSENT_VERSION, granted: false, declared_at: declaredAt, sig: '' });
  }
  return Object.freeze({
    version: MARKETING_CONSENT_VERSION, granted: true, declared_at: declaredAt,
    sig: input.sign(consentPayload(subject, MARKETING_CONSENT_VERSION, declaredAt), consentRequestId(subject)),
  });
}

/** Reads the sign-up snapshot back. Returns the version to record only when the
 * snapshot is a well-formed grant of a version this build knows AND its
 * signature verifies for this user; anything else (absent, malformed, withdrawn,
 * unknown version, unsigned, wrongly signed, signed for another account) records
 * nothing. Only the version is ever taken from the metadata — never the wording.
 *
 * `verify` must compare in constant time. Without a verifier nothing is
 * recorded: an unverifiable snapshot is treated exactly like a forged one. */
export function declaredMarketingConsent(metadata: unknown, input: {
  subject?: string | null;
  verify?: (payload: string, requestId: string, signature: string) => boolean;
} = {}): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as { marketing_consent?: unknown }).marketing_consent;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const declaration = raw as { version?: unknown; granted?: unknown; declared_at?: unknown; sig?: unknown };
  if (declaration.granted !== true) return null;
  if (declaration.version !== MARKETING_CONSENT_VERSION) return null;
  const declaredAt = declaration.declared_at, signature = declaration.sig;
  if (typeof declaredAt !== 'string' || declaredAt.length > 40
    || typeof signature !== 'string' || signature.length === 0 || signature.length > 200) return null;
  const subject = (input.subject ?? '').trim();
  if (!subject || !input.verify) return null;
  if (!input.verify(consentPayload(subject, MARKETING_CONSENT_VERSION, declaredAt), consentRequestId(subject), signature)) return null;
  return MARKETING_CONSENT_VERSION;
}

export type MarketingConsentState = Readonly<{
  event: 'granted' | 'withdrawn';
  consent_version: string;
  consent_text: string;
  occurred_at: string;
}>;

/** The panel shows the latest event; the history itself is append-only in the
 * database and is never rewritten by a grant or a withdrawal. */
export function isMarketingConsentActive(state: MarketingConsentState | null | undefined): boolean {
  return state?.event === 'granted';
}

export const marketingConsentNotices = {
  granted: 'Zgoda na kontakt handlowy została zapisana. Możesz ją wycofać w każdej chwili.',
  withdrawn: 'Zgoda na kontakt handlowy została wycofana. Zapisaliśmy datę i godzinę wycofania.',
  unchanged: 'Nic nie zmieniliśmy — zgoda była już w tym stanie.',
  failed: 'Nie udało się zapisać decyzji o zgodzie. Odśwież stronę i spróbuj ponownie.',
} as const;
export type MarketingConsentNotice = keyof typeof marketingConsentNotices;
