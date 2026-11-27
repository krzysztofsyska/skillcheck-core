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

## 27.11.2026

**Test kompetencji tylko z płatnym pakietem (R7 SC-019b, issue #638).** Czat pisany, 07:12. Pytanie
czatu: „Czy test kompetencji ma być dostępny tylko dla firm z pakietem WERYFIKACJA? Dziś może go
wysłać też firma z FREE lub PRESELEKCJĄ. Rekomendacja: TAK, bo test należy do płatnego pakietu.”
— właściciel: **„Tak”**.

## 26.11.2026

**Przegląd SC-000–SC-021 (remanent dla właściciela z 18.11.2026).** Rozmowa głosowa z czatem
(sesja https://claude.ai/code/session_01TVLzgbbxM3SKcesjeKv4nC), rano i wieczorem. Pełna lista
z opisem kroków: dokument Google „SkillCheck Core — decyzje właściciela z przeglądu SC-000–SC-021”
(folder „Projektownia – Fabryka Aplikacji”). Poniżej odpowiedź właściciela i propozycja czatu, na
którą odpowiadał.

- SC-000, 08:11 **„Tak, zgadzam się, żeby SC00 było pustym numerem.”** — na: „Rekomenduję zostawić
  ten numer pusty, z dopiskiem „nieodnalezione”, i nic pod nim nie budować.”
- SC-001, 08:12 **„Tak, może być.”** — na: „Rekomenduję zostawić to jako zrobione i nie robić
  osobnej kontroli, tylko sprawdzić przy końcowym teście całej aplikacji.”
- SC-002, 08:13 **„Tak.”** — na: „Rekomenduję dokończyć to teraz, bo od zgodności bazy zależy pełny
  test preselekcji i każdy kolejny krok. Automat porówna bazę z aplikacją i spisze różnice,
  a produkcję ruszy dopiero po kopii bezpieczeństwa i Twojej zgodzie.”
- SC-003, 08:14 **„Tak.”** — na: „Rekomenduję nie projektować tego od nowa, tylko raz sprawdzić, czy
  zasady zgadzają się z obecną analizą CV i raportami. Najlepiej przy okazji pełnego testu
  preselekcji”.
- SC-004, 08:15 **„Tak.”** — na: „Rekomenduję zrobić ten test teraz na dwóch fikcyjnych firmach.”
- SC-005, 08:16 **„Tak, proszę.”** — na: „Rekomenduję dokończyć to teraz jako pierwszy pełny test na
  fikcyjnych CV. Od tego zależą wszystkie następne punkty preselekcji.”
- SC-006, 08:17 **„Tak.”** — na: „Rekomenduję dokończyć to teraz, razem z testem z poprzedniego
  punktu.”
- SC-007, 08:18 **„Tak.”** — na: „Rekomenduję dokończyć to teraz, razem z testem preselekcji.”
- SC-008, 08:19 **„Tak.”** — na: „Rekomenduję dokończyć to teraz, przechodząc przykładową rekrutację
  od ocenionych CV do zatwierdzonej krótkiej listy.”
- SC-009, 08:20 **„Tak.”** — na: „Rekomenduję dokończyć to teraz jako zamknięcie testu preselekcji,
  a na koniec pokazać Ci gotowy raport z fikcyjnej rekrutacji do akceptacji.”
- SC-010, 08:22 **„Tak.”** — na: „Zgadzasz się na moją propozycję dla SC-010: teraz zgody i usuwanie
  danych na fikcyjnych danych, a wysyłanie wiadomości później?”
- SC-011, 21:56 **„Na razie możemy wstrzymać.”**; SC-012, 21:57 **„Tak.”**; SC-013, 21:57
  **„Wstrzymujemy.”** — NIEAKTUALNE (26.11.2026, 22:10), zob. niżej.
- SC-014, 21:58 **„Tak. Zgadzam się.”** — na: „Polecam dokończyć to teraz, zaraz po preselekcji
  i uporządkowaniu bazy, i sprawdzić oba sposoby wysyłania testu.”
- SC-015, 21:58 **„Tak.”** — na: „Polecam dokończyć to teraz, po testach kompetencji, i pokazać Ci
  jeden pełny raport z fikcyjnej rekrutacji do akceptacji.”
- SC-016, 21:59 **„Tak.”** — na: „Polecam zrobić to teraz, ale dopiero po Weryfikacji: najpierw
  uporządkować dostęp i powiązanie zakupu z uprawnieniami, potem przetestować sesję na fikcyjnych
  uczestnikach.”
- SC-017, 21:59 **„Tak.”** — na: „Polecam go odłożyć i wrócić, kiedy ruszy sprzedaż i pojawią się
  prawdziwe dane z rekrutacji”.
- SC-018, 22:00 **„Tak.”** — na: „Polecam go odłożyć, dopóki nie uporządkujemy zgód, usuwania danych
  i głównych produktów”.
- SC-019, 22:01 **„Tak.”** (po pytaniu właściciela „Czyli co? Czyli będzie na skill check
  preselekcja?”) — NIEAKTUALNE (26.11.2026, 22:10), zob. niżej.
- SC-020, 22:03 **„Wiesz co, mnie to nie przeszkadza. Możemy wziąć już niektóre elementy z white
  label robić.”** oraz **„Bo są moce przerobowe, jeżeli chodzi o tokeny.”** — na propozycję: „Ten
  jeden test na dwóch fikcyjnych firmach zróbmy zaraz po głównych produktach, a sprzedaż niech czeka
  na klienta.”
- SC-021, 22:04 **„Tak.”** — na: „Skoro są wolne moce, polecam przetestować to teraz, równolegle, na
  fikcyjnych firmach, a włączyć przed pierwszą płatną sprzedażą.”

**Korekta SC-011–SC-013 i SC-019 (czat pisany, 22:10).** Czat wyjaśnił, że rekomendacje z rozmowy
głosowej opierały się na remanencie z 18.11.2026, starszym niż decyzje z 18–19.11.2026
(voicebot R6, Stripe w core R7). Pytania czatu i odpowiedzi właściciela (wybór opcji):

- „Voicebot (SC-011–SC-013). Rano zdecydowałeś „wstrzymać”, ale od 18.11 voicebot jest budowany
  równolegle i sporo jest już zrobione (…). Co robimy?” — właściciel: **„Budować dalej (polecam)”**
  (opcja: „Zostawiamy, jak było od 18.11.”).
- „Płatności (SC-019). Rano zdecydowałeś „jeden sklep w Preselekcji”. Od 19.11 Stripe jest jednak
  budowany także w Core (…). Co robimy?” — właściciel: **„Sklep w Core (polecam)”** (opcja: „Kończymy
  to, co prawie gotowe.”).

Uwaga: „(…)” to skrót pytania czatu w tym zapisie; pełne brzmienie jest w sesji podanej wyżej.

## 20.11.2026

**Uruchomienie Stripe na żywo w core: prawdziwe płatności, faktury z Fakturowni, sekret webhooka.**
Czat z właścicielem (sesja https://claude.ai/code/session_01TVLzgZpNuVS6QUizQskKhh), pytania czatu 18:23,
m.in. punkt 5 (dotyczy tego repozytorium; punkty 1–4 dotyczą `skillcheck-preselekcja`):
„5. Core: prawdziwe płatności Stripe na koncie KTIG; automatyczne faktury z Fakturowni; agent sam wpisuje w Vercelu jeden sekret, ten od powiadomień Stripe (`STRIPE_WEBHOOK_SECRET`), tylko dla tego zadania. Polecam TAK.”
Właściciel, 18:29: **„1 tak, 2 tak, 3 tak, 4 tak, 5 tak”**
(źródło: komentarze w krzysztofsyska/skillcheck-preselekcja#113 i w tym PR, 20.11.2026, 17:29 UTC).

**Pula rozmów voicebota: scalenie, ważność, limit kosztu (odpowiedź właściciela w czacie, 18:31).**
Pytania sesji Claude w poprzedniej wiadomości czatu (TAK/NIE, każde z rekomendacją TAK):
1) czy scalić pulę rozmów z pakietów (PR #553) do wersji testowej (`integration`);
2) czy rozmowy z pakietu mają być ważne 3 miesiące, tak jak pakiet CV;
3) czy zostawić limit 50 zł miesięcznie na czas testów i wrócić do niego po pierwszych próbnych
   rozmowach (przy 15 zł rezerwacji na rozmowę to w najgorszym razie ok. 3 rozmowy miesięcznie
   łącznie, a pakiet ma 10 — do decyzji przed pokazaniem voicebota klientom).
Cytat odpowiedzi właściciela: „1 tak, 2 tak, 3 tak”.

**Voicebot w pakietach: pula rozmów i dokupowanie (polecenie właściciela dla PR #553, ok. 09:55).**
Cytat z polecenia właściciela (układ tabeli i listy zachowany):

> Voicebot będzie częścią pakietów SkillCheck:
>
> | Pakiet | Rozmowy voicebota w cenie |
> |---|---|
> | FREE | 1 próbna rozmowa |
> | PRESELEKCJA | 10 rozmów |
> | WERYFIKACJA | 10 rozmów |
> | ASSESSMENT CENTER | 10 rozmów |
>
> Po wykorzystaniu przyznanej puli klient będzie mógł dokupić kolejne rozmowy.
>
> Cena, wielkość dodatkowej puli i sposób jej zakupu zostaną ustalone później. Nie wprowadzaj
> własnych założeń handlowych.
>
> Limity analiz CV pozostają bez zmian:
>
> * FREE — 5 analiz CV.
> * PRESELEKCJA — 60 analiz CV za 300 zł brutto.
>
> Limity rozmów i analiz CV są odrębnymi uprawnieniami.

oraz: „Voicebot pozostaje niewidoczny dla klientów do czasu skonfigurowania i zatwierdzenia
uruchomienia.”

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
  NIEAKTUALNE (26.11.2026) — zob. przegląd SC-000–SC-021 z 26.11.2026.

Uwaga: „(…)” to skrót samej rekomendacji czatu w poleceniu, z którego pochodzi cytat; pełniejszego
brzmienia w repozytorium nie ma. Dosłowną odpowiedzią właściciela na wszystkie pięć pozycji jest
wyłącznie „tak jak polecasz”.

**Promocja `integration → main` scalana przez recenzenta.** 15:19 (potwierdzone 15:21 i 18:47):
„Sesja recenzenta może scalić promocję integration → main, gdy testy są zielone na dokładnej wersji
i jest niezależna ocena pozytywna. Bez zmian zostają: zamrożenie płatności, zakaz zmiany sekretów
i ustawień, zakaz kasowania danych i nowych kosztów.” Wiadomość z 18:47: „sesja recenzenta może sama
scalić wydanie na produkcję”.
