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

Kolejność ustalona w przeglądzie SC-000–SC-021 (26.11.2026, `docs/DECYZJE.md`): najpierw R0, potem
R1 (SC-014), R2 (SC-015), R3 (SC-016) i R7 (SC-019). R6 bez zmian. R8 i R9 idą równolegle,
z niższym priorytetem: może je brać osobna sesja wykonawcy, ale nie mogą blokować R0–R3 ani R7.
Przypisanie wszystkich numerów SC — w sekcji „Rejestr numerów SC” niżej.

### R0. Fundament i preselekcja CV w core — pełny test (SC-002–SC-010, od 26.11.2026)

Testy na Preview (`skillcheck-preview`) i danych fikcyjnych. Na produkcji tylko odczyt i testy
dymne publikatora; zmiany bazy produkcyjnej wyłącznie przez `db-migrate-production` po zgodzie
właściciela. Kroki SC-005–SC-009 to jedna droga klienta: wgranie CV → analiza AI → zatwierdzenie →
ranking i shortlista → raport i pobranie.

| Krok | Gotowe, gdy | Status | Dowód |
|---|---|---|---|
| SC-002 — zgodność bazy: Preview, produkcja i kod (produkcja ma wszystkie migracje z `main` od 25.11.2026, zob. R7) | jest raport różnic (`docs/checks/`); każda różnica jest poprawiona albo opisana jako osobny krok; ponowne porównanie nie pokazuje rozbieżności | W TOKU (raport różnic: `docs/checks/sc002-db-parity-2026-11-26.md`; Preview wyrównana z kodem 27.11.2026: dograne 4 brakujące migracje, w tym zatwierdzanie wyników analizy CV, ponowne porównanie — każda migracja z kodu jest na Preview z identyczną treścią (`docs/checks/sc002b-preview-sync-2026-11-27.md`); zostają opisane pozostałości tylko na Preview (schemat `checkout` i 3 wpisy w rejestrze, do decyzji: usunąć czy zostawić); porównanie z produkcją na żywo NOT RUN — brak potwierdzonego połączenia tylko do odczytu) | PR #615, PR #625 |
| SC-004 — izolacja firm: dwie fikcyjne firmy, różne role, praca równoczesna | automatyczny test w stałym zestawie testów pokazuje, że żadna firma nie widzi ani nie zmienia ocen, historii i danych drugiej | ZROBIONE | PR #614: `tests/tenant-isolation-database.test.mjs` w `npm run test:db` (CI); lokalnie na PostgreSQL 16: nowy plik 10/10 podtestów (w tym dowód negatywny sprawdzający, że kontrola wykrywa wyciek) i cały `npm run test:db` 49/49 zielone |
| SC-005 + SC-006 — droga CV → wynik na ekranie dla ról: zarządzający, rekruter, tylko odczyt | test końcowy przechodzi na Preview; każda ocena ma uzasadnienie cytatem z CV; każda rola widzi i robi tylko to, co powinna | DO ZROBIENIA (analiza AI na Preview wymaga klucza dostawcy AI — zob. „Czeka na właściciela”) | — |
| SC-007 — brak podwójnego liczenia i oznaczanie starych wyników (po zmianach wgrywania wielu CV) | test: równoczesne próby i ponowienia zużywają limit raz; zmiana CV lub wymagań oznacza wynik jako nieaktualny | ZROBIONE | PR #616: test „SC-007” w `tests/cv-bulk-database.test.mjs` na pełnym łańcuchu migracji (test gotowy i zielony na PostgreSQL 16) |
| SC-003 — zgodność zapisu ocen z projektem (#4) | krótka lista zgodności i różnic w `docs/checks/`; różnice poprawione albo opisane jako osobne kroki | ZROBIONE | PR #622: `docs/checks/sc003-assessment-storage-2026-11-27.md` — 18 z 21 punktów zgodnych; ocena `verdict` zamiast `rating` opisana w projekcie, opis w `docs/database.md` poprawiony; brak historii poprawek człowieka per kryterium → osobny krok #621 (L3); różnica opisana w #621 |
| SC-008 — ranking i shortlista, także przy ocenie niepełnej lub nieaktualnej | test od ocenionych CV do zatwierdzonej shortlisty przechodzi; ocena niepełna lub nieaktualna jest wyraźnie oznaczona | ZROBIONE (test zielony lokalnie na PostgreSQL 16 z pełnym łańcuchem migracji, 25 z 25 testów; nie znaleziono błędu w kodzie aplikacji) | PR #617: test „SC-008 from assessed CVs…” w `tests/screening-ranking-database.test.mjs` |
| SC-009 — raport z preselekcji i pobranie pliku | test całej drogi przechodzi na Preview; przykładowy raport (zrzuty i plik w `docs/checks/`) wskazany w raporcie statusu do akceptacji właściciela | W TOKU (część bez klucza AI: test w bazie gotowy; zostaje przejście na Preview, które wymaga klucza dostawcy AI, i przykładowy raport do akceptacji właściciela) | PR #623: test „SC-009” w `tests/sc009-preselection-report-database.test.mjs` (`npm run test:candidate-report-db`) na pełnym łańcuchu migracji: właściwi kandydaci, oceny z uzasadnieniem i cytatem, oznaczenie oceny niepełnej, nieaktualnej i niezatwierdzonej, wpis w rejestrze przy pobraniu raportu kandydata, odmowa dla obcej firmy, osoby spoza firmy i niezalogowanej; znaleziona luka: plik CSV raportu preselekcji nie zapisuje wpisu w rejestrze pobrań (osobny krok L3) |
| SC-010 cz. A — zgody i usuwanie danych kandydata, bez wysyłania wiadomości | test na fikcyjnych kandydatach: zgody (kanały, godziny, historia) zapisane i respektowane; po żądaniu usunięcia danych nie ma w bazie, plikach CV, raportach i eksportach | ZROBIONE (test `tests/sc010a-consent-erasure-database.test.mjs` przechodzi lokalnie na PostgreSQL 16: zgody i historia zapisane i respektowane, po usunięciu brak danych w bazie i tekstach CV; plików CV poza bazą nie ma (jedyny zasobnik to logo marki). Znaleziona luka: wpisy dziennika eksportu raportu (`report_audit`, same identyfikatory, bez imion) zostają po usunięciu kandydata — wymaga osobnej migracji (L3), zapisana jako #619; godziny kontaktu egzekwuje test głosowy, nie ten) | PR #618; luka `report_audit` → #619 |
| SC-001 — aplikacja się uruchamia, strona działa, jest połączenie z bazą | punkt w końcowym teście całej aplikacji przechodzi; bez osobnego zadania | DO ZROBIENIA (w końcowym teście) | — |

SC-010 cz. B (prawdziwe wysyłki wiadomości) — wstrzymane; termin powrotu wskaże właściciel (każda prawdziwa wysyłka wymaga jego zgody).

### R1. Test kompetencji dla kandydata (etap 2)

Rekruter wybiera dla rekrutacji: zatwierdza zadania sam albo testy generują się i wychodzą
automatycznie. W obu trybach test dostaje tylko kandydat z shortlisty (reguła R1, pilnowana w bazie).

Przegląd 26.11.2026: to SC-014. Gotowe, gdy test końcowy obu trybów (ręczny i automatyczny)
przechodzi od wysłania testu do wyniku u rekrutera i w raporcie. Następne kroki po R0.

| Krok | Status | Dowód |
|---|---|---|
| C1–C5 — dane, podejścia i limity, wydawanie dostępu, strona kandydata (za flagą), ocena człowieka z cytatami | ZROBIONE | PR #273 |
| C6 — AI układa wspólne zadanie, rekruter zatwierdza | ZROBIONE | PR #285, #291, #293, #296, #322, #326, #332, #358 |
| C6 — pytania indywidualne z luk w CV kandydata z shortlisty | ZROBIONE (podgląd, tylko odczyt) | PR #490, #507 |
| Reguła R1 w bazie | ZROBIONE | PR #273 |
| Tryb automatyczny w bazie (`auto_release`) | ZROBIONE | PR #291 |
| Przełącznik rekrutera „zatwierdzam sam” / „automatycznie” na ekranie | ZROBIONE | PR #497 |
| Automatyczne wysłanie testu kandydatowi w trybie automatycznym | W TOKU (dostęp bez kliknięcia rekrutera; realna wysyłka do kandydata nadal zamknięta) | PR #510, PR #517, PR #545 |
| Włączenie testu kompetencji w Preview i przejście całej ścieżki | W TOKU (strona kandydata na Preview działa: 26.11.2026 kandydat z linkiem przeszedł przez pośrednika wejście, rozpoczęcie, szkic i wysłanie odpowiedzi, kod jest jednorazowy, kryteriów oceny nie widać — po poprawkach z PR #602 i #603; 26.11.2026 krok 8b PASS: sekcja testu kompetencji widoczna na raporcie kandydata, na koncie testowym rekrutera w Preview; zostaje krok 3a — NOT RUN, bo na Preview brak klucza dostawcy AI, decyzja właściciela) | ścieżka ręczna przeszła w bazie Preview; zmienne: PR #599; kod przyczyny 503 w logu: PR #601; połączenie przez pooler: PR #602; kontrola uprawnień: PR #603; przejścia: `docs/checks/r1-preview-walk-2026-11-25.md`, `docs/checks/r1-preview-walk-2026-11-26.md` (PR #604), `docs/checks/r1-preview-walk-2026-11-26b.md` |

### R2. Rozszerzony raport kandydata, bez części głosowej (etap 2)

Przegląd 26.11.2026: to SC-015. Zostaje: po R1 jedna pełna próbna rekrutacja i raport FREE
i WERYFIKACJA (oceny, cytaty, historyczne wersje, uprawnienia, wydruk) wskazany w raporcie statusu
do akceptacji właściciela.

| Krok | Status | Dowód |
|---|---|---|
| A — opis raportu (CV, test, ćwiczenia, etapy) | ZROBIONE | PR #269, #498 |
| B — wymagania z CV | ZROBIONE | `lib/candidate-report.ts` |
| B — sekcja testu kompetencji | ZROBIONE | PR #496 |
| B — sekcje ćwiczeń i etapów rekrutacji (dane, ekran, wydruk A4) | ZROBIONE | PR #501, #505 |
| C — ekran raportu i wydruk A4 | ZROBIONE | PR #483 |
| D — eksport CSV z rejestrem dostępu, historia eksportów (raport i firma) | ZROBIONE | PR #476, #477, #482 |
| Przejście całego raportu na Preview na danych testowych | ZROBIONE (26.11.2026 na Preview: wymagania z CV, test kompetencji, ćwiczenia, etapy i decyzja, wydruk A4, CSV z rejestrem i historią, B1 i O1 — PASS jako rekruter; widok historii eksportów firmy jako właściciel firmy — PASS na osobnej firmie testowej, w tym brak danych obcych firm i komunikat dla rekrutera; NOT RUN: stronicowanie przy 100+ wpisach i wpis byłego członka firmy „former_member”) | sprawdzenie 18.11.2026; poprawka B1: PR #521; O1 (grupy „nieaktualny”) — PR #520; ponowne sprawdzenie B1 i O1: PR #524; przejście 26.11.2026: `docs/checks/r2-preview-walk-2026-11-26.md`, zrzuty w `docs/checks/screens-r2-2026-11-26/`; widok właściciela 26.11.2026: `docs/checks/r2-preview-walk-2026-11-26b.md`, zrzuty w `docs/checks/screens-r2-2026-11-26b/` (PR #607) |

### R3. Assessment Center — pełny przepływ (etap 3, issue #338)

Przegląd 26.11.2026: to SC-016, po R2. Gotowe, gdy jest zasada, kto może być asesorem, pełna sesja
z dwoma asesorami na fikcyjnych uczestnikach przechodzi od ćwiczeń do raportu, a konto bez pakietu
AC nie ma dostępu (konto z pakietem ma).

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
| W2b — suwak liczby CV co 5 | ZROBIONE (za flagą PRICING_CV_SLIDER_ENABLED, domyślnie wyłączoną; serwer przy zamówieniu sprawdza liczbę CV: co 5, w granicach pakietu, zgodna z liczbą pakietów, inaczej odmowa z polskim komunikatem; przy włączonej fladze formularz zakupu wysyła też wybraną pulę CV, a odmowę serwera pokazuje po polsku; przy wyłączonej formularz działa jak dotąd) | PR #286 (część 1), część 2: PR #552, walidacja na serwerze: PR #574, formularz zakupu: PR #577 |
| W3, W4 — publiczny cennik z katalogu, za wyłączoną flagą | ZROBIONE (W3 i W4 za wyłączonymi flagami PRICING_PAID_OPTIONS_ENABLED i PRICING_PUBLIC_CATALOG_ENABLED; włączenie flag — decyzja właściciela, TAK/NIE z liczbami przed i po) | W3: PR #557, W4: PR #559 |

### R6. Voicebot — równolegle z R1–R3 (od 18.11.2026)

Przegląd 26.11.2026: SC-011 i SC-012 — budowa trwa bez zmian (korekta właściciela 26.11.2026,
22:10). SC-013 (ocena treści rozmów) zostaje wstrzymane.

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
| Architektura i MVP rozmowy (dawne SC-011, SC-012) | W TOKU (sprawdzone 18.11.2026) | audyt PR #526, `docs/checks/r6-voice-audit-2026-11-18.md`: fundamenty działają tylko na sztucznym dostawcy i bazie testowej; brakuje migracji, webhooka, połączenia z Retell i ekranu (R6-1a…1e). R6-1a/1b: PR #527; R6-1b cz. 2: PR #530; R6-1c: PR #529; R6-1d: PR #528; R6-1c cz. 2: PR #531; R6-1c cz. 3: PR #533; R6-1c cz. 4: PR #534; R6-1c cz. 5: PR #535; R6-1c cz. 6: PR #536; R6-1c cz. 7: PR #539; R6-1c cz. 8: PR #540; transkrypt w podglądzie (#542): PR #543; R6-1e (webhook Retell w Preview, domyślnie wyłączony): PR #584; R6-1e cz. 2 (rola bazy dla webhooka, migracja): PR #585 |
| Podpięcie do limitów pakietów (FREE 1; PRESELEKCJA, WERYFIKACJA, AC po 10) | W TOKU (przyznanie puli przez operatora gotowe; sprawdzanie limitu, rezerwacja, rozliczenie i zwrot nieodbytej rozmowy gotowe i potwierdzone testem bazy, także przy równoległych zleceniach; pula z pakietu przyznawana automatycznie osobno dla każdego pakietu, bez podwójnego przyznania, oraz przygotowane, nieużywane miejsce na dokupione rozmowy — ważność puli 3 miesiące jak pakiet CV (decyzja 20.11.2026, 18:31) — w PR #553 (scalenie do `integration` zatwierdzone przez właściciela 20.11.2026, 18:31, po przeglądzie); poprawka: zakup kilku pakietów jedną płatnością lub jednym zamówieniem daje 10 rozmów za każdy pakiet (wcześniej 10 za całą płatność), bez podwójnego przyznania — PR #572; na ekranie rekrutera (tylko podgląd, niewidoczny dla klientów) przycisk zlecenia rozmowy pokazuje pozostałą pulę i jasny komunikat, gdy pula jest pusta albo miesięczny limit 50 zł blokuje nowe rozmowy — PR #573; poprawka: jeden pakiet WERYFIKACJA lub AC kupiony przez Stripe z dodatkowymi CV daje 10 rozmów (nie 20) i jest liczony jako ten pakiet, nie jako PRESELEKCJA — PR #586; zostaje: rezerwacja i prawdziwe zlecenie rozmowy z tego ekranu, gdy właściciel otworzy prawdziwe rozmowy, oraz zakup dodatkowych rozmów po decyzji o cenie) | PR #532, PR #544, PR #553, PR #572, PR #573, PR #586 |

### R7. Płatności Stripe w tym repozytorium (od 19.11.2026)

Decyzja 19.11.2026 (`docs/DECYZJE.md`): Stripe zamiast Przelewy24, to samo konto KTIG Consulting co
`skillcheck-preselekcja`. Prawdziwe pieniądze dopiero po wpisaniu kluczy na żywo przez właściciela.

Przegląd 26.11.2026: to SC-019. Sklep WERYFIKACJI i ASSESSMENT CENTER zostaje w core (korekta
właściciela 26.11.2026, 22:10); bez połączenia ze sklepem `skillcheck-preselekcja`. Gotowe, gdy na
fikcyjnej firmie przechodzi: zakup (tryb testowy Stripe) → zapłata → otwarty właściwy pakiet
i limity → wykorzystanie; bez zakupu dostępu nie ma.

| Krok | Status | Dowód |
|---|---|---|
| Zdjęcie `PAYMENT_PATH_FREEZE` z publikatora (`.github/workflows/auto-release.yml`) i testów polityki wydań | ZROBIONE (zamrożenie usunięte w całości: `PAYMENT_PATH_FREEZE` i `PAYMENT_CONTENT_FREEZE`; zostaje tylko blokada kodu, który rusza pieniądze lub faktury — `PAYMENTS`; na `main` od promocji PR #566, 21.11.2026) | kod: PR #564, zasady: PR #565, na `main`: PR #566 |
| Zakup PRESELEKCJI, WERYFIKACJI i ASSESSMENT CENTER przez Stripe Checkout (wzór: `skillcheck-preselekcja`), ceny z `docs/cennik-2026-11-02.md`, domyślnie wyłączony do czasu kluczy | W TOKU (PRESELEKCJA w całych pakietach po 60 CV, WERYFIKACJA i ASSESSMENT CENTER po jednym pakiecie; tylko tryb testowy, domyślnie wyłączone; opłacony pakiet AC pozwala utworzyć sesję AC; wygasła, nieopłacona sesja płatności zamyka zamówienie bez przyznania pakietu i firma może kupić ponownie — PR #578 (wymaga migracji w bazie po zatwierdzeniu przez właściciela); adres płatności Stripe z fragmentem `#…` przyjmowany (poprawka Codex P1 z #566) — PR #580; dopłata za CV ponad pulę bazową dla WERYFIKACJI i ASSESSMENT CENTER (co 5 CV, do 150 CV, 0,16 zł netto za każde dodatkowe CV, np. WERYFIKACJA 100 CV = 622,87 zł) działa za flagą PRICING_CV_SLIDER_ENABLED w trybie testowym — PR #581 (wymaga migracji w bazie po zatwierdzeniu przez właściciela); zamówienie, którego sesja Stripe wygasła, zanim aplikacja zdążyła ją zapisać (utracona odpowiedź Stripe), też się zamyka bez przyznania pakietu i nie blokuje kolejnego zakupu (poprawka Codex P2 z #566) — PR #582; bez faktur) | PR #556, #563, #578, #580, #581, #582, #583 |
| Prawdziwe płatności Stripe (konto KTIG), faktura VAT z Fakturowni po opłaceniu i faktura korygująca po zwrocie (istniejące zmienne `FAKTUROWNIA_*`), zapis `STRIPE_WEBHOOK_SECRET` w Vercelu przez sesję wykonawcy tylko dla tego zadania (decyzja właściciela 20.11.2026, 18:29, punkt 5, `docs/DECYZJE.md`) | W TOKU (kod w PR #591, na `main` od promocji PR #594 (21.11.2026): prawdziwe płatności tylko za PRESELEKCJĘ, na skillcheck.pl, przy włączonej sprzedaży `SC19_PACKAGES_ENABLED` i działającej Fakturowni; WERYFIKACJA i ASSESSMENT CENTER za prawdziwe pieniądze „wkrótce”; jedna faktura VAT na płatność, bez faktury za zakup kontrolny KTIG; faktura korygująca po zwrocie; zwrot nie zmniejsza puli CV automatycznie; jednorazowy endpoint konfiguracji Stripe; panel operatora pokazuje faktury i korekty do sprawdzenia oraz opłacone zamówienia bez faktury — PR #597; migracje wgrane na produkcję przez właściciela 25.11.2026 (uruchomienie `db-migrate-production` nr 19, produkcja ma wszystkie 112 migracji z `main`); zostaje: wpisanie sekretu webhooka, włączenie sprzedaży) | PR #591, #594, #597, #599 |
| Usunięcie kodu Przelewy24 | ZROBIONE (część 1: kod płatności, trasy, panel operatora i ekran zakupu bez Przelewy24; cz. 2 (teksty stron): PR #567 — teksty stron publicznych i kalkulatora mówią o Stripe; cz. 3 (dokumenty prawne): PR #570 — regulamin i polityka prywatności nazywają Stripe, wersja zgody r4, także w wersji .docx; archiwalne dokumenty P24 w `docs/` oznaczone jako nieaktualne: PR #571; cz. 4 (komponent zakupu): PR #575 — usunięte martwe gałęzie Przelewy24 w komponencie zakupu (sandbox, kody P24, tekst PayPro); cz. 5 (CI): PR #576 — usunięte wpisy nieistniejących plików Przelewy24 z workflow płatności; cz. 6 (polityka prywatności § 6 — Stripe wśród dostawców poza EOG, także w .docx): PR #579; testy pilnujące, że kod Przelewy24 nie wraca, zostają) | PR #562, PR #567; dokumenty prawne: PR #570; dokumentacja archiwalna: PR #571; komponent zakupu: PR #575; CI: PR #576; polityka prywatności § 6: PR #579 |
| Limit kosztu rozmów voicebota 50 zł miesięcznie w aplikacji (blokada nowych rozmów i powiadomienie właściciela) | W TOKU (blokada w bazie i alert dla właściciela w bazie; każda rozmowa rezerwuje 15 zł, czyli jej najwyższy możliwy koszt, więc limitu nie da się przekroczyć także bez rozliczenia rzeczywistych kosztów — przy obecnej rezerwie mieszczą się 3 rozmowy w miesiącu; usunięcie danych kandydata nie zmienia miesięcznej sumy; rzeczywisty koszt rozmowy z webhooka Retell (call_analyzed, przeliczony po stałym kursie 4,50 zł/USD) zastępuje rezerwę raz na rozmowę, a koszt wyższy niż rezerwa blokuje resztę miesiąca; alert dla właściciela jest widoczny w panelu operatora „Koszty AI i marża” razem z limitem, kosztem od początku miesiąca i informacją, czy nowe rozmowy są wstrzymane (PR #568); zostaje zewnętrzne powiadomienie (e-mail) — to nowa prawdziwa wysyłka i wymaga zgody właściciela) | PR #558, PR #561, PR #568 |

### R8. White-label — SkillCheck pod marką klienta (SC-020, issue #21; równolegle, niższy priorytet)

Nie przepisywać istniejącego kodu. Bez nowych kosztów (domeny testowe tylko darmowe lub już
posiadane; inaczej pytanie do właściciela). Wycena — decyzja właściciela, poza tym repozytorium.

| Krok | Gotowe, gdy | Status | Dowód |
|---|---|---|---|
| Dwie fikcyjne firmy z własnym logo, kolorami, raportem i adresem strony na Preview | test końcowy dwóch marek przechodzi: każda firma widzi tylko swoją markę i swoje dane | DO ZROBIENIA | — |
| Instrukcja uruchomienia dla nowego klienta (co klient ustawia w swojej domenie) | plik w `docs/` | DO ZROBIENIA | — |

### R9. Kontrola kosztów AI i wybór modelu (SC-021, issue #81; równolegle, niższy priorytet)

| Krok | Gotowe, gdy | Status | Dowód |
|---|---|---|---|
| Test na dwóch fikcyjnych firmach na Preview: koszt każdego zlecenia, limity budżetu, ostrzeżenie, rozdzielenie budżetów, wybór modelu | test końcowy przechodzi; policzone koszty różnią się od rachunku dostawcy AI o mniej niż 5% | DO ZROBIENIA (wymaga klucza dostawcy AI na Preview — zob. „Czeka na właściciela”) | — |
| Włączenie na produkcji przed pierwszą płatną sprzedażą | mechanizm włączony; zmiana ustawień produkcji tylko za zgodą właściciela | DO ZROBIENIA | — |

## Wstrzymane do pierwszej sprzedaży

Nie podejmować i nie proponować (warunek powrotu w nawiasie): SC-017 Quality of Hire (rozpoczęta
sprzedaż i realne dane z rekrutacji klientów); SC-018 talent pool (zrobione R0 SC-010 cz. A
i działające R0–R3); SC-013 analiza treści rozmów (do pierwszej sprzedaży); SC-010 cz. B prawdziwe
wysyłki wiadomości (termin wskaże właściciel); chatbot informacyjny (SC-022).

## Rejestr numerów SC (przegląd 26.11.2026)

| SC | Gdzie | Stan decyzji |
|---|---|---|
| SC-000 | — | numer pusty („nieodnalezione”), bez zadań |
| SC-001 | R0 (końcowy test) | bez osobnego zadania |
| SC-002–SC-010 cz. A | R0 | teraz, najpierw |
| SC-010 cz. B | Wstrzymane | termin powrotu wskaże właściciel |
| SC-011, SC-012 | R6 | budowa trwa |
| SC-013 | Wstrzymane | do pierwszej sprzedaży |
| SC-014 / SC-015 / SC-016 | R1 / R2 / R3 | teraz, po R0, w tej kolejności |
| SC-017, SC-018 | Wstrzymane | warunki wyżej |
| SC-019 | R7 | sklep w core |
| SC-020 / SC-021 | R8 / R9 | równolegle, niższy priorytet |

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
| Zmiana sekretu `request_secret_current` (rotacja z audytu bezpieczeństwa) | issue [#420](https://github.com/krzysztofsyska/skillcheck-core/issues/420) |
| Sekret i środowisko dla automatycznego wgrywania migracji (droga B) — po scaleniu PR #499 | issue [#491](https://github.com/krzysztofsyska/skillcheck-core/issues/491) |
| Klucz dostawcy AI na Preview (nowy koszt) — potrzebny do R0 SC-005, R1 krok 3a i R9 | R1, R0, R9 w tym pliku |
| Akceptacja przykładowych raportów (R0 SC-009, R2) | raport statusu |
