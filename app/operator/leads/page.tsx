import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "../../../lib/supabase/server";
import styles from "./leads.module.css";
import { salesLeadReplyHref } from "../../../lib/sales-lead-reply";
import { CloseLeadForm } from "./close-lead-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Zgłoszenia kontaktowe | SkillCheck",
  robots: { index: false, follow: false },
};

const dates = new Intl.DateTimeFormat("pl-PL", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Warsaw",
});

export default async function OperatorLeadsPage() {
  const client = await createClient();
  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user) redirect("/login");

  const { data: operator, error: statusError } = await client.rpc("platform_operator_status");
  if (statusError) throw new Error("Nie udało się sprawdzić dostępu.");
  if (operator !== true) notFound();

  // The RPC checks the current operator role again, including revocation after the status check.
  const { data: leads, error } = await client.rpc("list_sales_leads_inbox", { result_limit: 50 });
  if (error?.message === "sales_lead_forbidden") notFound();
  if (error || !Array.isArray(leads)) throw new Error("Nie udało się odczytać zgłoszeń.");

  return <main className={styles.page}><section className={styles.panel}>
    <nav className={styles.navigation} aria-label="Nawigacja operatora">
      <Link href="/">SkillCheck — strona główna</Link>
      <Link href="/operator/sales">Proces sprzedaży — etapy i terminy</Link>
      <a href="/operator/leads">Odśwież zgłoszenia</a>
    </nav>
    <header>
      <p className="eyebrow">PANEL OPERATORA</p>
      <h1>Zgłoszenia kontaktowe</h1>
      <p>Do 50 najnowszych zgłoszeń, od najnowszego. Daty w strefie Europe/Warsaw.</p>
      <p>„Odpowiedz e-mailem” otwiera Twoją pocztę. Wybierz konto pomoc@skillcheck.pl i wyślij odpowiedź. Panel nie wysyła wiadomości automatycznie ani nie przechowuje korespondencji.</p>
    </header>
    {leads.length === 0 ? <p className={styles.empty} role="status">Nie ma jeszcze zgłoszeń.</p> :
      <ol className={styles.list} aria-label="Zgłoszenia kontaktowe">
        {leads.map(lead => <li key={lead.id} className={styles.card}>
          <div className={styles.heading}>
            <h2>{lead.company_name}</h2>
            <span className={styles.status}>{lead.closed_at ? "Zakończone" : "Otrzymane"}</span>
          </div>
          <dl className={styles.details}>
            <div><dt>Data zgłoszenia</dt><dd><time dateTime={lead.created_at}>{dates.format(new Date(lead.created_at))}</time></dd></div>
            <div><dt>Imię</dt><dd>{lead.first_name}</dd></div>
            <div><dt>E-mail</dt><dd>{lead.email}</dd></div>
            <div><dt>Telefon</dt><dd>{lead.phone || "Nie podano"}</dd></div>
            <div className={styles.full}><dt>Opis potrzeb</dt><dd className={styles.needs}>{lead.needs}</dd></div>
            <div className={styles.full}><dt>Konto zgłaszającego</dt><dd>{lead.submitted_by || "Bez zalogowanego konta"}</dd></div>
          </dl>
          <div className={styles.actions}>
            <a className={styles.reply} href={salesLeadReplyHref(lead.email)}>Odpowiedz e-mailem</a>
          </div>
          {lead.closed_at
            ? <p>Zakończono: {dates.format(new Date(lead.closed_at))}. Usunięcie danych po 6 miesiącach.</p>
            : <CloseLeadForm id={lead.id} />}
        </li>)}
      </ol>}
  </section></main>;
}
