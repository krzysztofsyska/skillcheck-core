import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader } from "../components/marketing/site-header";
import { SiteFooter } from "../components/marketing/site-footer";
import { COMPANY } from "../../lib/legal";
import marketing from "../marketing.module.css";
import styles from "../rozmowa/rozmowa.module.css";

export const dynamic = "force-static";
export const metadata: Metadata = {
  title: "Kontakt — SkillCheck",
  description: "Dane firmy prowadzącej serwis SkillCheck oraz adres e-mail i telefon do obsługi zamówień, płatności i reklamacji.",
};

export default function ContactPage() {
  return <main className={marketing.page}>
    <SiteHeader />
    <article id="tresc" className={styles.content}>
      <h1>Kontakt</h1>
      <p>Serwis SkillCheck prowadzi {COMPANY.name}.</p>
      <h2>Dane firmy</h2>
      <p>
        {COMPANY.name}<br />
        {COMPANY.address}<br />
        KRS {COMPANY.krs}<br />
        NIP {COMPANY.nip}<br />
        REGON {COMPANY.regon}
      </p>
      <h2>Obsługa</h2>
      <p>
        E-mail: <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a><br />
        Telefon: <a href={COMPANY.phoneHref}>{COMPANY.phone}</a>
      </p>
      <p>Zapytanie o ofertę możesz też wysłać przez <Link href="/rozmowa">formularz kontaktowy</Link>.</p>
    </article>
    <SiteFooter />
  </main>;
}
