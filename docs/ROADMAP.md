# SkillCheck — roadmapa (kolejność prac)

## Zasady tego pliku

1. **To jedyne źródło kolejności prac w tym repozytorium.** `AGENTS.md`, `CLAUDE.md`,
   `docs/BACKLOG.md` (archiwum) i kolejka w [#367](https://github.com/krzysztofsyska/skillcheck-core/issues/367)
   tylko na nie wskazują. Gdy coś się nie zgadza, obowiązuje ten plik.
2. **Kolejność, zakres, etapy i pozycje zmienia wyłącznie właściciel.** Agent nie dopisuje, nie
   usuwa i nie przestawia pozycji z własnej inicjatywy.
3. **Statusy aktualizuje wykonawca** w tym samym PR, który kończy albo zaczyna krok: status
   (DO ZROBIENIA / W TOKU / ZROBIONE / DO SPRAWDZENIA) i dowód (numer PR, plik). Wpisany status
   opisuje stan `integration` po scaleniu tego PR. Recenzent sprawdza, że status zgadza się
   z diffem. Status oznacza stan na `integration`, nie na produkcji.
4. **Decyzje właściciela** zapisujemy wyłącznie w [docs/DECYZJE.md](DECYZJE.md), jako dosłowne
   cytaty z datą. Tutaj zostaje tylko ich skutek.

Bramki bezpieczeństwa (migracje produkcyjne, sekrety, ustawienia, kasowanie danych, nowe koszty,
nowe realne wysyłki, polityka wydań #369, ścieżka płatności) są w `AGENTS.md`. Ten plik ich nie
definiuje; skutek decyzji z 19.11.2026 i 20.11.2026 (płatności na Stripe, voicebot do 50 zł/mies.)
jest tylko odnotowany w etapach poniżej, a reguły i cytaty są w `AGENTS.md` i `docs/DECYZJE.md`.

Statusy ustalono 17.11.2026 z kodu na `integration` (`7ebd063`) oraz z issue i PR.

## Etapy — cały SkillCheck

| Etap | Cel biznesowy | Gotowe, gdy | Gdzie |
|---|---|---|---|
| **1. Pierwsza sprzedaż** | firma kupuje FREE / PRESELEKCJĘ przez Stripe i dostaje raport | pierwsza prawdziwa płatność za PRESELEKCJĘ | repo `skillcheck-preselekcja`, jego [docs/ROADMAP.md](https://github.com/krzysztofsyska/skillcheck-preselekcja/blob/integration/docs/ROADMAP.md) |
| **2. WERYFIKACJA gotowa** | rekruter daje test kompetencji z shortlisty i dostaje rozszerzony raport | ścieżka R1 + R2 przechodzi na Preview, pakiet opisany na stronie (R4) | to repo: R1, R2, R4 |
| **3. Assessment Center gotowe** | firma prowadzi sesję finalistów z dwoma asesorami | ścieżka R3 przechodzi na Preview dla konta firmy z pakietem | to repo: R3 |
| **4. Później** | kalkulator wyceny i voicebot | — | to repo: R5, R6 |

Etap 1 nie blokuje etapów 2–3: oba repozytoria pracują równolegle. Kolejność w tym repozytorium
wyznacza lista „Kolejność funkcji” niżej.

## Kolejność funkcji

Wykonawca bierze pierwszy wolny krok z najwyższej pozycji, pomijając pozycje oznaczone CZEKA.

Ceny pakietów: [docs/cennik-2026-11-02.md](cennik-2026-11-02.md) (jedyne źródło liczb).

### R1. Test kompetencji dla kandydata (etap 2)

Rekruter wybiera dla rekrutacji: zatwierdza zadania sam albo testy generują się i wychodzą
automatycznie. W obu trybach test dostaje tylko kandydat z shortlisty (reguła R1, pilnowana w bazie).

| Krok | Status | Dowód |
|---|---|---|
| C1–C5 — dane, podejścia i limity, wydawanie dostępu, strona kandydata (za flagą), ocena człowieka z cytatami | ZROBIONE | PR #273 |
| C6 — AI układa wspólne zadanie, rekruter zatwierdza | ZROBIONE | PR #285, #291, #293, #296, #322, #326, #332, #358 |
| C6 — pytania indywidualne z luk w CV kandydata z shortlisty | ZROBIONE (podgląd, tylko odczyt) | PR #490, #507 |
| Reguła R1 w bazie | ZROBIONE | PR #273 |
| Tryb automatyczny w bazie (`auto_release`) | ZROBIONE | PR #291 |
| Przełącznik rekrutera „zatwierdzam sam” / „automatycznie” na ekranie | ZROBIONE | PR #497 |
| Automatyczne wysłanie testu kandydatowi w trybie automatycznym | W TOKU (dostęp bez kliknięcia rekrutera; realna wysyłka do kandydata nadal zamknięta) | PR #510, PR #517, PR #545 |
| Włączenie testu kompetencji w Preview i przejście całej ścieżki | DO SPRAWDZENIA (częściowo — zob. `docs/checks/r1-preview-walk-2026-11-18.md`) | ścieżka ręczna przeszła w bazie Preview; na stronie Preview test wyłączony (brak zmiennych Vercel) |

### R2. Rozszerzony raport kandydata, bez części głosowej (etap 2)

| Krok | Status | Dowód |
|---|---|---|
| A — opis raportu (CV, test, ćwiczenia, etapy) | ZROBIONE | PR #269, #498 |
| B — wymagania z CV | ZROBIONE | `lib/candidate-report.ts` |
| B — sekcja testu kompetencji | ZROBIONE | PR #496 |
| B — sekcje ćwiczeń i etapów rekrutacji (dane, ekran, wydruk A4) | ZROBIONE | PR #501, #505 |
| C — ekran raportu i wydruk A4 | ZROBIONE | PR #483 |
| D — eksport CSV z rejestrem dostępu, historia eksportów (raport i firma) | ZROBIONE | PR #476, #477, #482 |
| Przejście całego raportu na Preview na danych testowych | DO SPRAWDZENIA (częściowo — zob. `docs/checks/r2-preview-walk-2026-11-18.md`) | sprawdzenie 18.11.2026; poprawka B1: PR #521; O1 (grupy „nieaktualny”) — PR #520; ponowne sprawdzenie B1 i O1 na Preview: PASS (baza i kod; ekran NOT RUN), brakuje testu kompetencji (zmienne Vercel) — PR #524 |

### R3. Assessment Center — pełny przepływ (etap 3, issue #338)

| Krok | Status | Dowód |
|---|---|---|
| Arkusze ćwiczeń i raport z dowodów | ZROBIONE | PR #272, #378 |
| Sesja finalistów: dwóch niezależnych asesorów, limit 10 osób, druga próba | ZROBIONE (za flagą `AC_PAIRED_SHEETS_PREVIEW`) | PR #434, #471 |
| Eksport CSV podsumowania sesji i rejestr pobrań | ZROBIONE | PR #480, #486 |
| Asesorzy pokazani z nazwy (etykieta, potem e-mail konta z tej samej firmy) | ZROBIONE | PR #500, #513 |
| Jawne braki dowodów w raporcie i CSV sesji | ZROBIONE | PR #508 |
| Testy równoczesnej pracy asesorów | ZROBIONE | PR #512 |
| Powiązanie z kontami firm, uprawnieniami i kupionym pakietem | W TOKU (konta i uprawnienia zrobione; sesję tworzy i otwiera tylko firma z opłaconym pakietem ASSESSMENT CENTER — pilnowane w bazie; zakup pakietu AC przez Stripe działa w trybie testowym; zostaje uruchomienie płatności na żywo w R7) | PR #503, #554, #563; issue #338, #274, #283 |

### R4. Oferta na stronie (etap 2)

Zmiana treści strony; nie zmienia integracji płatności, przepływu zakupu, cen w katalogu ani stanów
zamówień.

| Krok | Status | Dowód |
|---|---|---|
| WERYFIKACJA i ASSESSMENT CENTER widoczne na stronie, z opisem i dopiskiem „nie można jeszcze kupić”, bez wzmianki o bocie | ZROBIONE | PR #489 |
| Gwarancja wyniku PRESELEKCJI w regulaminie i na stronie oferty | ZROBIONE | PR #494 (issue #492) |

### R5. Kalkulator wyceny (SC-PRICING-W1…W4)

Zamrożenie ścieżki płatności zdjęte 19.11.2026 (`docs/DECYZJE.md`). Ceny wyłącznie według `docs/cennik-2026-11-02.md`.

| Krok | Status | Dowód |
|---|---|---|
| W1 + W2 — audyt źródeł cennika i katalog cen w bazie | ZROBIONE | PR #265 |
| W2b — suwak liczby CV co 5 | W TOKU (część 2/2 zrobiona za flagą PRICING_CV_SLIDER_ENABLED, domyślnie wyłączoną; zostaje: walidacja liczby CV po stronie serwera przy zamówieniu — nie weszła do W3 (#557), do zrobienia razem z formularzem zamówienia z suwakiem) | PR #286 (część 1), część 2: PR #552 |
| W3, W4 — publiczny cennik z katalogu, za wyłączoną flagą | ZROBIONE (W3 i W4 za wyłączonymi flagami PRICING_PAID_OPTIONS_ENABLED i PRICING_PUBLIC_CATALOG_ENABLED; włączenie flag — decyzja właściciela, TAK/NIE z liczbami przed i po) | W3: PR #557, W4: PR #559 |

### R6. Voicebot — równolegle z R1–R3 (od 18.11.2026)

Docelowo w każdym pakiecie: FREE 1 próbna rozmowa, PRESELEKCJA 10, WERYFIKACJA 10, ASSESSMENT CENTER 10;
po wykorzystaniu puli klient będzie mógł dokupić kolejne rozmowy — cena, wielkość dodatkowej puli,
ważność i sposób zakupu NIEUSTALONE (decyzja 20.11.2026, `docs/DECYZJE.md`). Pula z pakietu jest ważna
3 miesiące, jak pakiet CV. Limit kosztu 50 zł/mies. zostaje na czas testów; przed pokazaniem
voicebota klientom wraca do decyzji właściciela (przy 15 zł rezerwacji na rozmowę to ok. 3 rozmowy
miesięcznie łącznie, a pakiet ma 10). Limity rozmów i analiz
CV są odrębne; limity CV bez zmian. Do czasu, aż działa i właściciel zatwierdzi uruchomienie,
niewidoczny dla klientów.
Od 18.11.2026 prowadzony równolegle z R1–R3 (decyzja w `docs/DECYZJE.md`). Część dotykająca
katalogu pakietów jest odblokowana (19.11.2026). Płatny dostawca rozmów (Retell) dozwolony do 50 zł
miesięcznie, z limitem pilnowanym w aplikacji (decyzja 19.11.2026, `docs/DECYZJE.md`).

| Krok | Status | Dowód |
|---|---|---|
| Architektura i MVP rozmowy (dawne SC-011, SC-012) | W TOKU (sprawdzone 18.11.2026) | audyt PR #526, `docs/checks/r6-voice-audit-2026-11-18.md`: fundamenty działają tylko na sztucznym dostawcy i bazie testowej; brakuje migracji, webhooka, połączenia z Retell i ekranu (R6-1a…1e). R6-1a/1b: PR #527; R6-1b cz. 2: PR #530; R6-1c: PR #529; R6-1d: PR #528; R6-1c cz. 2: PR #531; R6-1c cz. 3: PR #533; R6-1c cz. 4: PR #534; R6-1c cz. 5: PR #535; R6-1c cz. 6: PR #536; R6-1c cz. 7: PR #539; R6-1c cz. 8: PR #540; transkrypt w podglądzie (#542): PR #543 |
| Podpięcie do limitów pakietów (FREE 1; PRESELEKCJA, WERYFIKACJA, AC po 10) | W TOKU (przyznanie puli przez operatora gotowe; sprawdzanie limitu, rezerwacja, rozliczenie i zwrot nieodbytej rozmowy gotowe i potwierdzone testem bazy, także przy równoległych zleceniach; pula z pakietu przyznawana automatycznie osobno dla każdego pakietu, bez podwójnego przyznania, oraz przygotowane, nieużywane miejsce na dokupione rozmowy — ważność puli 3 miesiące jak pakiet CV (decyzja 20.11.2026, 18:31) — w PR #553 (scalenie do `integration` zatwierdzone przez właściciela 20.11.2026, 18:31, po przeglądzie); zostaje: wywołanie przy zlecaniu rozmowy z ekranu rekrutera, gdy ten ekran powstanie, oraz zakup dodatkowych rozmów po decyzji o cenie) | PR #532, PR #544, PR #553 |

### R7. Płatności Stripe w tym repozytorium (od 19.11.2026)

Decyzja 19.11.2026 (`docs/DECYZJE.md`): Stripe zamiast Przelewy24, to samo konto KTIG Consulting co
`skillcheck-preselekcja`. Prawdziwe pieniądze dopiero po wpisaniu kluczy na żywo przez właściciela.

| Krok | Status | Dowód |
|---|---|---|
| Zdjęcie `PAYMENT_PATH_FREEZE` z publikatora (`.github/workflows/auto-release.yml`) i testów polityki wydań | DO SPRAWDZENIA (zamrożenie usunięte w całości: `PAYMENT_PATH_FREEZE` i `PAYMENT_CONTENT_FREEZE`; zostaje tylko blokada kodu, który rusza pieniądze lub faktury — `PAYMENTS`; działa na produkcji po promocji #564 na `main`) | kod: PR #564, zasady: PR #565 |
| Zakup PRESELEKCJI, WERYFIKACJI i ASSESSMENT CENTER przez Stripe Checkout (wzór: `skillcheck-preselekcja`), ceny z `docs/cennik-2026-11-02.md`, domyślnie wyłączony do czasu kluczy | W TOKU (PRESELEKCJA w całych pakietach po 60 CV, WERYFIKACJA i ASSESSMENT CENTER po jednym pakiecie; tylko tryb testowy, domyślnie wyłączone; opłacony pakiet AC pozwala utworzyć sesję AC; bez faktur i bez dopłaty za CV ponad pulę) | PR #556, #563 |
| Usunięcie kodu Przelewy24 | W TOKU (część 1: kod płatności, trasy, panel operatora i ekran zakupu bez Przelewy24; cz. 2 (teksty stron): PR #567 — teksty stron publicznych i kalkulatora mówią o Stripe; zostają martwe gałęzie w komponencie zakupu (PR #563), regulamin w wersji .docx, dokumentacja oraz lista plików w workflow) | PR #562, PR #567 |
| Limit kosztu rozmów voicebota 50 zł miesięcznie w aplikacji (blokada nowych rozmów i powiadomienie właściciela) | W TOKU (blokada w bazie i alert dla właściciela w bazie; każda rozmowa rezerwuje 15 zł, czyli jej najwyższy możliwy koszt, więc limitu nie da się przekroczyć także bez rozliczenia rzeczywistych kosztów — przy obecnej rezerwie mieszczą się 3 rozmowy w miesiącu; usunięcie danych kandydata nie zmienia miesięcznej sumy; rzeczywisty koszt rozmowy z webhooka Retell (call_analyzed, przeliczony po stałym kursie 4,50 zł/USD) zastępuje rezerwę raz na rozmowę, a koszt wyższy niż rezerwa blokuje resztę miesiąca; zostaje wysyłka powiadomienia właściciela) | PR #558, PR #561 |

## Wstrzymane do pierwszej sprzedaży

Nie podejmować i nie proponować: SC-020 white-label (issue #21); SC-021 bramka AI i kontrola
kosztów (issue #81); Quality of Hire; talent pool; chatbot informacyjny (SC-022); automatyzacja
Fakturowni w tym repozytorium (decyzja dla `skillcheck-preselekcja` — zob. `docs/DECYZJE.md`, 17.11.2026, 14:34);
analiza treści rozmów.

## Poza tym repozytorium

Sprzedaż FREE i PRESELEKCJI oraz Stripe: `krzysztofsyska/skillcheck-preselekcja` (etap 1).
W `skillcheck-core` zamrożenie ścieżki płatności zdjęte 19.11.2026 — zob. R7.

## Utrzymanie wydań

Tylko otwarte zadania, bez których gotowa funkcja nie może wejść na produkcję.

| Zadanie | Status | Dowód |
|---|---|---|
| [#369](https://github.com/krzysztofsyska/skillcheck-core/issues/369) — polityka wydań i automatyczny publikator | W TOKU (publikator działa, issue otwarte) | `.github/workflows/auto-release.yml` |
| [#461](https://github.com/krzysztofsyska/skillcheck-core/issues/461) — wdrożenie screening-worker razem z wydaniem; do końca obowiązuje bramka `WORKER_DEPLOY_REQUIRED` | W TOKU (etap 1 scalony) | PR #465 |
| [#491](https://github.com/krzysztofsyska/skillcheck-core/issues/491) — publikator sam wgrywa bezpieczne migracje (droga B) | W TOKU (publikator scalony; sekret i środowisko — niżej) | PR #499 |

## Porządki przyspieszające pracę (17.11.2026)

| Zadanie | Status | Dowód |
|---|---|---|
| J3 — usunięcie starego automatu z czasów Cursora (`tools/agent-pipeline`, workflowy `agent-*.yml`, `.cursor/rules`, polecenia dla Cursora w `docs/`); instrukcje AGENTS/CLAUDE już uporządkowane w tym PR | ZROBIONE (po scaleniu PR #514) | PR [#514](https://github.com/krzysztofsyska/skillcheck-core/pull/514): usunięte 116 plików starego kontrolera; zostały tylko pliki używane przez `checks.yml`, `agent-gates.yml`, `sales-release-scope.yml` i `auto-release.yml` |

## Czeka na właściciela (przy komputerze)

Rzeczy, których agent nie może zrobić sam. Szczegóły i linki są w podanych issue.

| Sprawa | Gdzie |
|---|---|
| Trzy klucze testu kompetencji w Vercel (tylko Preview `integration`) — reszta przygotowana przez agenta | `docs/checks/r1-preview-setup-2026-11-18.md` |
| Zmiana sekretu `request_secret_current` (rotacja z audytu bezpieczeństwa) | issue [#420](https://github.com/krzysztofsyska/skillcheck-core/issues/420) |
| Sekret i środowisko dla automatycznego wgrywania migracji (droga B) — po scaleniu PR #499 | issue [#491](https://github.com/krzysztofsyska/skillcheck-core/issues/491) |
