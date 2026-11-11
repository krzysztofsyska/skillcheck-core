// DRAFT — legal summary, requires owner acceptance before production (SC-P24-VERIFY-002).
// Every statement below restates the Regulamin (docs/legal/v1.0/01_Regulamin_SkillCheck.md) and adds no terms
// of its own. One deliberate difference: the payment-method status follows the offer pages (transfer only
// today, Przelewy24 being prepared), while Regulamin § 7 ust. 1 lists online payment as available.
// Company data comes from lib/legal.ts, price and scope from the PRESELEKCJA offer.
import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader } from "../components/marketing/site-header";
import { SiteFooter } from "../components/marketing/site-footer";
import { loadPublicOffer, preselekcjaOffer, preselekcjaPrice } from "../components/marketing/preselekcja-offer";
import { COMPANY, LEGAL_DOCUMENTS } from "../../lib/legal";
import { isPublicFutureOffersEnabled } from "../../lib/public-future-offers";
import marketing from "../marketing.module.css";
import styles from "../rozmowa/rozmowa.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Płatności, reklamacje i odstąpienie od umowy — SkillCheck",
  description: "Krótkie podsumowanie Regulaminu sklepu SkillCheck: co kupujesz, jak płacisz, kiedy dostajesz analizy, jak złożyć reklamację i odstąpić od umowy.",
};

const full = (paragraph: string) => <p><strong>Pełne zasady:</strong> <Link href={LEGAL_DOCUMENTS.regulamin.href}>{`Regulamin, ${paragraph}`}</Link></p>;

export default async function PaymentsAndComplaintsPage() {
  const { preselekcja } = await loadPublicOffer();
  const scope = preselekcja === null ? null : `${preselekcja} analiz CV`;
  return <main className={marketing.page}>
    <SiteHeader />
    <article id="tresc" className={styles.content}>
      <h1>Płatności, reklamacje i odstąpienie od umowy</h1>
      <p>To krótkie podsumowanie. Wiążące są zapisy <Link href={LEGAL_DOCUMENTS.regulamin.href}>Regulaminu sklepu</Link>.</p>

      <h2>Co sprzedajemy i za ile</h2>
      <p>SkillCheck jest usługą cyfrową dla firm wspierającą rekrutację. Płatny pakiet PRESELEKCJA zawiera analizy o liczbie, cenie i okresie ważności wskazanych w ofercie.
        Analiza to jedna analiza dokumentów jednego kandydata względem wymagań stanowiska.</p>
      <p>Aktualna oferta: PRESELEKCJA — {scope ? `${scope}, ` : ""}{preselekcjaPrice}, analizy ważne {preselekcjaOffer.validityMonths} miesiące.
        Szczegóły i aktualne ceny znajdziesz w sekcji <Link href="/#pakiety">Pakiety</Link>.</p>
      <p>Przed złożeniem zamówienia serwis pokazuje nazwę pakietu, liczbę analiz, okres ważności, cenę netto, kwotę VAT i cenę brutto w złotych. Ceny są cenami brutto, chyba że oznaczono inaczej. Nie ma kosztów dostawy.
        Pakiet FREE jest jednorazowym, bezpłatnym pakietem próbnym dla jednej firmy (jednego numeru NIP).
        {isPublicFutureOffersEnabled() && " Pakiety WERYFIKACJA i ASSESSMENT CENTER mają charakter informacyjny i nie są dostępne do zakupu do czasu opublikowania dla nich oferty."}</p>
      {full("§ 2, § 3 i § 6")}

      <h2>Metody płatności</h2>
      {/* Same status as the offer pages: only the transfer works today; Przelewy24 is named as being prepared. */}
      <p>Obecnie za pakiet płacisz przelewem tradycyjnym na podstawie faktury proforma, w terminie wskazanym na fakturze.
        Płatność online Przelewy24 jest przygotowywana (szybki przelew, BLIK lub karta, zależnie od metod dostępnych w chwili płatności).
        Operatorem płatności online jest PayPro S.A. z siedzibą w Poznaniu.</p>
      <p>Płatność online jest dokonana po potwierdzeniu przez operatora, a przelew tradycyjny — po uznaniu rachunku usługodawcy. Sam powrót ze strony operatora do serwisu nie jest potwierdzeniem płatności.
        Po zaksięgowaniu płatności wystawiamy fakturę VAT i wysyłamy ją e-mailem. Nie stosujemy automatycznych obciążeń cyklicznych.</p>
      {full("§ 7")}

      <h2>Kiedy dostajesz analizy</h2>
      <p>Analizy z opłaconego pakietu są przyznawane w koncie niezwłocznie po potwierdzeniu płatności: przy płatności online zwykle w ciągu kilku minut,
        przy przelewie tradycyjnym nie później niż w ciągu 2 dni roboczych od uznania rachunku. Pakiet FREE jest aktywowany po pozytywnej weryfikacji firmy.</p>
      <p>Analiza jest zużywana z chwilą zakończenia analizy dokumentów kandydata. Nie zużywa analizy samo otwarcie lub odświeżenie wyniku ani analiza przerwana z przyczyn leżących po stronie usługodawcy. Analizy są ważne 3 miesiące od dnia ich przyznania; niewykorzystane wygasają i nie podlegają zwrotowi, z zastrzeżeniem zasad reklamacji i odstąpienia.</p>
      {full("§ 8")}

      <h2>Reklamacje</h2>
      <p>Reklamację dotyczącą konta, działania serwisu, analiz, płatności lub faktur możesz złożyć e-mailem na {COMPANY.email} albo telefonicznie pod numerem {COMPANY.phone}.
        Podaj nazwę firmy, numer zamówienia (jeśli dotyczy), opis problemu i oczekiwany sposób rozwiązania. Prosimy nie przesyłać w reklamacji treści CV.</p>
      <p>Rozpatrujemy reklamację w ciągu 14 dni od jej otrzymania i odpowiadamy na adres e-mail, z którego została złożona.
        Gdy reklamacja zostanie uznana, usuwamy błąd, ponownie wykonujemy analizę bez opłaty, przywracamy zużyte analizy, obniżamy cenę albo zwracamy należność w odpowiedniej części.
        Przedsiębiorcy na prawach konsumenta przysługują ponadto uprawnienia z tytułu niezgodności usługi cyfrowej z umową przewidziane w ustawie o prawach konsumenta.</p>
      {full("§ 10")}

      <h2>Odstąpienie od umowy</h2>
      <p>Prawo odstąpienia od umowy zawartej na odległość przysługuje wyłącznie przedsiębiorcy na prawach konsumenta, czyli osobie fizycznej prowadzącej jednoosobową działalność gospodarczą, która zawiera umowę bezpośrednio związaną z jej działalnością, gdy z treści umowy wynika, że nie ma ona dla niej charakteru zawodowego, w szczególności w świetle przedmiotu działalności udostępnionego w CEIDG. Można odstąpić w ciągu 14 dni od zawarcia umowy bez podania przyczyny,
        składając oświadczenie np. na <Link href={LEGAL_DOCUMENTS.odstapienie.href}>formularzu odstąpienia</Link> wysłanym na {COMPANY.email}.</p>
      <p>Jeżeli świadczenie rozpoczęło się przed upływem tego terminu na wyraźne żądanie i z przyjęciem do wiadomości utraty prawa odstąpienia po pełnym wykonaniu usługi,
        prawo to wygasa z chwilą wykorzystania wszystkich analiz z pakietu. Przy odstąpieniu po rozpoczęciu świadczenia płacisz za analizy wykorzystane do tej chwili, proporcjonalnie do ceny pakietu.</p>
      <p>Zwrot należności następuje niezwłocznie, nie później niż w ciągu 14 dni od otrzymania oświadczenia o odstąpieniu lub uznania reklamacji, tą samą metodą płatności, chyba że klient zgodzi się na inną. Zwrot dokumentuje faktura korygująca.
        Poza przypadkami opisanymi w § 10 i § 11 opłata za pakiet nie podlega zwrotowi.</p>
      {full("§ 2 i § 11")}

      <h2>Kontakt</h2>
      <p>{COMPANY.shortName}, {COMPANY.address}. E-mail: <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>, telefon: <a href={COMPANY.phoneHref}>{COMPANY.phone}</a>.
        Więcej na stronie <Link href="/kontakt">Kontakt</Link>.</p>
      {full("§ 1")}
    </article>
    <SiteFooter />
  </main>;
}
