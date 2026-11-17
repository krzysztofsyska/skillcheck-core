# SkillCheck — dziennik decyzji właściciela

## Zasady tego pliku

1. Tu, i tylko tu, zapisujemy decyzje właściciela (Krzysztof): data, godzina i dosłowny cytat jego
   wiadomości. Agent nie streszcza decyzji własnymi słowami. Jedyny tekst agenta to krótki nagłówek
   wpisu i — gdy odpowiedź właściciela jest krótka („tak”, „ok”) — dosłowne brzmienie pytania lub
   propozycji czatu, na które odpowiadał.
2. `docs/ROADMAP.md`, `AGENTS.md` i `CLAUDE.md` zawierają tylko obowiązującą regułę, bez cytatów.
   Gdy reguła i wpis tutaj się różnią, rozstrzyga najnowsza wiadomość właściciela.
3. Wpisy są dopisywane na górze sekcji danego dnia. Starsze wpisy zostają jako historia; nieaktualne
   oznaczamy dopiskiem „NIEAKTUALNE (data)”, nie kasujemy.
4. Decyzje sprzed 16.11.2026 są w historii git plików `AGENTS.md` i `CLAUDE.md` (stan sprzed
   17.11.2026) oraz w `docs/BACKLOG.md` (archiwum).

## 17.11.2026

**Porządek dokumentów pracy i statusy w ROADMAP aktualizowane przez wykonawcę.** Propozycja czatu
(punkty 2 i 3 planu): „Zmienić zasadę: kolejność i zakres zmieniasz tylko Ty, a statusy agent
aktualizuje sam po scaleniu PR.” oraz „Przenieść cytaty decyzji z ROADMAP, AGENTS.md i CLAUDE.md do
nowego `docs/DECYZJE.md`.” Właściciel:

- 17:07 „przygotuj wszystkie trzy dokumenty aby były wykonawczo zbieżne i czy to co jest w toku
  można podmienić i czy można jeszcze podmienić”
- 17:18 „przygotuj do wykonawcy i recenzenta polecenia aby było spójne z agents, cloude i roadmap
  i abyśmy przyśpieszyli proces”
- 18:10 „poszło” — po samodzielnym wklejeniu nowego polecenia zadania „Skillcheck — wykonawca zadań
  GitHub”, którego punkt 3 brzmi: „W tym samym PR, który zaczyna albo kończy krok, aktualizujesz
  w docs/ROADMAP.md tylko jego status i dowód (numer PR). Kolejności, zakresu, pozycji i cen nie
  zmieniasz.”

**skillcheck-preselekcja: zakres przeniesienia i Fakturownia.** 14:34 „Zakres: całość A–D przed
startem sprzedaży. Pakiety na stronie: WERYFIKACJA i Assessment Center mają być widoczne
w skillcheck-preselekcja jako „wkrótce” wraz z opisem funkcjonalności. 3 tak” — „3 tak” to odpowiedź
na pytanie czatu: „Fakturownia: w core jej automatyzacja jest na liście wstrzymanych. Tu jest
potrzebna, żeby faktury wychodziły bez Twojego udziału. Odblokowujesz ją dla tej aplikacji?”
Dotyczy wyłącznie `skillcheck-preselekcja`; w `skillcheck-core` automatyzacja Fakturowni pozostaje
zamknięta.

**Porządki przyspieszające pracę (J3).** 10:41 „W takim razie robimy tylko punkty 1,2,3,5” —
w odpowiedzi na plan czatu, w którym punkt 2 brzmiał: „Zlecam w skillcheck-core usunięcie starego
automatu i poprawkę instrukcji”. 14:26 „1 tak” — na pytanie czatu: „Czy wykreślić J4 (podział
testów) z zadania porządkowego i zostawić tylko usunięcie starego automatu?”

**Automatyczne wgrywanie bezpiecznych zmian bazy (J1, issue
[#491](https://github.com/krzysztofsyska/skillcheck-core/issues/491)).** Droga B w czacie brzmiała:
„B. Automat dla bezpiecznych zmian — Zmiany, które tylko dodają (nowa tabela, nowa kolumna), idą
same po sprawdzeniu świeżej kopii; kasujące lub przerabiające dane dalej czekają na Ciebie”.
Właściciel:

- 07:20 „Na pierwsze pytanie to będzie B”
- 07:25 „Część pierwsza to uruchom.”

**Gwarancja PRESELEKCJI (J2, issue
[#492](https://github.com/krzysztofsyska/skillcheck-core/issues/492)).** Właściciel:

- 07:25 „Jest powtórka połączona ze zwrotem. Najpierw poprawiamy za darmo, a jeżeli nie pasuje,
  oddajemy pieniądze. […] Minimum 5 kandydatów.”
- 07:49 „Ok” — w odpowiedzi na trzy doprecyzowania czatu: kandydat „wart rozmowy” spełnia wszystkie
  wymagania konieczne klienta; zwrot dopiero po powtórce z udziałem klienta; gwarancja działa także
  przy słabym naborze, ale tylko dla pierwszych 20 firm.
- 07:53 „Termin zgłoszenia gwarancji to 7 dni od otrzymania raportu. Zapis o gwarancji nie idzie do
  prawnika, tylko od razu do polityki.”
- 07:56 „Musi zostać załadowana do obu baz, i zarówno do skill check core, jak i skill check
  preselekcja. Dobrze, przeniesiemy go przy okazji podłączenia Stripe'a.”

Uwaga: „[…]” to skrót w poleceniu właściciela, z którego pochodzi cytat; pełniejszego brzmienia
w repozytorium nie ma.

## 16.11.2026

**Kierunek sprzedaży i budowy.** Czat przedstawił poniższe rekomendacje, właściciel odpowiedział
**„tak jak polecasz”** (22:39):

- „Gdzie sprzedajemy najpierw. Polecam FREE i PRESELEKCJĘ z nowej aplikacji skillcheck-preselekcja
  na Stripe, a w skillcheck-core budowę WERYFIKACJI i Assessment Center.”
- „Pakiety na stronie. WERYFIKACJA i Assessment Center zniknęły ze strony tylko z powodu
  Przelewy24. Skoro z P24 rezygnujesz, polecam je przywrócić z cenami 615 zł i 1 499 zł.”
- „Voicebot. Rozumiem to tak: docelowo w każdym pakiecie (FREE 1 rozmowa, płatne 10), budowany na
  końcu, do tego czasu niewidoczny na stronie.”
- „Zatwierdzanie testów. 6 listopada zdecydowałeś, że rekruter może puścić testy automatycznie (…).
  Poprawię zapis na Twoją wersję.”
- „White-label i bramka AI (SC-020, SC-021). Polecam wstrzymać je do pierwszej sprzedaży.”

Uwaga: „(…)” to skrót samej rekomendacji czatu w poleceniu, z którego pochodzi cytat; pełniejszego
brzmienia w repozytorium nie ma. Dosłowną odpowiedzią właściciela na wszystkie pięć pozycji jest
wyłącznie „tak jak polecasz”.

**Promocja `integration → main` scalana przez recenzenta.** 15:19 (potwierdzone 15:21 i 18:47):
„Sesja recenzenta może scalić promocję integration → main, gdy testy są zielone na dokładnej wersji
i jest niezależna ocena pozytywna. Bez zmian zostają: zamrożenie płatności, zakaz zmiany sekretów
i ustawień, zakaz kasowania danych i nowych kosztów.” Wiadomość z 18:47: „sesja recenzenta może sama
scalić wydanie na produkcję”.
