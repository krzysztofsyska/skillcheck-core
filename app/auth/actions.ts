"use server";

import { redirect } from "next/navigation";
import { createClient } from "../../lib/supabase/server";
import { credentials } from "../../lib/auth-validation";

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
  const client = await createClient();
  const { data, error } = await client.auth.signUp(input);
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
  // Repeated submissions should not create another company after onboarding.
  const { data: existing, error: lookupError } = await client.from("companies").select("id").limit(1);
  if (lookupError) redirect("/onboarding?message=failed");
  if (existing?.length) redirect("/dashboard");
  const { error } = await client.rpc("create_company", { company_name: name });
  if (error) redirect("/onboarding?message=failed");
  redirect("/dashboard");
}
