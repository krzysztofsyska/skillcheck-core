import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader } from "../components/marketing/site-header";
import { SiteFooter } from "../components/marketing/site-footer";
import styles from "../marketing.module.css";
import { preselekcjaOffer, preselekcjaPrice, preselekcjaScope } from "../components/marketing/preselekcja-offer";

export const metadata: Metadata = {
  title: "PRESELEKCJA — 60 analiz CV za 300 zł brutto | SkillCheck",
  description: "Pakiet PRESELEKCJA: 60 analiz CV za 300 zł brutto, ważnych 3 miesiące. Płatność przelewem na podstawie faktury proforma lub online przez Przelewy24.",
};

const preselectionEmail = "mailto:pomoc@skillcheck.pl?subject=" + encodeURIComponent("SkillCheck — PRESELEKCJA: prośba o fakturę proforma")
  + "&body=" + encodeURIComponent(`Nazwa firmy:\r\nNIP:\r\nAdres e-mail konta w SkillCheck:\r\n\r\nProszę o fakturę proforma za pakiet PRESELEKCJA (${preselekcjaScope}, ${preselekcjaPrice}). Nie przesyłam CV ani danych kandydatów.`);
const freeEmail = "mailto:pomoc@skillcheck.pl?subject=" + encodeURIComponent("SkillCheck — zgłoszenie firmy do FREE")
  + "&body=" + encodeURIComponent("Branża firmy (opcjonalnie):\r\nNazwa stanowiska:\r\n\r\nProszę o warunki weryfikacji firmy i ewentualny dostęp próbny FREE. Nie przesyłam danych osobowych ani CV kandydatów.");

export default function PreselectionOfferPage() {
  return <main className={styles.page}>
    <SiteHeader />
    <div id="tresc" className={styles.wrap}>
      <section aria-labelledby="preselection-title">
        <p className={styles.kicker}>SkillCheck / oferta dla firm</p>
        <h1 id="preselection-title">PRESELEKCJA — {preselekcjaScope} za {preselekcjaPrice}</h1>
        <p className={styles.lede}>Porównujemy kompetencje udokumentowane w CV z wymaganiami stanowiska i pomagamy przygotować shortlistę kandydatów do dalszej rozmowy. Oceny AI mają wspierać rekrutera — nie podejmują decyzji o zatrudnieniu.</p>
        <ul>
          <li><strong>Cena:</strong> {preselekcjaPrice} ({preselekcjaOffer.netPln} zł netto + 23% VAT), płatność jednorazowa.</li>
          <li><strong>Zakres:</strong> {preselekcjaScope} w ramach jednego pakietu.</li>
          <li><strong>Ważność:</strong> analizy są ważne przez {preselekcjaOffer.validityMonths} miesiące od dnia ich przyznania.</li>
          <li><strong>Płatność:</strong> przelew na podstawie faktury proforma albo online przez Przelewy24 (szybki przelew, BLIK, karta), gdy płatność online jest dostępna w panelu. Operatorem płatności online jest PayPro S.A., ul. Pastelowa 8, 60-198 Poznań.</li>
          <li><strong>Przyznanie analiz:</strong> po potwierdzeniu płatności — przy płatności online zwykle w ciągu kilku minut, przy przelewie najpóźniej w ciągu 2 dni roboczych od uznania naszego rachunku.</li>
          <li><strong>Faktura:</strong> po zaksięgowaniu płatności wystawiamy fakturę VAT i wysyłamy ją e-mailem.</li>
        </ul>
        <p>Zasady zamówienia, reklamacji i odstąpienia opisuje <Link href="/regulamin">Regulamin</Link>. Dane przetwarzamy zgodnie z <Link href="/polityka-prywatnosci">Polityką prywatności</Link>.</p>
        <div className={styles.actions}>
          <a className={styles.primary} href={preselectionEmail}>Poproś o fakturę proforma</a>
          <Link className={styles.secondary} href="/demo">Zobacz przykładowy raport</Link>
        </div>
      </section>
      <section aria-labelledby="pilot-process">
        <h2 id="pilot-process">Jak zamówić?</h2>
        <ol>
          <li>Załóż konto firmowe w SkillCheck i zaakceptuj Regulamin.</li>
          <li>Napisz do nas z nazwą firmy, NIP i adresem e-mail konta — wystawimy fakturę proforma.</li>
          <li>Po zaksięgowaniu wpłaty uruchomimy pakiet na Twoim koncie firmowym i wyślemy fakturę VAT.</li>
          <li>Dokumenty kandydatów dodajesz w bezpiecznym panelu SkillCheck. Nie przesyłaj CV zwykłym e-mailem.</li>
        </ol>
        <p>Wyniki, ranking i shortlistę zawsze weryfikuje osoba prowadząca rekrutację.</p>
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
