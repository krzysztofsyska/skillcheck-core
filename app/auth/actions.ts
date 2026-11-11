"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "../../lib/supabase/server";
import { credentials } from "../../lib/auth-validation";
import { TENANT_HOST_HEADER, authCallbackUrl, tenantOriginFromHeader } from "../../lib/auth-url";
import { hasLegalAcceptance, LEGAL_ACCEPTANCE_REVISION, LEGAL_ACCEPTED_DOCUMENTS, LEGAL_VERSION } from "../../lib/legal";
import { hasMarketingConsent } from "../../lib/marketing-consent";
import { signedConsentDeclaration, signRegistrationConsentGrant, verifiedConsentVersion } from "../../lib/marketing-consent-server";
import { nextRedirectTarget, safeNextPath, withNext } from "../../lib/safe-next-path";

export async function login(form: FormData) {
  // Only an internal path is ever followed; see lib/safe-next-path.ts.
  const next = safeNextPath(form.get("next"));
  const input = credentials(form);
  if (!input) redirect(withNext("/login?message=invalid", next));
  const client = await createClient();
  const { error } = await client.auth.signInWithPassword(input);
  if (error) redirect(withNext("/login?message=failed", next));
  redirect(nextRedirectTarget(next, "/dashboard"));
}
export async function register(form: FormData) {
  const next = safeNextPath(form.get("next"));
  const input = credentials(form);
  if (!input || input.password.length < 12) redirect(withNext("/register?message=invalid", next));
  if (!hasLegalAcceptance(form)) redirect(withNext("/register?message=terms", next));
  let emailRedirectTo: string;
  try { const h = await headers(); emailRedirectTo = authCallbackUrl('signup', h.get('origin'), process.env, next, tenantOriginFromHeader(h.get(TENANT_HOST_HEADER))); }
  catch { redirect(withNext('/register?message=unavailable', next)); }
  const client = await createClient();
  const { data, error } = await client.auth.signUp({ ...input, options: {
    emailRedirectTo,
    // Server-set record of the accepted Regulamin + DPA + privacy notice version (see lib/legal.ts for the revision history).
    data: {
      legal_acceptance: { version: LEGAL_VERSION, revision: LEGAL_ACCEPTANCE_REVISION, documents: [...LEGAL_ACCEPTED_DOCUMENTS], accepted_at: new Date().toISOString() },
      // SC-CONSENT-001: the optional marketing consent is recorded against a
      // company, and the company does not exist yet (it is created in
      // /onboarding, possibly after e-mail confirmation). This snapshot carries
      // the choice across; createCompany below turns it into the ledger entry.
      // User metadata is CLIENT-WRITABLE, so the snapshot is HMAC-signed with
      // the server secret and bound to this address: a user who left the box
      // unticked cannot set granted=true afterwards and have it recorded. Only
      // the VERSION is ever read back from here; the wording comes from the
      // database.
      marketing_consent: signedConsentDeclaration(hasMarketingConsent(form), input.email),
    },
  } });
  if (error) redirect(withNext("/register?message=failed", next));
  if (data.session) redirect(withNext("/onboarding", next));
  redirect(withNext("/login?message=confirm", next));
}
export async function logout() {
  const client = await createClient();
  const { error } = await client.auth.signOut({ scope: "local" });
  if (error) redirect("/dashboard?message=logout");
  redirect("/login");
}
export async function createCompany(form: FormData) {
  const next = safeNextPath(form.get("next"));
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) redirect(withNext("/login", next));
  const name = String(form.get("name") ?? "").trim();
  if (!name || name.length > 200) redirect(withNext("/onboarding?message=invalid", next));
  const { data: companyId, error } = await client.rpc("ensure_initial_company", { company_name: name });
  if (error) redirect(withNext("/onboarding?message=failed", next));
  // SC-CONSENT-001: bind the registration-time consent to the new company, but
  // ONLY if the snapshot's HMAC verifies for this account. An unsigned, wrongly
  // signed or edited snapshot records nothing, so the ledger never certifies a
  // consent the user did not give; the owner can still give it in one click in
  // /dashboard/<id>/zgody. A failure here must not block the company, and
  // nothing is sent anywhere: the consent is only recorded.
  //
  // TWO signatures, and both are needed. The snapshot one above proves the user
  // really ticked the box at sign-up. The one made here proves to the DATABASE
  // that this grant came through this server path: the RPC no longer takes the
  // source as a parameter, and 'registration' is written only against a request
  // signed with the server secret, so an owner calling the Data API himself
  // cannot have the ledger attribute his consent to registration.
  //
  // AND IT IS ONE-SHOT, GUARANTEED BY THE DATABASE (review finding, bot
  // 2026-11-03). Neither signature expires or is spent, ensure_initial_company
  // returns the EXISTING company when this action runs again, and a Server Action
  // can be invoked from any route — so this call can be replayed at any time,
  // including after the owner has withdrawn the consent in /dashboard/<id>/zgody.
  // That must not resurrect the consent, and must not have the append-only ledger
  // certify "given at registration" long after the sign-up form was gone. The
  // check is not made here, because ensure_initial_company returns only a uuid
  // and cannot tell us whether it created the company: it is made in the
  // database, where it also binds a caller going straight to the Data API.
  // private.marketing_consent_record accepts a registration row only as the first
  // event in that company's ledger, and the partial unique index
  // marketing_consent_one_registration_per_company enforces "at most one" even
  // for two simultaneous replays. A replay therefore fails with
  // marketing_consent_registration_not_first, which is logged below and changes
  // nothing — re-granting after a withdrawal is the panel's job, under its own
  // source 'company_panel'.
  //
  // AND IT IS DATED WHEN THE CUSTOMER GAVE IT, NOT WHEN THE COMPANY WAS CREATED
  // (review finding, bot 2026-11-03). The box is ticked at sign-up; this action
  // runs at onboarding, after e-mail confirmation, so the two moments can be days
  // apart. The ledger has to prove WHEN the consent was given, so the snapshot's
  // own verified timestamp is passed through and stored as the event time. It is
  // covered by the snapshot's HMAC and by the request signature made here, so
  // neither the browser nor an owner calling the Data API can choose it.
  const consent = verifiedConsentVersion(user.user_metadata, user.email);
  const signedGrant = consent && typeof companyId === "string"
    ? signRegistrationConsentGrant(companyId, consent.version, consent.declaredAt) : null;
  if (consent && signedGrant && typeof companyId === "string") {
    const { data: storedAt, error: consentError } = await client.rpc("marketing_consent_grant_registration", {
      target_company: companyId, consent_version: consent.version,
      declared_at: signedGrant.declaredAt,
      request_id: signedGrant.requestId, issued_at_ms: signedGrant.issuedAtMs,
      request_signature: signedGrant.signature,
    });
    if (consentError) console.warn("marketing_consent_registration_failed", consentError.code ?? "-");
    // The database keeps the consent even when it refuses the declared time (out
    // of range, or none), stamping the row with its own clock instead. That is
    // deliberate — a consent must not be lost over a clock — but it is worth
    // knowing about, so the difference is logged. No date, address or id is
    // logged, only that an adjustment happened.
    else if (signedGrant.declaredAt && typeof storedAt === "string"
      && Date.parse(storedAt) !== Date.parse(signedGrant.declaredAt)) {
      console.warn("marketing_consent_declared_at_adjusted");
    }
  }
  // A pending purchase path wins: it resolves the new company itself. It is
  // taken AFTER the consent above, not before: a company arriving through the
  // purchase path gave its consent at sign-up like any other, and an early
  // redirect here would silently drop it.
  if (next) redirect(nextRedirectTarget(next, "/dashboard"));
  // Open the new company's dashboard straight away; fall back to the list for an unexpected value.
  redirect(typeof companyId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId) ? `/dashboard/${companyId}` : "/dashboard");
}

export async function requestPasswordReset(form: FormData) {
  const email = String(form.get("email") ?? "").trim();
  const validation = new FormData();
  validation.set("email", email);
  validation.set("password", "validation-only");
  if (!credentials(validation)) redirect("/forgot-password?message=invalid");
  let redirectTo: string;
  try { const h = await headers(); redirectTo = authCallbackUrl('recovery', h.get('origin'), process.env, undefined, tenantOriginFromHeader(h.get(TENANT_HOST_HEADER))); } catch { redirect("/forgot-password?message=unavailable"); }
  const client = await createClient();
  const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
  if (error?.code === "over_email_send_rate_limit") redirect("/forgot-password?message=rate-limit");
  if (error) redirect("/forgot-password?message=unavailable");
  redirect("/forgot-password?message=sent");
}

export async function changePassword(form: FormData) {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) redirect("/forgot-password?message=expired");
  const password = String(form.get("password") ?? "");
  if (password.length < 12 || password.length > 256 || password !== form.get("confirmation")) redirect("/reset-password?message=invalid");
  const { error } = await client.auth.updateUser({ password });
  if (error) redirect("/reset-password?message=failed");
  redirect("/dashboard?message=password-updated");
}
