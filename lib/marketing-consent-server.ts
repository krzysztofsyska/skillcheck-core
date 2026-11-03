import 'server-only';
/** Server entry point for the SC-CONSENT-001 signed registration snapshot. The
 * logic lives in ./marketing-consent-signing.ts, which carries no 'server-only'
 * guard so that tests can exercise it directly; this module is what application
 * code imports, and the guard keeps the server secret it reads out of any client
 * bundle. Same split as ./sc19-trial-auto-server.ts. */
export {
  signedConsentDeclaration, signRegistrationConsentGrant, verifiedConsentVersion,
} from './marketing-consent-signing.ts';
export type { RegistrationConsentRequest } from './marketing-consent-signing.ts';
