import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader } from "../components/marketing/site-header";
import { SiteFooter } from "../components/marketing/site-footer";
import styles from "../marketing.module.css";

export const metadata: Metadata = {
  title: "PRESELEKCJA — zapytanie ofertowe | SkillCheck",
  description: "Zgłoś firmę do pilotażu preselekcji CV. Przed płatnością potwierdzamy zakres usługi, dostępność, liczbę analiz i cenę.",
};

const preselectionEmail = "mailto:pomoc@skillcheck.pl?subject=" + encodeURIComponent("SkillCheck — zamówienie pilotażu PRESELEKCJA")
  + "&body=" + encodeURIComponent("Nazwa firmy:\nOsoba kontaktowa:\nStanowisko do obsadzenia:\nOrientacyjna liczba CV:\nTelefon (opcjonalnie):\n\nProszę o potwierdzenie zakresu, ceny i dostępności pilotażu PRESELEKCJA. Nie przesyłam danych kandydatów.");
const freeEmail = "mailto:pomoc@skillcheck.pl?subject=" + encodeURIComponent("SkillCheck — zgłoszenie firmy do FREE")
  + "&body=" + encodeURIComponent("Nazwa firmy:\nOsoba kontaktowa:\nSłużbowy e-mail:\nStanowisko do obsadzenia:\n\nProszę o zasady weryfikacji firmy i uruchomienia pilotażu FREE. Nie przesyłam CV ani danych kandydatów.");

export default function PreselectionOfferPage() {
  return <main className={styles.page}>
    <SiteHeader />
    <div id="tresc" className={styles.wrap}>
      <section aria-labelledby="preselection-title">
        <p className={styles.kicker}>SkillCheck / oferta pilotażowa dla firm</p>
        <h1 id="preselection-title">Zamów preselekcję kandydatów</h1>
        <p className={styles.lede}>Przygotuj profil stanowiska, porównaj zatwierdzone materiały CV z wymaganiami, przejrzyj ranking i shortlistę. Oceny AI wspierają rekrutera — nie podejmują decyzji o zatrudnieniu.</p>
        <p>Rozpoczynamy od obsługi pilotażowej przez operatora SkillCheck. Liczba analiz, zakres, cena oraz termin realizacji są potwierdzane indywidualnie <strong>przed złożeniem płatnego zamówienia</strong>. To nie jest automatyczna aktywacja pakietu.</p>
        <div className={styles.actions}>
          <a className={styles.primary} href={preselectionEmail}>Zapytaj o zakup PRESELEKCJA</a>
          <Link className={styles.secondary} href="/demo">Zobacz przykładowy raport</Link>
        </div>
      </section>
      <section aria-labelledby="pilot-process">
        <h2 id="pilot-process">Jak uruchomimy pierwszą rekrutację?</h2>
        <ol>
          <li>Wyślij nazwę firmy, stanowisko i szacowaną liczbę CV — bez danych kandydatów.</li>
          <li>Potwierdzimy możliwość realizacji, warunki przetwarzania danych i cenę.</li>
          <li>Po przyjęciu oferty uzgodnimy sposób dostarczenia dokumentów w bezpiecznym systemie. Nie przesyłaj CV zwykłym e-mailem.</li>
          <li>Wyniki, ranking, shortlistę i raport weryfikuje osoba prowadząca rekrutację.</li>
        </ol>
      </section>
      <section aria-labelledby="free-title">
        <h2 id="free-title">Chcesz najpierw wypróbować FREE?</h2>
        <p>Jednorazowy dostęp próbny wymaga weryfikacji firmy. Obecnie aktywację koordynuje operator; samo utworzenie konta nie przyznaje analiz.</p>
        <div className={styles.actions}>
          <a className={styles.secondary} href={freeEmail}>Zgłoś firmę do FREE</a>
          <Link className={styles.secondary} href="/register">Utwórz konto firmowe</Link>
        </div>
        <p className={styles.note}>Do zgłoszenia nie dołączaj życiorysów, numerów PESEL ani innych danych kandydatów. Nie pobieramy płatności na tej stronie.</p>
      </section>
    </div>
    <SiteFooter />
  </main>;
}
