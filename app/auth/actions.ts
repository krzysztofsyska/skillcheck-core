"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "../../lib/supabase/server";
import { credentials } from "../../lib/auth-validation";
import { authCallbackUrl } from "../../lib/auth-url";
import { hasLegalAcceptance, LEGAL_ACCEPTANCE_REVISION, LEGAL_ACCEPTED_DOCUMENTS, LEGAL_VERSION } from "../../lib/legal";
import { safeNextPath, withNext } from "../../lib/safe-next-path";

export async function login(form: FormData) {
  // Only an internal path is ever followed; see lib/safe-next-path.ts.
  const next = safeNextPath(form.get("next"));
  const input = credentials(form);
  if (!input) redirect(withNext("/login?message=invalid", next));
  const client = await createClient();
  const { error } = await client.auth.signInWithPassword(input);
  if (error) redirect(withNext("/login?message=failed", next));
  redirect(next ?? "/dashboard");
}
export async function register(form: FormData) {
  const next = safeNextPath(form.get("next"));
  const input = credentials(form);
  if (!input || input.password.length < 12) redirect(withNext("/register?message=invalid", next));
  if (!hasLegalAcceptance(form)) redirect(withNext("/register?message=terms", next));
  let emailRedirectTo: string;
  try { emailRedirectTo = authCallbackUrl('signup', (await headers()).get('origin')); }
  catch { redirect(withNext('/register?message=unavailable', next)); }
  const client = await createClient();
  const { data, error } = await client.auth.signUp({ ...input, options: {
    emailRedirectTo,
    // Server-set record of the accepted Regulamin + DPA + privacy notice + Annex 1 (voice) version.
    data: { legal_acceptance: { version: LEGAL_VERSION, revision: LEGAL_ACCEPTANCE_REVISION, documents: [...LEGAL_ACCEPTED_DOCUMENTS], accepted_at: new Date().toISOString() } },
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
  // A pending purchase path wins: it resolves the new company itself.
  if (next) redirect(next);
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
  try { redirectTo = authCallbackUrl('recovery', (await headers()).get('origin')); } catch { redirect("/forgot-password?message=unavailable"); }
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
