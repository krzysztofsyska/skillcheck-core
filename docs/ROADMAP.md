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

Bramki bezpieczeństwa (zamrożenie ścieżki płatności, migracje produkcyjne, sekrety, ustawienia,
kasowanie danych, nowe koszty, nowe realne wysyłki, polityka wydań #369) są w `AGENTS.md`. Ten plik
ich nie zmienia i nie otwiera.

Statusy ustalono 17.11.2026 z kodu na `integration` (`7ebd063`) oraz z issue i PR.

## Etapy — cały SkillCheck

| Etap | Cel biznesowy | Gotowe, gdy | Gdzie |
|---|---|---|---|
| **1. Pierwsza sprzedaż** | firma kupuje FREE / PRESELEKCJĘ przez Stripe i dostaje raport | pierwsza prawdziwa płatność za PRESELEKCJĘ | repo `skillcheck-preselekcja`, jego [docs/ROADMAP.md](https://github.com/krzysztofsyska/skillcheck-preselekcja/blob/integration/docs/ROADMAP.md) |
| **2. WERYFIKACJA gotowa** | rekruter daje test kompetencji z shortlisty i dostaje rozszerzony raport | ścieżka R1 + R2 przechodzi na Preview, pakiet opisany na stronie (R4) | to repo: R1, R2, R4 |
| **3. Assessment Center gotowe** | firma prowadzi sesję finalistów z dwoma asesorami | ścieżka R3 przechodzi na Preview dla konta firmy z pakietem | to repo: R3 |
| **4. Później** | kalkulator wyceny i voicebot | — | to repo: R5 (CZEKA), R6 |

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
| Automatyczne wysłanie testu kandydatowi w trybie automatycznym | W TOKU (dostęp bez kliknięcia rekrutera; realna wysyłka do kandydata nadal zamknięta) | PR #510 |
| Włączenie testu kompetencji w Preview i przejście całej ścieżki | DO SPRAWDZENIA | brak dowodu w issue/PR |

### R2. Rozszerzony raport kandydata, bez części głosowej (etap 2)

| Krok | Status | Dowód |
|---|---|---|
| A — opis raportu (CV, test, ćwiczenia, etapy) | ZROBIONE | PR #269, #498 |
| B — wymagania z CV | ZROBIONE | `lib/candidate-report.ts` |
| B — sekcja testu kompetencji | ZROBIONE | PR #496 |
| B — sekcje ćwiczeń i etapów rekrutacji (dane, ekran, wydruk A4) | ZROBIONE | PR #501, #505 |
| C — ekran raportu i wydruk A4 | ZROBIONE | PR #483 |
| D — eksport CSV z rejestrem dostępu, historia eksportów (raport i firma) | ZROBIONE | PR #476, #477, #482 |
| Przejście całego raportu na Preview na danych testowych | DO SPRAWDZENIA (częściowo — zob. `docs/checks/r2-preview-walk-2026-11-18.md`) | sprawdzenie 18.11.2026 |

### R3. Assessment Center — pełny przepływ (etap 3, issue #338)

| Krok | Status | Dowód |
|---|---|---|
| Arkusze ćwiczeń i raport z dowodów | ZROBIONE | PR #272, #378 |
| Sesja finalistów: dwóch niezależnych asesorów, limit 10 osób, druga próba | ZROBIONE (za flagą `AC_PAIRED_SHEETS_PREVIEW`) | PR #434, #471 |
| Eksport CSV podsumowania sesji i rejestr pobrań | ZROBIONE | PR #480, #486 |
| Asesorzy pokazani z nazwy (etykieta, potem e-mail konta z tej samej firmy) | ZROBIONE | PR #500, #513 |
| Jawne braki dowodów w raporcie i CSV sesji | ZROBIONE | PR #508 |
| Testy równoczesnej pracy asesorów | ZROBIONE | PR #512 |
| Powiązanie z kontami firm, uprawnieniami i kupionym pakietem | W TOKU (konta i uprawnienia zrobione; pakiet czeka na zdjęcie zamrożenia ścieżki płatności) | PR #503; issue #338, #274, #283 |

### R4. Oferta na stronie (etap 2)

Zmiana treści strony; nie zmienia integracji płatności, przepływu zakupu, cen w katalogu ani stanów
zamówień.

| Krok | Status | Dowód |
|---|---|---|
| WERYFIKACJA i ASSESSMENT CENTER widoczne na stronie, z opisem i dopiskiem „nie można jeszcze kupić”, bez wzmianki o bocie | ZROBIONE | PR #489 |
| Gwarancja wyniku PRESELEKCJI w regulaminie i na stronie oferty | ZROBIONE | PR #494 (issue #492) |

### R5. Kalkulator wyceny (SC-PRICING-W1…W4) — CZEKA

**CZEKA na zdjęcie zamrożenia ścieżki płatności przez właściciela.** Do tego czasu nie podejmować.

| Krok | Status | Dowód |
|---|---|---|
| W1 + W2 — audyt źródeł cennika i katalog cen w bazie | ZROBIONE | PR #265 |
| W2b — suwak liczby CV co 5 | W TOKU (część 1/2) | PR #286 |
| W3, W4 — publiczny cennik z katalogu, za wyłączoną flagą | DO ZROBIENIA (CZEKA) | — |

### R6. Voicebot — na końcu, po R1–R3

Docelowo w każdym pakiecie (FREE 1 rozmowa, płatne 10). Do czasu, aż działa, niewidoczny dla klientów.

| Krok | Status | Dowód |
|---|---|---|
| Architektura i MVP rozmowy (dawne SC-011, SC-012) | DO SPRAWDZENIA | issue #12, #13 zamknięte; kod częściowo w `lib/voice/` |
| Podpięcie do limitów pakietów (FREE 1, płatne 10) | DO ZROBIENIA | — |

## Wstrzymane do pierwszej sprzedaży

Nie podejmować i nie proponować: SC-020 white-label (issue #21); SC-021 bramka AI i kontrola
kosztów (issue #81); Quality of Hire; talent pool; chatbot informacyjny (SC-022); automatyzacja
Fakturowni w tym repozytorium (decyzja dla `skillcheck-preselekcja` — zob. `docs/DECYZJE.md`, 17.11.2026, 14:34);
analiza treści rozmów.

## Poza tym repozytorium

Sprzedaż FREE i PRESELEKCJI oraz Stripe: `krzysztofsyska/skillcheck-preselekcja` (etap 1).
W `skillcheck-core` ścieżka płatności pozostaje zamrożona.

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
