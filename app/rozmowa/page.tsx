import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader } from "../components/marketing/site-header";
import { SiteFooter } from "../components/marketing/site-footer";
import marketing from "../marketing.module.css";
import styles from "./rozmowa.module.css";
import { LeadForm } from "./lead-form";
import { calculatorSelection } from "./selection";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Porozmawiajmy o Twojej rekrutacji — SkillCheck" };

export default async function ConversationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const selection = calculatorSelection(await searchParams);
  const email = "mailto:pomoc@skillcheck.pl" + (selection ? "?subject=" + encodeURIComponent("SkillCheck — zapytanie z kalkulatora") + "&body=" + encodeURIComponent(selection) : "");
  const notice = process.env.SALES_LEAD_NOTICE?.trim() ?? "";
  const enabled = process.env.SALES_LEADS_ENABLED === "true" && notice.length > 0
    && Buffer.byteLength(process.env.SALES_LEAD_REQUEST_SECRET ?? "") >= 32;
  return (
    <main className={marketing.page}>
      <SiteHeader />
      <div id="tresc" className={styles.content}>
        <h1>Porozmawiajmy o Twojej rekrutacji</h1>
        <p>Opisz potrzeby firmy i zostaw dane do kontaktu. Zgłoszenie nie rezerwuje terminu rozmowy, nie zakłada konta i nie aktywuje pakietu.</p>
        {selection && <section aria-label="Wybór z kalkulatora"><h2>Twój wybór do potwierdzenia</h2><p style={{ whiteSpace: "pre-line" }}>{selection}</p><Link href="/kalkulator">Wróć do kalkulatora</Link></section>}
        {enabled ? <LeadForm key={selection} notice={notice} initialNeeds={selection} /> : <p className={styles.panel} role="status">Formularz nie przyjmuje teraz zgłoszeń. Napisz do nas: <a href={email}>pomoc@skillcheck.pl</a>.{selection && " Link do poczty zawiera Twój wybór. Samo otwarcie wiadomości nie wysyła zgłoszenia."}</p>}
        <Link href="/demo" className={marketing.secondary}>Zobacz przykład</Link>
      </div>
      <SiteFooter />
    </main>
  );
}
