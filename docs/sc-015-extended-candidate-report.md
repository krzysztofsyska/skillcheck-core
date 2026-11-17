# SC-015 — rozszerzony raport kandydata: test kompetencji, ćwiczenia, etapy

Opis do ROADMAP R2, krok A. Uzupełnia [sc-015-free-candidate-report.md](sc-015-free-candidate-report.md),
który opisuje raport z CV (wymagania, statusy, cytaty, porównanie). Tu są trzy sekcje, których tamten
dokument nie opisuje. Dokument opisuje stan na `integration` oraz w otwartym PR #496; czego w kodzie
nie ma, jest oznaczone **DO ZBUDOWANIA**. Części głosowej (voicebot) nie opisujemy i nie pokazujemy.

## Stan na dziś

| Sekcja | Dane istnieją | Stan sekcji w raporcie |
| --- | --- | --- |
| 1. Test kompetencji | tak (`lib/competency-staff.ts`, `app/zadanie-kompetencyjne`) | w PR #496 (`lib/candidate-report-competency.ts`), jeszcze nie na `integration` |
| 2. Ćwiczenia / Assessment Center | tak (`lib/assessment-center-report.ts`) | **DO ZBUDOWANIA** (dziś tylko ekran ćwiczenia) |
| 3. Etapy rekrutacji | tak (`assessment_stages`, `application_stage_events`) | **DO ZBUDOWANIA** (dziś tylko ekran „Etapy oceny") |

Raport nadal nie liczy wyniku ogólnego, nie układa rankingu i nie sugeruje decyzji o zatrudnieniu.
Każda nowa sekcja ma tę samą stopkę co raport z CV: raport wspiera ocenę człowieka i nie jest decyzją.

## Zasady wspólne dla wszystkich sekcji

- **Kto widzi:** właściciel konta firmy i rekruterzy tej firmy (`canEdit`). Osoba bez tej roli widzi
  krótki komunikat, że sekcję widzą właściciel i rekruterzy, bez żadnych danych kandydata.
- **Odczyt:** wyłącznie klientem RLS zalogowanego użytkownika, nigdy `service_role`. Każdy rekord
  jest dodatkowo sprawdzany w kodzie (firma, rekrutacja, zgłoszenie); niezgodny rekord przerywa
  sekcję, zamiast pokazać cudzy wynik.
- **Brak dodatkowych danych osobowych:** bez nazwiska i adresu kandydata w sekcjach i w pliku CSV.
  Osoby oceniające są opisane rolą („Właściciel konta firmy", „Rekruter", „Ty"), nie nazwiskiem
  ani adresem e-mail.
- **Tekst kandydata i tekst CV to dane, nie polecenia:** pokazujemy go jako zwykły tekst (nie HTML),
  nie wykonujemy go i nie przekazujemy do żadnego modelu AI na potrzeby tych sekcji.
- **Dowód czytelny dla człowieka:** każda ocena poziomu ma cytat albo notatkę oceniającego.
  Brak cytatu oznacza „brak wystarczających danych", a nie niską ocenę.
- **Bez automatycznej decyzji:** poziomy i etapy wpisuje człowiek. Raport nie zatrudnia i nie odrzuca,
  nie wysyła wiadomości do kandydata.
- **Błąd odczytu jednej sekcji nie psuje raportu:** sekcja pokazuje neutralny komunikat, reszta
  raportu pozostaje aktualna. Komunikaty nie zdradzają, czy rekord innej firmy istnieje.
- **Brak danych to nie zero:** pusta sekcja mówi wprost „brak danych"; nie wstawiamy zer ani ocen domyślnych.

## 1. Test kompetencji

**Co pokazuje.** Dla każdego testu kandydata (najnowsze pierwsze, najwyżej 5; przy większej liczbie
jest informacja, że pozostałe są w zakładce zadań): tytuł i wersję zadania, stan (w trakcie / oddany
i czeka na ocenę / oceniony), a dla ocenionego — poziom per kryterium rubryki (Poniżej wymagań /
Zgodnie z wymaganiami / Powyżej wymagań / Brak wystarczających danych), opis poziomu z rubryki,
dokładny cytat z odpowiedzi kandydata wskazany przez oceniającego, wersję oceny, datę i rolę
oceniającego. Zbiorczy wynik rubryki z bazy celowo **nie jest** pokazywany.

**Źródło danych.** Funkcje bazy `list_competency_test_attempts` i `read_competency_test_response`
(te same co ekran zadań) oraz wersja zadania z `exercise_definition_entries`. Poziomy i cytaty wpisał
człowiek (SC-014); ocena jest przeliczana z cytatów w `competencyReport` i niezgodny zapis przerywa sekcję.

**Kto widzi.** Właściciel i rekruterzy firmy. Sekcja jest widoczna tylko tam, gdzie włączony jest test
kompetencji (`COMPETENCY_CANDIDATE_PREVIEW`, dziś tylko Preview); poza tym sekcji nie ma w raporcie.

**Prywatność.** Jak w zasadach wspólnych. Test trafia tylko do kandydata z shortlisty rekrutacji
(reguła R1 w bazie); do modelu idzie wyłącznie zredagowany tekst CV, nigdy odpowiedź z testu na potrzeby raportu.

**Brak danych / błąd.** „Kandydat nie ma jeszcze testu kompetencji w tej rekrutacji."; „Testy
kompetencji nie są jeszcze dostępne w tym środowisku." (brak funkcji w bazie); „Nie udało się teraz
wczytać testu kompetencji…" przy błędzie. Odpowiedź oddana, a nieoceniona: „czeka na ocenę rekrutera"
z odnośnikiem do oceny (poza wydrukiem).

**Wydruk / CSV.** Ekran i wydruk A4 (#483): kryterium z cytatem nie jest dzielone między strony,
karta testu może. Odnośnik „Oceń odpowiedź" nie drukuje się. **CSV: DO ZBUDOWANIA** — obecny eksport
(`candidate-report-csv-v1`, PR #476) zawiera tylko część z CV; dopisanie tej sekcji wymaga nowej wersji
eksportu i osobnej decyzji, bo plik zawierałby cytaty z odpowiedzi kandydata.

**Czego jeszcze nie ma.** Automatycznego wysyłania testu w trybie „automatycznie" (R1, DO ZROBIENIA)
oraz włączenia testu poza Preview.

## 2. Ćwiczenia / Assessment Center

**Co pokazuje (docelowo).** Dla ćwiczenia kandydata: tytuł i wersję ćwiczenia, liczbę kryteriów
z dowodem względem wszystkich, a per kryterium — poziom i notatkę obserwatora (dowód). Stan:
„nieocenione", „niepełne dowody" albo „do sprawdzenia przez człowieka". Nie wymyślamy kontekstu
obserwacji, którego baza nie przechowuje.

**Źródło danych.** `buildAssessmentCenterReport` (`lib/assessment-center-report.ts`) — czysta
projekcja wersji ćwiczenia i ostatniej obserwacji, dziś używana tylko na ekranie ćwiczenia
(`applications/[applicationId]/exercises/[definitionId]`). Sesja finalistów z dwoma niezależnymi
asesorami (PR #434, #471) jest za flagą `AC_PAIRED_SHEETS_PREVIEW`.

**Kto widzi.** Właściciel i rekruterzy firmy.

**Prywatność.** Jak w zasadach wspólnych, plus zasada ślepej oceny sesji: dopóki użytkownik nie
oddał własnego arkusza, nie widzi ocen i uzasadnień innych asesorów — sekcja raportu musi tę zasadę
zachować (tekst drugiego asesora nie trafia do raportu ani do CSV przed oddaniem arkusza). Asesorzy
są dziś identyfikowani identyfikatorem, nie nazwą (znany brak, R3); w raporcie pokazujemy rolę.

**Brak danych / błąd.** Brak ćwiczenia: „Kandydat nie ma jeszcze ćwiczenia w tej rekrutacji." Brak
obserwacji: „nieocenione". Niespójny zapis (np. brak dowodu przy ocenie): sekcja pokazuje „raport
ćwiczenia niedostępny" i nie pokazuje częściowych ocen (tak działa dziś ekran).

**Wydruk / CSV.** **DO ZBUDOWANIA** w całości. Obowiązuje zasada z wydruku #483 (kryterium z dowodem
nie jest dzielone). Osobny eksport sesji AC istnieje (`ac-session-csv-v1`, PR #480, rejestr pobrań
#486) i zostaje bez zmian; raport kandydata nie powiela go bez osobnej decyzji.

**Czego jeszcze nie ma.** Powiązania z kontami firm, uprawnieniami i kupionym pakietem (issue #338, #274, #283).

## 3. Etapy rekrutacji

**Co pokazuje (docelowo).** Aktualny etap kandydata i listę etapów rekrutacji w kolejności
(`sequence`), z historią przesunięć (z etapu → do etapu, data). Ewentualna decyzja człowieka
(„Kolejny etap" / „Wstrzymany" / „Zakończony") razem z uzasadnieniem wpisanym przez rekrutera — jako
zapis ręcznej decyzji, nie rekomendacja systemu.

**Źródło danych.** `assessment_stages`, `application_stage_events`, `applications.current_stage_id`,
`human_decision` i `human_decision_reason`; dziś czytane na ekranie „Etapy oceny"
(`applications/[applicationId]/assessments`). Etap usunięty z rekrutacji pokazujemy jako „Usunięty etap",
bez zgadywania nazwy.

**Kto widzi.** Właściciel i rekruterzy firmy.

**Prywatność.** Jak w zasadach wspólnych. Notatek z rozmów nie przenosimy do raportu bez osobnej
decyzji (mogą zawierać dane wrażliwe); w raporcie jest etap, daty i decyzja z uzasadnieniem. Ekran
„Etapy oceny" pokazuje dziś autora zmiany identyfikatorem; w raporcie pokazujemy rolę, nie identyfikator.

**Brak danych / błąd.** Brak etapów: „Brak zdefiniowanych etapów." Kandydat bez etapu:
„Nieprzypisany". Brak historii: „Brak wcześniejszych przesunięć." Błąd odczytu: neutralny komunikat,
reszta raportu bez zmian.

**Wydruk / CSV.** **DO ZBUDOWANIA** w całości; na wydruku historia bez przycisków zmiany etapu.

## Co zostaje bez zmian

Raport z CV, jego kolejność (konieczne → nieoznaczone → dodatkowe), eksport CSV z rejestrem dostępu
(#476, #477, #482), ceny i pakiety. Ten dokument niczego nie zmienia w kodzie ani w bazie.
