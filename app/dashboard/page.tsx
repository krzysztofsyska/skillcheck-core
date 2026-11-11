import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "../../lib/supabase/server";
import { logout } from "../auth/actions";
import { SubmitButton } from "../components/submit-button";
import { nextRedirectTarget, safeNextPath, withNext } from "../../lib/safe-next-path";
import { TENANT_COMPANY_HEADER } from "../../lib/auth-url";
export default async function Dashboard({ searchParams }: { searchParams: Promise<{ message?: string; next?: string }> }) {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) redirect("/login");
  const { data: allCompanies, error } = await client.from("companies").select("id,name").order("name");
  if (error) throw new Error("Nie udało się odczytać firm. Spróbuj ponownie.");
  // SC-020-B: on a customer's domain (header set only by proxy.ts) this page lists only that
  // company and never sends anyone to create another one; it stays reachable for logging out.
  const tenant = (await headers()).get(TENANT_COMPANY_HEADER);
  const companies = tenant ? allCompanies.filter(company => company.id === tenant) : allCompanies;
  const { message, next: nextParam } = await searchParams;
  const next = safeNextPath(nextParam);
  // SC-BUY-002: the purchase target arrives here after e-mail confirmation, so it
  // must reach onboarding too — a new account has no company yet and would
  // otherwise finish in the company list instead of on the checkout screen.
  if (!companies.length && !tenant) redirect(withNext("/onboarding", next));
  // An account that already has a company can go straight to the target.
  // "/dashboard" itself is excluded, because that would loop.
  // SC-020-D: on a customer's domain an account without access to that company stays here (with the
  // notice and the logout button) instead of following `next` to a page it cannot open on this host.
  const blockedOnTenant = Boolean(tenant) && !companies.length;
  if (next && !blockedOnTenant && next !== "/dashboard" && !next.startsWith("/dashboard?")) redirect(nextRedirectTarget(next, "/dashboard"));
  return <main><section><p className="eyebrow">SKILLCHECK</p><h1>Twoje firmy</h1>
    <p>Jesteś zalogowany jako {user.email}.</p>
    {tenant && !companies.length && <p role="status" className="notice">To konto nie ma dostępu do panelu tej firmy. Wyloguj się i zaloguj kontem firmy.</p>}
    <ul className="companies">{companies.map(company => <li key={company.id}><Link href={`/dashboard/${company.id}`}>{company.name} →</Link></li>)}</ul>
    <p className="lead">Tutaj będziesz zarządzać stanowiskami, rekrutacjami i ocenami kandydatów.</p>
    {message === "logout" && <p role="alert">Wylogowanie nie powiodło się. Spróbuj ponownie.</p>}
    {message === "password-updated" && <p role="status" className="notice">Hasło zostało zmienione.</p>}
    {message === "owner-required" && <p role="status" className="notice">Pakiet PRESELEKCJA zamawia właściciel firmy. Poproś o to osobę, która założyła firmę w SkillCheck, albo załóż własną firmę.</p>}
    <form action={logout}><SubmitButton>Wyloguj się</SubmitButton></form>
  </section></main>;
}
