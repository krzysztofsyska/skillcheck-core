import styles from "../../marketing.module.css";

export function FutureOfferPreview() {
  return <div className={styles.offerPreview} id="przyklady-pakietow">
    <p className={styles.planLabel}>Zobacz materiały przed podjęciem decyzji</p>
    <h3>Od odpowiedzi kandydata do konkretnego tematu na rozmowę.</h3>
    <p>Jeden przykład pokazuje całą drogę: pytanie, zadanie i wniosek poparty obserwacją. Tak ma wyglądać praca z materiałami w planowanych pakietach.</p>
    <p className={styles.previewNotice}><strong>Demonstracja na fikcyjnych danych.</strong> Stanowisko: specjalista ds. obsługi klienta B2B. Kandydat A jest postacią fikcyjną. To ręcznie przygotowane fragmenty planowanych materiałów, nie wynik działającej usługi ani pełna ocena kompetencji. Niczego tutaj nie wysyłasz i nie uruchamiasz analizy AI.</p>
    <div className={styles.previewGrid}>
      <article className={styles.previewPanel}>
        <p className={styles.planLabel}>01 · Weryfikacja i AC</p>
        <h4>Przykładowy test</h4>
        <p><strong>Kompetencja:</strong> ustalanie priorytetów i komunikacja z klientem.</p>
        <p>O 9:00 klient informuje, że awaria zatrzymała realizację zamówień. Procedura wymaga pilnego zgłoszenia takiej awarii do wsparcia. Przyczyna i czas naprawy nie są znane. Co robisz najpierw?</p>
        <ol type="A">
          <li>Obiecujesz naprawę w godzinę, żeby uspokoić klienta.</li>
          <li>Potwierdzasz odbiór, zbierasz dane o wpływie awarii, eskalujesz ją zgodnie z procedurą i ustalasz termin kolejnej informacji.</li>
          <li>Czekasz na rozwiązanie, aby wysłać klientowi dopiero kompletną odpowiedź.</li>
        </ol>
        <details className={styles.packageDetails}>
          <summary>Pokaż klucz i uzasadnienie</summary>
          <p><strong>B — 1 punkt.</strong> Łączy reakcję na pilność, właściwą eskalację i komunikację bez obiecywania nieznanego terminu naprawy. A i C — 0 punktów. Klucz dotyczy założeń tego przykładu; w rekrutacji zatwierdza go rekruter.</p>
        </details>
        <p><strong>Pytanie otwarte:</strong> napisz w trzech zdaniach pierwszą wiadomość do klienta.</p>
        <details className={styles.packageDetails}>
          <summary>Zobacz fikcyjną odpowiedź i kryteria</summary>
          <blockquote>„Potwierdzam zgłoszenie awarii. Przekazuję je pilnie do wsparcia; proszę o numer zamówienia i informację, ilu użytkowników dotyczy problem. Wrócę z aktualizacją do 9:30, nawet jeśli diagnoza będzie jeszcze trwała.”</blockquote>
          <p>Rekruter sprawdza: potwierdzenie zgłoszenia, zebranie danych, eskalację i termin aktualizacji. Przykładowa ocena: zgodnie z wymaganiami. To ocena tej odpowiedzi, nie całej osoby.</p>
        </details>
        <p className={styles.note}>Fragment: jedno pytanie zamknięte i jedno otwarte. Planowany pełny test: 8 zamkniętych i 4 otwarte.</p>
      </article>
      <article className={styles.previewPanel}>
        <p className={styles.planLabel}>02 · Assessment Center</p>
        <h4>Przykładowe ćwiczenie</h4>
        <p><strong>Ustalanie priorytetów · 20 minut</strong></p>
        <p>Jest 9:00. W skrzynce masz cztery sprawy:</p>
        <ul>
          <li>Awaria blokująca zamówienia klienta — wymaga pilnej eskalacji.</li>
          <li>Oferta do wysłania do 12:00 — około 45 minut pracy.</li>
          <li>Prośba o kopię faktury — do końca dnia, 5 minut pracy.</li>
          <li>Raport tygodniowy — termin jutro, 60 minut pracy.</li>
        </ul>
        <p><strong>Twoje zadanie:</strong> ułóż plan pierwszej godziny, uzasadnij kolejność i przygotuj wiadomość do klienta z awarią. Nie zakładaj, że znasz termin naprawy.</p>
        <details className={styles.packageDetails}>
          <summary>Zobacz instrukcję dla oceniających</summary>
          <p>Zapisz konkretne działania i wypowiedzi. Oceń uwzględnienie pilności, terminów, zależności oraz komunikacji. Dopuszczalne są różne plany z przekonującym uzasadnieniem.</p>
          <ul>
            <li><strong>Poniżej wymagań:</strong> pomija awarię lub obiecuje termin naprawy bez podstaw.</li>
            <li><strong>Zgodnie:</strong> eskaluje awarię, ustala aktualizację i rezerwuje czas na ofertę.</li>
            <li><strong>Powyżej:</strong> dodatkowo określa, kiedy zmieni plan, i przygotowuje wariant na brak odpowiedzi wsparcia.</li>
            <li><strong>Brak danych:</strong> materiał nie pozwala ocenić kryterium; nie oznacza to wyniku zerowego.</li>
          </ul>
          <p>Dwóch oceniających zapisuje obserwacje niezależnie, następnie uzgadnia ocenę z dowodami. W tym fragmencie obserwujemy dwie kompetencje; pełny zestaw trzech ćwiczeń ma obejmować cztery.</p>
        </details>
        <p className={styles.note}>Jedno z trzech planowanych ćwiczeń. Pozostałe: analiza przypadku i symulacja rozmowy.</p>
      </article>
      <article className={styles.previewPanel}>
        <p className={styles.planLabel}>03 · Przykładowy rezultat</p>
        <h4>Fragment raportu: Kandydat A</h4>
        <p><strong>Fikcyjny raport demonstracyjny.</strong> Pokazuje sposób prezentacji dowodów, nie rekomendację zatrudnienia.</p>
        <dl className={styles.previewEvidence}>
          <dt>Test: pytanie zamknięte</dt><dd>Odpowiedź B — 1/1 punkt. To wynik jednego pytania, nie całego testu.</dd>
          <dt>Komunikacja: odpowiedź otwarta</dt><dd>Zgodnie z wymaganiami. Dowód: „Wrócę z aktualizacją do 9:30”. Kandydat określa kolejny kontakt bez obietnicy naprawy.</dd>
          <dt>Priorytety: ćwiczenie praktyczne</dt><dd>Zgodnie z wymaganiami. Fikcyjna obserwacja: kandydat umieścił eskalację awarii na początku, a pracę nad ofertą zaplanował na 9:15–10:00.</dd>
          <dt>Reakcja na brak odpowiedzi wsparcia</dt><dd>Brak danych. W przedstawionym planie nie zapisano wariantu na przedłużającą się diagnozę.</dd>
        </dl>
        <p><strong>Pytanie na rozmowę:</strong> „Co zrobisz o 9:30, jeśli wsparcie nadal nie określi przyczyny awarii?”</p>
        <p className={styles.note}>Weryfikacja ma obejmować CV i test. AC ma dodatkowo pokazać obserwacje z ćwiczeń. Ten fragment nie zawiera analizy CV, pełnego testu ani porównania osób.</p>
      </article>
    </div>
    <div className={styles.previewValue}>
      <h4>Materiały, kryteria i raport w jednym procesie.</h4>
      <p>Twój zespół ma zaczynać od propozycji materiałów dopasowanych do stanowiska. Wspólne kryteria porządkują ocenę, a raport pomaga wrócić do konkretnej odpowiedzi lub obserwacji. Przygotowanie, ocena i decyzja nadal wymagają udziału człowieka.</p>
      <p><strong>Najpierw sprawdź zakres poniżej.</strong> Wybierz Weryfikację, jeśli potrzebujesz testu dla shortlisty, albo AC, jeśli chcesz obserwować finalistów w praktycznych zadaniach. Oba pakiety są w przygotowaniu.</p>
    </div>
  </div>;
}
