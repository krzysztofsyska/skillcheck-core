import { redirect } from "next/navigation";
import { createClient } from "../../lib/supabase/server";
import { createCompany, logout } from "../auth/actions";
import { SubmitButton } from "../components/submit-button";
export default async function Onboarding({ searchParams }: { searchParams: Promise<{ message?: string }> }) {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) redirect("/login");
  const { data, error } = await client.from("companies").select("id").limit(1);
  if (error) throw new Error("Nie udało się odczytać firm. Spróbuj ponownie.");
  if (data.length) redirect("/dashboard");
  const { message } = await searchParams;
  return <main><section className="auth"><p className="eyebrow">SKILLCHECK</p><h1>Twoja firma</h1>
    <p>Podaj nazwę firmy, dla której prowadzisz rekrutacje.</p>
    {message && <p role="alert" className="notice">Nie udało się zapisać firmy. Sprawdź nazwę i spróbuj ponownie.</p>}
    <form action={createCompany}><label>Nazwa firmy<input name="name" autoComplete="organization" required maxLength={200} /></label><SubmitButton>Utwórz firmę</SubmitButton></form>
    <form action={logout}><SubmitButton>Wyloguj się</SubmitButton></form>
  </section></main>;
}
