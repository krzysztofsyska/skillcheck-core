"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "../../lib/supabase/server";
import { credentials } from "../../lib/auth-validation";
import { authCallbackUrl } from "../../lib/auth-url";

export async function login(form: FormData) {
  const input = credentials(form);
  if (!input) redirect("/login?message=invalid");
  const client = await createClient();
  const { error } = await client.auth.signInWithPassword(input);
  if (error) redirect("/login?message=failed");
  redirect("/dashboard");
}
export async function register(form: FormData) {
  const input = credentials(form);
  if (!input || input.password.length < 12) redirect("/register?message=invalid");
  let emailRedirectTo: string;
  try { emailRedirectTo = authCallbackUrl('signup', (await headers()).get('origin')); }
  catch { redirect('/register?message=unavailable'); }
  const client = await createClient();
  const { data, error } = await client.auth.signUp({ ...input, options: { emailRedirectTo } });
  if (error) redirect("/register?message=failed");
  if (data.session) redirect("/onboarding");
  redirect("/login?message=confirm");
}
export async function logout() {
  const client = await createClient();
  const { error } = await client.auth.signOut({ scope: "local" });
  if (error) redirect("/dashboard?message=logout");
  redirect("/login");
}
export async function createCompany(form: FormData) {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) redirect("/login");
  const name = String(form.get("name") ?? "").trim();
  if (!name || name.length > 200) redirect("/onboarding?message=invalid");
  const { error } = await client.rpc("ensure_initial_company", { company_name: name });
  if (error) redirect("/onboarding?message=failed");
  redirect("/dashboard");
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
