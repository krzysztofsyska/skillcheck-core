import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader } from "../components/marketing/site-header";
import { SiteFooter } from "../components/marketing/site-footer";
import styles from "../marketing.module.css";

export const metadata: Metadata = {
  title: "PRESELEKCJA — zapytanie ofertowe | SkillCheck",
  description: "Zgłoś firmę do pilotażu preselekcji CV. Przed płatnością potwierdzamy zakres usługi, dostępność, liczbę analiz i cenę.",
};

const preselectionEmail = "mailto:pomoc@skillcheck.pl?subject=" + encodeURIComponent("SkillCheck — zapytanie o dostępność PRESELEKCJA")
  + "&body=" + encodeURIComponent("Branża firmy (opcjonalnie):\r\nNazwa stanowiska:\r\nSzacowana liczba CV (bez dokumentów):\r\n\r\nProszę o informację, czy możliwy jest pilotaż PRESELEKCJA oraz o proponowany zakres i warunki. Nie przesyłam danych osobowych ani CV kandydatów.");
const freeEmail = "mailto:pomoc@skillcheck.pl?subject=" + encodeURIComponent("SkillCheck — zgłoszenie firmy do FREE")
  + "&body=" + encodeURIComponent("Branża firmy (opcjonalnie):\r\nNazwa stanowiska:\r\n\r\nProszę o warunki weryfikacji firmy i ewentualny dostęp próbny FREE. Nie przesyłam danych osobowych ani CV kandydatów.");

export default function PreselectionOfferPage() {
  return <main className={styles.page}>
    <SiteHeader />
    <div id="tresc" className={styles.wrap}>
      <section aria-labelledby="preselection-title">
        <p className={styles.kicker}>SkillCheck / oferta pilotażowa dla firm</p>
        <h1 id="preselection-title">Zapytaj o preselekcję kandydatów</h1>
        <p className={styles.lede}>Planujemy pilotaż porównujący kompetencje udokumentowane w CV z wymaganiami stanowiska. Dostępność analizy AI, rankingu i shortlisty potwierdzamy indywidualnie przed ofertą; aktualnie te funkcje nie są udostępnione do samodzielnego użycia przez nowych klientów. Oceny AI mają wspierać rekrutera — nie podejmują decyzji o zatrudnieniu.</p>
        <p>Rozpoczynamy od obsługi pilotażowej przez operatora SkillCheck. Liczba analiz, zakres, cena oraz termin realizacji są potwierdzane indywidualnie <strong>przed złożeniem płatnego zamówienia</strong>. To nie jest automatyczna aktywacja pakietu.</p>
        <div className={styles.actions}>
          <a className={styles.primary} href={preselectionEmail}>Zapytaj o dostępność PRESELEKCJA</a>
          <Link className={styles.secondary} href="/demo">Zobacz przykładowy raport</Link>
        </div>
      </section>
      <section aria-labelledby="pilot-process">
        <h2 id="pilot-process">Jak uruchomimy pierwszą rekrutację?</h2>
        <ol>
          <li>Wyślij zapytanie z branżą, nazwą stanowiska i szacowaną liczbą CV, bez nazwisk, danych kontaktowych i CV kandydatów.</li>
          <li>Potwierdzimy możliwość realizacji, warunki przetwarzania danych i cenę.</li>
          <li>Po przyjęciu oferty uzgodnimy sposób dostarczenia dokumentów w bezpiecznym systemie. Nie przesyłaj CV zwykłym e-mailem.</li>
          <li>Jeżeli potwierdzimy dostępność tych funkcji w uzgodnionym pilotażu, wyniki, ranking, shortlistę i raport będzie weryfikować osoba prowadząca rekrutację.</li>
        </ol>
      </section>
      <section id="free" aria-labelledby="free-title">
        <h2 id="free-title">Chcesz najpierw wypróbować FREE?</h2>
        <p>Jednorazowy dostęp próbny wymaga weryfikacji firmy. Obecnie aktywację koordynuje operator; samo utworzenie konta nie przyznaje analiz.</p>
        <div className={styles.actions}>
          <a className={styles.secondary} href={freeEmail}>Zgłoś firmę do FREE</a>
          <Link className={styles.secondary} href="/register">Utwórz konto firmowe</Link>
        </div>
        <p className={styles.note}>Do wiadomości nie dołączaj danych osobowych — ani kandydatów, ani osób kontaktowych. Aby ustalić zasady dalszego kontaktu, korzystaj z zatwierdzonych kanałów SkillCheck. Nie pobieramy płatności na tej stronie.</p>
      </section>
    </div>
    <SiteFooter />
  </main>;
}
