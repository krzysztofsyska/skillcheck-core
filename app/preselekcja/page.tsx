import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader } from "../components/marketing/site-header";
import { SiteFooter } from "../components/marketing/site-footer";
import styles from "../marketing.module.css";
import { loadPublicOffer, preselekcjaOffer, preselekcjaPrice } from "../components/marketing/preselekcja-offer";
import { sc19PolicyPendingScope } from "../../lib/sc19-package-sizes";

// The PRESELEKCJA count follows the SC-019 catalog flag and policy per request,
// as on the home page.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "PRESELEKCJA — oferta i cena | SkillCheck",
  description: "Pakiet PRESELEKCJA za 300 zł brutto, analizy ważne 3 miesiące. Płatność przelewem na podstawie faktury proforma.",
};

const preselectionEmail = (scope: string | null) => "mailto:pomoc@skillcheck.pl?subject=" + encodeURIComponent("SkillCheck — PRESELEKCJA: prośba o fakturę proforma")
  + "&body=" + encodeURIComponent(`Nazwa firmy:\r\nNIP:\r\nAdres e-mail konta w SkillCheck:\r\n\r\nProszę o fakturę proforma za pakiet PRESELEKCJA (${scope ? `${scope}, ` : ""}${preselekcjaPrice}). Nie przesyłam CV ani danych kandydatów.`);
const freeEmail = "mailto:pomoc@skillcheck.pl?subject=" + encodeURIComponent("SkillCheck — zgłoszenie firmy do FREE")
  + "&body=" + encodeURIComponent("Nazwa firmy:\r\nNIP:\r\nAdres e-mail konta w SkillCheck (firmowy):\r\nBranża firmy (opcjonalnie):\r\nNazwa stanowiska:\r\n\r\nProszę o warunki weryfikacji firmy i dostęp próbny FREE. Nie przesyłam danych osobowych ani CV kandydatów.");

export default async function PreselectionOfferPage() {
  // catalogEnabled is SC19_PACKAGES_ENABLED, the same release switch the company
  // panel reads. With it off the dashboard hides the Pakiety entry and
  // billing/checkout only shows a "not available yet" notice, so a public CTA
  // promising an order in the panel would send a prospect to a dead end.
  // The CTA is therefore kept but stated as what it really is while the switch is
  // off — registration only — rather than hidden: creating the company account is
  // a real next step (the operator activates the package on that account after the
  // transfer), so removing it would make the page less useful, not more honest.
  const { preselekcja, catalogEnabled } = await loadPublicOffer();
  const scope = preselekcja === null ? null : `${preselekcja} analiz CV`;
  return <main className={styles.page}>
    <SiteHeader />
    <div id="tresc" className={styles.wrap}>
      <section aria-labelledby="preselection-title">
        <p className={styles.kicker}>SkillCheck / oferta dla firm</p>
        <h1 id="preselection-title">{scope ? `PRESELEKCJA — ${scope} za ${preselekcjaPrice}` : `PRESELEKCJA — ${preselekcjaPrice}`}</h1>
        <p className={styles.lede}>Porównujemy kompetencje udokumentowane w CV z wymaganiami stanowiska i pomagamy przygotować shortlistę kandydatów do dalszej rozmowy. Oceny AI mają wspierać rekrutera — nie podejmują decyzji o zatrudnieniu.</p>
        <ul>
          <li><strong>Cena:</strong> {preselekcjaPrice} ({preselekcjaOffer.netPln} zł netto + 23% VAT), płatność jednorazowa.</li>
          <li><strong>Zakres:</strong> {scope ? `${scope} w ramach jednego pakietu.` : `${sc19PolicyPendingScope}.`}</li>
          <li><strong>Ważność:</strong> analizy są ważne przez {preselekcjaOffer.validityMonths} miesiące od dnia ich przyznania.</li>
          <li><strong>Płatność:</strong> przelew na podstawie faktury proforma — napisz do nas, a wystawimy ją od razu. Płatność online Przelewy24 jest przygotowywana; udostępnimy ją w koncie firmy, gdy będzie gotowa.</li>
          <li><strong>Przyznanie analiz:</strong> po potwierdzeniu płatności — najpóźniej w ciągu 2 dni roboczych od uznania naszego rachunku.</li>
          <li><strong>Faktura:</strong> po zaksięgowaniu płatności wystawiamy fakturę VAT i wysyłamy ją e-mailem.</li>
        </ul>
        <p>Zasady zamówienia, reklamacji i odstąpienia opisuje <Link href="/regulamin">Regulamin</Link>. Dane przetwarzamy zgodnie z <Link href="/polityka-prywatnosci">Polityką prywatności</Link>.</p>
        <div className={styles.actions}>
          <a className={styles.primary} href={preselectionEmail(scope)}>Poproś o fakturę proforma</a>
          <Link className={styles.secondary} href="/register">{catalogEnabled ? "Zamów w panelu firmy" : "Załóż konto firmowe"}</Link>
          <Link className={styles.secondary} href="/demo">Zobacz przykładowy raport</Link>
        </div>
        {catalogEnabled
          ? <p className={styles.note}>Zamówienie w panelu firmy: zaloguj się, wybierz firmę, otwórz <strong>Pakiety</strong> i przejdź do zakupu PRESELEKCJI. Zakup może złożyć wyłącznie właściciel konta firmy. Masz już konto? <Link href="/login">Zaloguj się</Link>.</p>
          : <p className={styles.note}>Konto firmowe służy na razie tylko do rejestracji — zamówienia w panelu firmy jeszcze nie składasz. Pakiet uruchamiamy na Twoim koncie po zaksięgowaniu wpłaty z faktury proforma. Masz już konto? <Link href="/login">Zaloguj się</Link>.</p>}
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
        <h2 id="free-title">Wypróbuj FREE — 0 zł</h2>
        <p>Bezpłatna analiza CV na własnych dokumentach, jedna próba na firmę. Do zgłoszenia potrzebny jest numer NIP i firmowy adres e-mail. Jednorazowy dostęp próbny wymaga weryfikacji firmy. Obecnie aktywację koordynuje operator; samo utworzenie konta nie przyznaje analiz.</p>
        <p>FREE jest opcjonalnym pierwszym krokiem, a nie warunkiem zakupu PRESELEKCJI.</p>
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
