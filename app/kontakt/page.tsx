import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader } from "../components/marketing/site-header";
import { SiteFooter } from "../components/marketing/site-footer";
import styles from "../marketing.module.css";
import { COMPANY } from "../../lib/legal";

export const dynamic = "force-static";
export const metadata: Metadata = {
  title: "Kontakt | SkillCheck",
  description: "Dane kontaktowe i rejestrowe operatora SkillCheck: KTIG CONSULTING Sp. z o.o.",
};

export default function ContactPage() {
  return <main className={styles.page}>
    <SiteHeader />
    <div id="tresc" className={styles.wrap}>
      <section aria-labelledby="contact-title">
        <p className={styles.kicker}>SkillCheck / kontakt</p>
        <h1 id="contact-title">Kontakt</h1>
        <p className={styles.lede}>Masz pytanie o ofertę, zamówienie, płatność albo reklamację? Napisz lub zadzwoń.</p>
        <address>
          <p><strong>{COMPANY.name}</strong></p>
          <p>Adres siedziby: {COMPANY.address}</p>
          <p>NIP: {COMPANY.nip} · REGON: {COMPANY.regon} · KRS: {COMPANY.krs}</p>
          <p>Kapitał zakładowy: {COMPANY.shareCapital}</p>
          <p>E-mail: <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a></p>
          <p>Telefon: <a href={COMPANY.phoneHref}>{COMPANY.phone}</a></p>
        </address>
        <p className={styles.note}>Zasady zamówień, płatności, reklamacji i odstąpienia od umowy opisuje <Link href="/regulamin">Regulamin</Link>.
          Dane przetwarzamy zgodnie z <Link href="/polityka-prywatnosci">Polityką prywatności</Link>.
          Płatności online obsługuje PayPro S.A. (Przelewy24).</p>
      </section>
    </div>
    <SiteFooter />
  </main>;
}
