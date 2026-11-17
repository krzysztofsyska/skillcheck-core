# SkillCheck — kolejność prac (ROADMAP)

## Zasady tego pliku

1. **To jedyne źródło kolejności prac.** `CLAUDE.md`, `AGENTS.md`, `docs/BACKLOG.md` i kolejka w
   [#367](https://github.com/krzysztofsyska/skillcheck-core/issues/367) tylko na nie wskazują. Gdy
   coś się nie zgadza, obowiązuje ten plik.
2. **Plik zmienia się wyłącznie na polecenie właściciela.** Agent nie dopisuje, nie usuwa i nie
   przestawia pozycji ani statusów z własnej inicjatywy. Bieżący stan kroku sprawdza w git, issue i PR.
3. **Decyzję właściciela wolno zapisać tylko jako dosłowny cytat jego wiadomości z datą.** Agent nie
   streszcza jej własnymi słowami.

Bramki bezpieczeństwa (zamrożenie ścieżki płatności, migracje tylko przez `db-migrate-production` po
zgodzie właściciela, zakaz zmiany sekretów, ustawień i środowisk, kasowania danych, nowych kosztów i
nowych realnych wysyłek, polityka wydań z #369) są w `AGENTS.md` i `CLAUDE.md`. Ten plik ich nie
zmienia i nie otwiera.

Statusy ustalono 17.11.2026 z kodu na `integration` (`9657ee8`) oraz z issue i PR. Status kroku
oznacza stan na `integration`, nie na produkcji.

## Decyzje właściciela 16.11.2026

Czat przedstawił poniższe rekomendacje, właściciel odpowiedział **„tak jak polecasz"**
(16.11.2026, 22:39):

- „Gdzie sprzedajemy najpierw. Polecam FREE i PRESELEKCJĘ z nowej aplikacji skillcheck-preselekcja na Stripe, a w skillcheck-core budowę WERYFIKACJI i Assessment Center."
- „Pakiety na stronie. WERYFIKACJA i Assessment Center zniknęły ze strony tylko z powodu Przelewy24. Skoro z P24 rezygnujesz, polecam je przywrócić z cenami 615 zł i 1 499 zł."
- „Voicebot. Rozumiem to tak: docelowo w każdym pakiecie (FREE 1 rozmowa, płatne 10), budowany na końcu, do tego czasu niewidoczny na stronie."
- „Zatwierdzanie testów. 6 listopada zdecydowałeś, że rekruter może puścić testy automatycznie (…). Poprawię zapis na Twoją wersję."
- „White-label i bramka AI (SC-020, SC-021). Polecam wstrzymać je do pierwszej sprzedaży."

Uwaga do czwartej pozycji: „(…)" to skrót samej rekomendacji czatu — w takiej postaci zapisano ją
w poleceniu właściciela, z którego pochodzi ten cytat; pełniejszego dosłownego brzmienia w repozytorium
nie ma. Dosłowną odpowiedzią właściciela na wszystkie pięć pozycji jest wyłącznie „tak jak polecasz"
(16.11.2026, 22:39).

## Decyzje właściciela 17.11.2026

Zapisane na polecenie właściciela z 17.11.2026 (zadania jednorazowe J1 i J2). Cytaty dosłowne z czatu.

**Automatyczne wgrywanie bezpiecznych zmian bazy (J1, issue [#491](https://github.com/krzysztofsyska/skillcheck-core/issues/491)).**
Droga B w czacie brzmiała: „B. Automat dla bezpiecznych zmian — Zmiany, które tylko dodają (nowa tabela, nowa kolumna), idą same po sprawdzeniu świeżej kopii; kasujące lub przerabiające dane dalej czekają na Ciebie". Właściciel:

- 07:20 „Na pierwsze pytanie to będzie B"
- 07:25 „Część pierwsza to uruchom."

**Gwarancja PRESELEKCJI (J2, issue [#492](https://github.com/krzysztofsyska/skillcheck-core/issues/492)).** Właściciel:

- 07:25 „Jest powtórka połączona ze zwrotem. Najpierw poprawiamy za darmo, a jeżeli nie pasuje, oddajemy pieniądze. […] Minimum 5 kandydatów."
- 07:49 „Ok" — w odpowiedzi na trzy doprecyzowania czatu: kandydat „wart rozmowy" spełnia wszystkie wymagania konieczne klienta; zwrot dopiero po powtórce z udziałem klienta; gwarancja działa także przy słabym naborze, ale tylko dla pierwszych 20 firm.
- 07:53 „Termin zgłoszenia gwarancji to 7 dni od otrzymania raportu. Zapis o gwarancji nie idzie do prawnika, tylko od razu do polityki."
- 07:56 „Musi zostać załadowana do obu baz, i zarówno do skill check core, jak i skill check preselekcja. Dobrze, przeniesiemy go przy okazji podłączenia Stripe'a."

Uwaga: „[…]" to skrót w poleceniu właściciela, z którego pochodzi cytat; pełniejszego brzmienia w
repozytorium nie ma. Zgodnie z wiadomością z 07:56 zapis trafia teraz do `skillcheck-core`, a do
`skillcheck-preselekcja` przy podłączaniu Stripe'a.

## Kolejność funkcji

Wykonawca bierze pierwszy wolny krok z najwyższej pozycji, pomijając pozycje oznaczone CZEKA.

### R1. Test kompetencji dla kandydata (SC-014-C1…C6 i reguła R1)

W tym wybór rekrutera: zatwierdza zadania sam albo testy generują się i wychodzą automatycznie.

| Krok | Status | Dowód |
|---|---|---|
| C1 — dane i migracja testu | ZROBIONE | PR #273 (`20261106063720_sc_wer_c1_inventory_r12.sql`) |
| C2 — obsługa podejść kandydata i limity | ZROBIONE | PR #273 (`lib/competency-attempt-broker-runtime.ts`) |
| C3 — rekruter wydaje, odnawia i cofa dostęp | ZROBIONE | PR #273 |
| C4 — strona kandydata z testem | ZROBIONE (za flagą, domyślnie wyłączone) | PR #273 (`app/zadanie-kompetencyjne/`) |
| C5 — ocena odpowiedzi przez człowieka, z cytatami | ZROBIONE | PR #273 |
| C6 — AI układa wspólne zadanie, rekruter zatwierdza | ZROBIONE | PR #285, #291, #293, #296, #322, #326, #332, #358 |
| C6 — pytania indywidualne z luk w CV kandydata | W TOKU | logika w `lib/exercise-ai.ts` (`buildIndividualQuestions`), nieużywana jeszcze w `app/` |
| Reguła R1 — test tylko dla kandydata z shortlisty, pilnowane w bazie | ZROBIONE | PR #273 (sprawdzenie `recruitment_shortlist_entries` w migracji C1) |
| Tryb automatyczny w bazie (`auto_release`, zapis trybu zwolnienia) | ZROBIONE | PR #291 |
| Przełącznik rekrutera: „zatwierdzam sam" / „automatycznie" na ekranie | DO ZROBIENIA | brak wywołania `set_auto_release` w `app/` i `lib/` |
| Automatyczne wysłanie testu kandydatowi w trybie automatycznym | DO ZROBIENIA | `docs/plan-budowy-2026-11-02.md` (C6) miał to poza zakresem; decyzja z 16.11.2026 wyżej |
| Włączenie testu kompetencji w Preview i przejście ścieżki | DO SPRAWDZENIA | brak dowodu w issue/PR |

### R2. Rozszerzony raport kandydata (SC-015-A…D), bez części głosowej

| Krok | Status | Dowód |
|---|---|---|
| A — opis raportu | W TOKU | jest `docs/sc-015-free-candidate-report.md` (PR #269) dla raportu z CV; brak opisu sekcji testu i ćwiczeń |
| B — zbieranie danych do raportu: wymagania z CV | ZROBIONE | `lib/candidate-report.ts` |
| B — sekcje testu kompetencji, ćwiczeń i etapów w raporcie | DO ZROBIENIA | `lib/candidate-report.ts` czyta dziś tylko wymagania z CV |
| C — ekran raportu i wydruk A4 | ZROBIONE | PR #483 |
| D — eksport CSV z rejestrem dostępu | ZROBIONE | PR #476 |
| D2 — historia eksportów na raporcie | ZROBIONE | PR #477 |
| D3 — historia eksportów dla całej firmy | ZROBIONE | PR #482 |

### R3. Assessment Center — pełny przepływ (issue #338)

| Krok | Status | Dowód |
|---|---|---|
| Arkusze ćwiczeń i raport z dowodów | ZROBIONE | PR #272, #378 (issue #271 nadal otwarte) |
| Sesja finalistów: dwóch niezależnych asesorów, limit 10 osób, druga próba | ZROBIONE (za flagą `AC_PAIRED_SHEETS_PREVIEW`) | PR #434, #471 (issue #276 nadal otwarte) |
| Eksport CSV podsumowania sesji | ZROBIONE | PR #480 |
| Rejestr pobrań CSV sesji | ZROBIONE | PR #486 |
| Powiązanie z kontami firm, uprawnieniami i kupionym pakietem | DO ZROBIENIA | issue #338, #274, #283 |
| Asesorzy pokazani z nazwy, nie z identyfikatora | DO ZROBIENIA | znany brak opisany w PR #434 |

### R4. Powrót pakietów WERYFIKACJA i ASSESSMENT CENTER na stronę oferty

WERYFIKACJA (615 zł brutto / 60 CV) i ASSESSMENT CENTER (1 499 zł brutto / 50 CV), z opisem
zawartości i informacją, że nie można ich jeszcze kupić; bez wzmianki o rozmowach z botem. To zmiana
treści strony; nie zmienia integracji płatności, przepływu zakupu, cen w katalogu ani stanów zamówień.

| Krok | Status | Dowód |
|---|---|---|
| Ukrycie pakietów na czas weryfikacji Przelewy24 | ZROBIONE (do odwrócenia) | PR #398, issue #397 (`lib/public-future-offers.ts`) |
| Pakiety widoczne na stronie głównej, w kalkulatorze i na stronie płatności, z dopiskiem „nie można jeszcze kupić" i bez wzmianki o bocie | DO ZROBIENIA | dziś ukryte, gdy `PUBLIC_FUTURE_OFFERS_ENABLED` nie jest `true` (`.env.example` ma `false`); wartość na produkcji DO SPRAWDZENIA |
| Gwarancja wyniku PRESELEKCJI w regulaminie (nowa wersja dokumentu) i na stronie oferty przy PRESELEKCJI; zwrot wykonuje operator poza aplikacją; bez zmiany ceny, katalogu, przepływu zakupu i płatności | DO ZROBIENIA | issue #492 (polecenie właściciela 17.11.2026, cytaty wyżej) |

### R5. Kalkulator wyceny (SC-PRICING-W1…W4) — CZEKA

**CZEKA na zdjęcie zamrożenia ścieżki płatności przez właściciela.** Do tego czasu nie podejmować.

| Krok | Status | Dowód |
|---|---|---|
| W1 + W2 — audyt źródeł cennika i katalog cen w bazie | ZROBIONE | PR #265 |
| W2b — suwak liczby CV co 5 | W TOKU (część 1/2) | PR #286; części 2/2 brak |
| W3 | DO ZROBIENIA (CZEKA) | brak PR |
| W4 — publiczny cennik z katalogu, za wyłączoną flagą | DO ZROBIENIA (CZEKA) | brak PR |

### R6. Voicebot — na końcu, po R1–R3

Docelowo w każdym pakiecie (FREE 1 rozmowa, płatne 10). Do czasu, aż działa, niewidoczny dla klientów.

| Krok | Status | Dowód |
|---|---|---|
| Architektura i MVP rozmowy (dawne SC-011, SC-012) | DO SPRAWDZENIA | issue #12, #13 zamknięte; kod częściowo istnieje (`lib/voice/`), brak otwartego issue |
| Podpięcie do limitów pakietów (FREE 1, płatne 10) | DO ZROBIENIA | brak issue |

## Wstrzymane do pierwszej sprzedaży

Nie podejmować i nie proponować:

- SC-020 white-label (issue #21);
- SC-021 bramka AI i kontrola kosztów (issue #81);
- Quality of Hire;
- talent pool;
- chatbot informacyjny (SC-022);
- automatyzacja Fakturowni;
- analiza treści rozmów.

## Poza tym repozytorium

Sprzedaż FREE i PRESELEKCJI oraz Stripe są w repozytorium `krzysztofsyska/skillcheck-preselekcja`.
W `skillcheck-core` ścieżka płatności pozostaje zamrożona: bez zmian integracji płatności, przepływu
zakupu, cen, katalogu pakietów i stanów zamówień.

## Utrzymanie wydań

Tylko otwarte zadania, bez których gotowa funkcja nie może wejść na produkcję. Niczego tu nie
dopisywać bez takiego uzasadnienia.

- [#369](https://github.com/krzysztofsyska/skillcheck-core/issues/369) — polityka wydań i automatyczny publikator.
- [#461](https://github.com/krzysztofsyska/skillcheck-core/issues/461) — wdrożenie screening-worker razem z wydaniem (PR #465 otwarty); do tego czasu obowiązuje tymczasowa bramka workera (`WORKER_DEPLOY_REQUIRED` w `docs/continuous-release-policy.md`).
- [#491](https://github.com/krzysztofsyska/skillcheck-core/issues/491) — Automatyczne wgrywanie bezpiecznych migracji na produkcję (droga B). Uzasadnienie: dziś każda migracja blokuje wydanie gotowych funkcji (`UNRELEASED_MIGRATIONS_PRECEDE`, `MIGRATION_EXECUTOR_UNAVAILABLE`) do ręcznej zgody właściciela. Zależy od #465 (te same pliki publikatora).
