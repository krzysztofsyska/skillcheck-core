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

## 20.11.2026

**Uruchomienie Stripe na żywo w obu aplikacjach, faktury i korekty z Fakturowni, zdjęcie blokady
płatności w core.** Wiadomość właściciela w sesji Claude Code
https://claude.ai/code/session_01TVLzgdPHQxd9p7t7a6Egwp (19.11.2026), m.in.:
„Cel: płatności Stripe w OBU aplikacjach, jedno konto Stripe NA ŻYWO (KTIG Consulting Sp. z o.o., nazwa handlowa SkillCheck), faktury VAT z Fakturowni wysyłane automatycznie do KSeF. Piaskownicy Stripe nie używamy. Kolejność: najpierw skillcheck-preselekcja (sprzedaż FREE + PRESELEKCJA), potem skillcheck-core. Ścieżka płatności była zamrożona do uruchomienia Stripe'a — to zadanie jest tym uruchomieniem.”
„W skillcheck-core zostały stare zmienne P24_* — nie kasuj ich bez zgody właściciela.”
„2. Produkty i ceny tworzone skryptem przez API Stripe, idempotentnie, z metadata app i kodem pakietu: PRESELEKCJA 300 zł brutto / 60 CV, WERYFIKACJA 615 zł / 60 CV, ASSESSMENT CENTER 1 499 zł / 50 CV. Suwak puli CV (wielokrotności 5) — kwota liczona na serwerze, nigdy z przeglądarki. Pakiety "wkrótce" nie do kupienia (brak przycisku + blokada na serwerze).”
„3. Webhooki: zarejestruj endpointy w Stripe przez API (checkout.session.completed, charge.refunded). Masz zgodę właściciela, żeby w TYM zadaniu samodzielnie zapisać zwrócony sekret jako STRIPE_WEBHOOK_SECRET (Production, sensitive) w odpowiednim projekcie Vercel przez API Vercel — osobny dla każdej aplikacji. Poza tym sekretów nie ruszasz.”
„5. Faktury: NIE używaj faktur Stripe (Stripe Invoicing wyłączone). Po checkout.session.completed aplikacja wystawia fakturę VAT w Fakturowni przez API: nabywca (nazwa, NIP, adres) z rejestracji/sesji, pozycja = pakiet i pula CV, kwota brutto z VAT 23%, status "opłacona", metoda płatności, ID płatności Stripe w uwagach. Idempotentnie (jedna faktura na płatność). Przy charge.refunded — automatyczna faktura korygująca. Do KSeF i mailem do klienta wysyła Fakturownia (już włączone) — nie wysyłaj do KSeF sam. W skillcheck-core użyj istniejących zmiennych FAKTUROWNIA_*.”
„10. Po wydaniu każdej aplikacji: przygotuj dla właściciela jeden zakup kontrolny (link + co sprawdzić: pakiet włączony, faktura w Fakturowni z numerem KSeF), a po jego potwierdzeniu automatycznie zwróć płatność przez API Stripe (z korektą faktury).”

Pytania czatu do planu (ta sama sesja): „2. W core do kupienia tylko pakiety, które dziś działają.
WERYFIKACJA i ASSESSMENT CENTER zostają „wkrótce”, dopóki nie potwierdzisz, że działają.” oraz
„3. W core zdejmujesz blokadę płatności i odblokowujesz Fakturownię. Ten cytat wpiszę do DECYZJE.md.”
Właściciel: **„1 TAK (PRESELEKCJA tylko w całych pakietach po 60 CV, np. 2 pakiety = 600 zł = 120 CV). 2 TAK. 3 TAK. 4 TAK.”**
oraz: „zakup kontrolny robię na własną firmę KTIG Consulting sp. z o.o., innej firmy nie będzie. Jeśli faktura KTIG dla KTIG jest problemem w KSeF, rozwiąż to sam w najbezpieczniejszy sposób (np. ta jedna płatność kontrolna bez faktury albo od razu z korektą po zwrocie) i opisz w raporcie, co wybrałeś.”

**Potwierdzenie decyzji z 19.11.2026 (Stripe zamiast Przelewy24, voicebot do 50 zł/mies., PR #546).**
Pytanie czatu: „PR #546 zapisuje Twoje decyzje z 19.11 (Stripe zamiast P24, voicebot do 50 zł/mies.)
… Odpisz TAK, jeśli tak zdecydowałeś” Właściciel, ok. 08:4x:
„3 tak potwierdzam wyrzucamy całkowicie P24 , voicebot do 50zł”

## 19.11.2026

**Zdjęcie zamrożenia ścieżki płatności w tym repozytorium, Stripe zamiast Przelewy24, voicebot
z płatnym dostawcą do 50 zł miesięcznie.** Propozycje czatu (22:50):
„1. Zdjąć zamrożenie płatności w core i przejść tam na Stripe (to samo konto KTIG). Polecam to.
Odblokowuje R3, R5 i część R6. Agenci od razu dostaną kilkanaście kroków.”
„2. Voicebot: zgoda na Retell z miesięcznym limitem wydatków albo dalsza praca tylko na udawanym
dostawcy. Jeśli bez zgody, R6 wkrótce stanie.”
Właściciel, 22:59: **„1 tak, 2 limit 50 zł, 3 tak, 4 dokładna kontrola pliku w samej aplikacji”**
(punkty 3 i 4 dotyczą repozytorium `skillcheck-preselekcja`).

Następnie czat przedstawił listę zmian, m.in.:
„W poleceniach wykonawcy i recenzenta core dopiszę Twoje decyzje jako cytaty. Pierwszym zadaniem
wykonawcy będzie PR z dokumentami (DECYZJE.md, ROADMAP.md, AGENTS.md): zamrożenie ścieżki płatności
zdjęte; płatności przez Stripe na tym samym koncie KTIG Consulting; Przelewy24 do usunięcia.”
„To odblokowuje kolejne kroki w core: podpięcie Assessment Center do kupionego pakietu; kalkulator
wyceny; limity rozmów z voicebotem w pakietach; zakup WERYFIKACJI i AC przez Stripe.”
„Voicebot: zgoda na płatnego dostawcę rozmów (Retell) z limitem 50 zł miesięcznie. Limit będzie
pilnowany w samej aplikacji: po przekroczeniu nowe rozmowy się nie uruchamiają, a Ty dostajesz
powiadomienie.”
„Bez zmian zostają: zakaz ruszania sekretów, kasowania danych i prawdziwych wysyłek do klientów.”
Właściciel, 23:01: **„wszystko tak”**.

## 18.11.2026

**Test kompetencji na Preview i równoległy start voicebota (R6).** Propozycja czatu:
„1. Ustawić zmienne Vercel dla Preview (polecam jako pierwsze). Jest najtańsze i najbezpieczniejsze:
dotyczy tylko strony testowej, bez prawdziwych klientów. Od razu odblokowuje dokończenie R1 i R2,
czyli prawie cały etap 2 (WERYFIKACJA).” oraz „2. Pozwolić zacząć R6 (voicebot) już teraz,
równolegle. Podpięcie voicebota do limitów pakietów nie wymaga wysyłek ani płatności, więc agenci
mogliby nad tym pracować od razu. Klienci nadal by go nie widzieli.” Właściciel, ok. 22:05:
„TAK na 1 i 2”

## 17.11.2026

**Zgoda na zmiany w dokumentach pracy (#506).** Pytanie czatu: „Porządki w dokumentach pracy (#506)
stoją, bo recenzent chce Twoich zgód wprost na czacie, w trzech sprawach: 1. Wykonawca sam
aktualizuje statusy w planie prac. 2. Nowy podział ról: Claude pisze kod, a osobny recenzent go
sprawdza i scala. 3. Nowy układ planu prac.” Właściciel, 21:32: „1,2,3 tak”

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

Obowiązuje brzmienie z 18:10 („w tym samym PR”), potwierdzone o 21:32 („1,2,3 tak”); wcześniejsza
propozycja czatu „po scaleniu PR” jest NIEAKTUALNA (17.11.2026). Status wpisany w PR opisuje stan
`integration` po scaleniu tego PR.

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
- 07:49 „Ok” — w odpowiedzi na trzy doprecyzowania czatu (przeniesione z `docs/ROADMAP.md`, wpis
  z PR #493; dosłownego brzmienia pytania w repozytorium nie ma, poniżej jego zapis z ROADMAP): kandydat „wart rozmowy” spełnia wszystkie
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
