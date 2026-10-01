import { redirect } from "next/navigation";
import { createClient } from "../../lib/supabase/server";
import { logout } from "../auth/actions";
import { SubmitButton } from "../components/submit-button";
export default async function Dashboard({ searchParams }: { searchParams: Promise<{ message?: string }> }) {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) redirect("/login");
  const { data: companies, error } = await client.from("companies").select("id,name").order("name");
  if (error) throw new Error("Nie udało się odczytać firm. Spróbuj ponownie.");
  if (!companies.length) redirect("/onboarding");
  const { message } = await searchParams;
  return <main><section><p className="eyebrow">SKILLCHECK</p><h1>Twoje firmy</h1>
    <p>Jesteś zalogowany jako {user.email}.</p>
    <ul className="companies">{companies.map(company => <li key={company.id}>{company.name}</li>)}</ul>
    <p className="lead">Tutaj będziesz zarządzać stanowiskami, rekrutacjami i ocenami kandydatów.</p>
    {message === "logout" && <p role="alert">Wylogowanie nie powiodło się. Spróbuj ponownie.</p>}
    <form action={logout}><SubmitButton>Wyloguj się</SubmitButton></form>
  </section></main>;
}
