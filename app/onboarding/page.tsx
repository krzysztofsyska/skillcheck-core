import { redirect } from "next/navigation";
import { createClient } from "../../lib/supabase/server";
import { createCompany, logout } from "../auth/actions";
import { SubmitButton } from "../components/submit-button";
import { safeNextPath } from "../../lib/safe-next-path";
export default async function Onboarding({ searchParams }: { searchParams: Promise<{ message?: string; next?: string }> }) {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) redirect("/login");
  const { data, error } = await client.from("companies").select("id").limit(1);
  if (error) throw new Error("Nie udało się odczytać firm. Spróbuj ponownie.");
  const { message, next: nextParam } = await searchParams;
  const next = safeNextPath(nextParam);
  // An existing company means the pending purchase path can resolve it already.
  if (data.length) redirect(next && !next.startsWith("/onboarding") ? next : "/dashboard");
  return <main><section className="auth"><p className="eyebrow">SKILLCHECK</p><h1>Twoja firma</h1>
    <p>Podaj nazwę firmy, dla której prowadzisz rekrutacje.</p>
    {message && <p role="alert" className="notice">Nie udało się zapisać firmy. Sprawdź nazwę i spróbuj ponownie.</p>}
    <form action={createCompany}>{next && <input type="hidden" name="next" value={next} />}<label>Nazwa firmy<input name="name" autoComplete="organization" required maxLength={200} /></label><SubmitButton>Utwórz firmę</SubmitButton></form>
    <form action={logout}><SubmitButton>Wyloguj się</SubmitButton></form>
  </section></main>;
}
