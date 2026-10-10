import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader } from "../components/marketing/site-header";
import { SiteFooter } from "../components/marketing/site-footer";
import marketing from "../marketing.module.css";
import styles from "../rozmowa/rozmowa.module.css";

export const metadata: Metadata = { title: "Dane w formularzu kontaktowym — SkillCheck" };

export default function ContactPrivacyPage() {
  return <main className={marketing.page}>
    <SiteHeader />
    <article id="tresc" className={styles.content}>
      <h1>Dane w formularzu kontaktowym</h1>
      <p>Ta informacja dotyczy zapytań o SkillCheck. Formularz nie służy do przekazywania CV ani danych kandydatów.</p>
      <h2>Administrator i kontakt</h2>
      <p>Administratorem jest KTIG CONSULTING Sp. z o.o., ul. Michała Kajki 10–12, 10-547 Olsztyn.
        W sprawach zgłoszeń i danych napisz na <a href="mailto:pomoc@skillcheck.pl">pomoc@skillcheck.pl</a>.</p>
      <h2>Cel i zakres</h2>
      <p>Przetwarzamy imię, nazwę firmy, e-mail, opcjonalny telefon i opis potrzeb, aby odpowiedzieć na zapytanie i prowadzić rozmowy o współpracy.
        Podanie danych jest dobrowolne, ale bez pól wymaganych nie przyjmiemy zgłoszenia. Nie zapisujemy Cię do newslettera.</p>
      <p>Podstawą jest nasz prawnie uzasadniony interes w obsłudze korespondencji i kontakcie z przedstawicielami firm (art. 6 ust. 1 lit. f RODO).
        Gdy występujesz we własnym imieniu i prosisz o przygotowanie umowy, podstawą działań przed jej zawarciem jest art. 6 ust. 1 lit. b RODO.</p>
      <h2>Przechowywanie</h2>
      <p>Dane zgłoszenia przechowujemy podczas rozmów oraz przez 6 miesięcy od ich zakończenia, jeżeli nie zawrzemy umowy.
        Po zawarciu umowy okres przechowywania dokumentacji współpracy wynika z jej celu i obowiązujących przepisów.</p>
      <p>Formularz wykorzystuje także techniczny identyfikator zgłoszenia, datę i skrót adresu IP do ochrony przed nadużyciami oraz powtórnym zapisem.
        Techniczny rejestr prób jest czyszczony z wpisów starszych niż 48 godzin. Zgłoszenie wysłane po zalogowaniu jest powiązane z kontem.</p>
      <h2>Odbiorcy i infrastruktura</h2>
      <p>Dostęp mają upoważnione osoby obsługujące zgłoszenia oraz dostawcy hostingu, bazy danych i poczty:
        Vercel, Supabase, home.pl oraz Resend (automatyczne potwierdzenia zgłoszeń). Baza projektu znajduje się w Unii Europejskiej. Korzystanie z globalnej infrastruktury dostawców może wiązać się z przetwarzaniem poza EOG.
        Informacje o stosowanych przez dostawców zabezpieczeniach transferów, w tym standardowych klauzulach umownych, znajdują się w ich dokumentach:
        {" "}<a href="https://vercel.com/legal/dpa">Vercel</a> i <a href="https://supabase.com/legal/dpa">Supabase</a>.
        O informacje dotyczące ochrony Twoich danych możesz wystąpić do administratora.</p>
      <p>Do wysyłki automatycznego potwierdzenia przekazujemy Resend adres e-mail oraz standardową treść wiadomości.
        Nie przekazujemy w tym celu opisu potrzeb, numeru telefonu, nazwy firmy ani danych kandydatów.
        Odpowiedź na potwierdzenie trafia do obsługi na pomoc@skillcheck.pl.</p>
      <h2>Twoje prawa</h2>
      <p>Możesz żądać dostępu do danych, ich sprostowania, usunięcia lub ograniczenia przetwarzania.
        Możesz wnieść sprzeciw wobec przetwarzania opartego na uzasadnionym interesie; prawo przenoszenia danych przysługuje w przypadkach określonych w RODO.
        Masz prawo złożyć skargę do Prezesa Urzędu Ochrony Danych Osobowych.</p>
      <p>Dane formularza nie służą profilowaniu ani automatycznemu podejmowaniu decyzji wywołujących skutki prawne.</p>
      <Link href="/rozmowa">Wróć do kontaktu</Link>
    </article>
    <SiteFooter />
  </main>;
}
