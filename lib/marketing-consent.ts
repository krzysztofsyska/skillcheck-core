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
}>;

/** Snapshot written into the Supabase user metadata at sign-up, so the choice
 * survives e-mail confirmation and reaches the company created afterwards. */
export function marketingConsentDeclaration(granted: boolean, now: Date = new Date()): MarketingConsentDeclaration {
  return Object.freeze({ version: MARKETING_CONSENT_VERSION, granted, declared_at: now.toISOString() });
}

/** Reads the sign-up snapshot back. Returns the version to record only when the
 * snapshot is a well-formed grant of a version this build knows; anything else
 * (absent, malformed, withdrawn, unknown version) records nothing. User metadata
 * is client-writable, so only the version is taken from it — never the wording. */
export function declaredMarketingConsent(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as { marketing_consent?: unknown }).marketing_consent;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const declaration = raw as { version?: unknown; granted?: unknown };
  if (declaration.granted !== true) return null;
  return declaration.version === MARKETING_CONSENT_VERSION ? MARKETING_CONSENT_VERSION : null;
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
