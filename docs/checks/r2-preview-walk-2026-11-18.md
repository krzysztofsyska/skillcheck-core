# R2 — przejście raportu kandydata na Preview (18.11.2026)

Sprawdzenie z ROADMAP R2, wiersz „Przejście całego raportu na Preview na danych testowych”.
Tylko dane testowe (fikcyjne osoby), tylko Preview. Produkcji nie dotykano. Żadnych ustawień
Vercel nie zmieniano.

## Na czym

- Preview gałęzi `integration`, wdrożenie `dpl_BR8iKMMazMmmmLsofgFsxd3E841f`, commit
  `21427382837bb47fa6bbc0a52b649b5890f0d4d4` (stan READY), adres
  `skillcheck-core-git-integration-krzysztofs-projects-b7ce87b5.vercel.app`.
- Baza Preview `skillcheck-preview` (`orbyscrupgnupifzlqxp`); migracje zgodne z repo
  (ostatnia `20261117220000`).
- Konto testowe `r2-walk-20261118@skillcheck-preview.invalid` (utworzone na potrzeby tego
  sprawdzenia, rola `recruiter` w firmie „Firma Testowa 3 (prawdziwe AI)”). Hasło tylko w notatniku
  sesji, nie w repo.
- Kandydatka fikcyjna „Alicja Raportowa” (zgłoszenie `2b3dc581`), rekrutacja „Test prawdziwej
  analizy AI (10 CV)”, analiza CV w wersji 1 (prawdziwe AI, wcześniejsze dane testowe).
- Przeglądarka: Chromium (Playwright), widok 1280×900, wydruk do PDF A4.

## Co zrobiono w aplikacji (przez ekran, jak rekruter)

1. Oznaczono wymagania w profilu stanowiska: 2 konieczne, 1 dodatkowe, 3 nieoznaczone.
2. Dodano dwa etapy („Rozmowa wstępna”, „Ćwiczenie AC”), przesunięto kandydatkę przez oba,
   zapisano decyzję człowieka „Kolejny etap” z uzasadnieniem.
3. Utworzono ćwiczenie Assessment Center z dwoma kryteriami (skrypt zapisał je dwa razy, więc są
   dwie identyczne definicje — to artefakt testu) i zapisano obserwację: kryterium 1 „zgodne z
   wymaganiami” z notatką, kryterium 2 „niewystarczające dane” bez notatki.
4. Otwarto raport na ekranie, w trybie wydruku i jako PDF A4, pobrano CSV, sprawdzono historię
   eksportu w raporcie, w bazie i na stronie firmy.

## Wyniki

| Sekcja | Wynik | Co widać |
|---|---|---|
| Raport się otwiera (ekran) | PASS | Nagłówek, zastrzeżenie „nie jest decyzją o zatrudnieniu”, stopka. |
| Wymagania z CV (grupy konieczne / nieoznaczone / dodatkowe, cytaty z pozycją w CV, „Czego brakuje”, pytanie na rozmowę) | PASS z błędem B1 | Grupy i liczby w podsumowaniu zgodne z oznaczeniami. Po przesunięciu kandydatki między etapami wszystkie wymagania pokazują „Wynik nieaktualny” — zob. B1. |
| Test kompetencji | NOT RUN (blokada) | Sekcja w ogóle się nie pokazuje: na Preview nie jest włączona flaga `COMPETENCY_CANDIDATE_PREVIEW`. Jej włączenie to zmiana zmiennej w Vercel — nie zmieniano. Ta sama blokada wyszła przy sprawdzaniu R1. |
| Ćwiczenia (AC) | PASS | Ćwiczenie bez obserwacji: „Nieocenione”, 0 z 2. Ćwiczenie z obserwacją: „Niepełne dowody”, kto i kiedy (czas Warszawa), 1 z 2, notatka obserwatora jako cytat, przy braku notatki tekst „To nie jest niska ocena”. Bez wyniku zbiorczego. |
| Etapy rekrutacji i decyzja rekrutera | PASS | Lista etapów z aktualnym, historia dwóch przesunięć z autorem i czasem, decyzja „Kolejny etap” z uzasadnieniem i historią. |
| Wydruk A4 | PASS (drobna uwaga) | PDF A4, 4 strony; przycisk drukowania, odnośnik CSV, historia eksportu, „Otwórz ćwiczenie”, „Etapy oceny” i „Dalsze kroki” są ukryte; stopka jest. Uwaga: odnośnik „Uruchom analizę ponownie” zostaje na wydruku (kosmetyka). |
| Eksport CSV | PASS | Plik `skillcheck-raport-kandydata-<zgłoszenie>.csv`, UTF-8 z BOM, separator `;`, 6 wymagań z cytatami. CSV obejmuje tylko część z CV (bez testu, ćwiczeń i etapów) — tak jest opisane w ROADMAP (krok D), ale warto to wiedzieć. |
| Rejestr dostępu do CSV | PASS | Jedno pobranie = jeden wpis w `report_audit.candidate_report_exports` (kto, kiedy, wersja analizy). Raport pokazuje „Historia eksportu: 18.11.2026, 02:29:08 · Ty (rekruter)”. |
| Historia eksportów firmy | częściowo | Rekruter widzi komunikat, że historię całej firmy widzi właściciel (zgodnie z założeniem). Widok właściciela NOT RUN — brak konta właściciela tej firmy testowej. |
| Dostęp z obcej firmy | PASS | Raport i CSV zgłoszenia z innej firmy: 404 (CSV zwraca `not_found`). |
| Błędy w konsoli przeglądarki | PASS | Tylko zablokowany skrypt paska Vercel (`vercel.live`) przez CSP — nie dotyczy aplikacji. |

## Znalezione błędy (nie naprawiane w tym PR)

**B1 — przesunięcie kandydata między etapami albo zapis decyzji oznacza analizę CV jako
nieaktualną.** Wyzwalacz `screening_application_stale` na `public.applications` działa przy
każdej zmianie wiersza zgłoszenia (bez warunku na zmienione kolumny). Przesunięcie etapu
zmienia `current_stage_id`, więc analiza dostała `stale_at` = chwila pierwszego przesunięcia
(01:25:05 UTC) z powodem `application_changed`. Skutek w raporcie: komunikat „CV albo wymagania
zmieniły się po tej analizie”, każde wymaganie ma status „Wynik nieaktualny”, w podsumowaniu
wymagania konieczne przechodzą do „czeka na wynik”, a CSV ma to samo. CV ani wymagania się nie
zmieniły. To psuje właśnie pełną ścieżkę R2: rekruter, który używa etapów, zawsze zobaczy
nieaktualny wynik CV. Podobnie działa `screening_recruitment_stale` (każda zmiana wiersza
rekrutacji). Propozycja: warunek `WHEN` tylko na kolumny, które zmieniają wejście analizy
(osobne zadanie, L3 — migracja i wyzwalacz).

## Obserwacje (nie błędy raportu)

- O1: Przed tym sprawdzeniem lista „Wyniki preselekcji (grupy)” pokazywała u wszystkich 10 osób
  „Wynik nieaktualny”, podczas gdy raport i ekran analizy tej samej osoby pokazywały wynik
  aktualny (`stale_at` puste). Dwa miejsca liczą „nieaktualny” inaczej.
- O2: CSV nie zawiera testu, ćwiczeń ani etapów (zgodnie z zakresem kroku D).

## Dane testowe, które zostały na Preview

Konto `r2-walk-20261118@skillcheck-preview.invalid` z rolą `recruiter` w „Firma Testowa 3”,
dwa etapy, dwie definicje ćwiczenia „Test R2: …”, jedna obserwacja, dwa przesunięcia, jedna
decyzja, oznaczenia wymagań stanowiska, jeden wpis eksportu CSV. Wszystko fikcyjne.

## Werdykt

Częściowo. Ćwiczenia, etapy, wydruk A4, CSV z rejestrem i odcięcie obcej firmy działają.
Nie sprawdzono sekcji testu kompetencji (flaga wyłączona na Preview) ani widoku historii
eksportów właściciela. Błąd B1 sprawia, że wymagania z CV pokazują się jako nieaktualne po
użyciu etapów. Zrzuty ekranu i PDF są w notatniku sesji, nie w repo.

## Ponowne sprawdzenie 18.11.2026 (B1, O1)

Sprawdzenie poprawek po PR #521 (B1) i PR #520 (O1). Tylko Preview `skillcheck-preview`
(`orbyscrupgnupifzlqxp`), tylko dane testowe. Produkcji nie dotykano. Migracja
`20261118120000_r2_screening_stale_input_columns` jest już zastosowana na Preview. Wszystkie zmiany
w bazie robiono w jednym bloku `do $$ ... $$`, który na końcu celowo rzuca wyjątek (`raise exception`),
więc transakcja wraca do stanu wyjściowego. Po sprawdzeniu odczytano wiersz ponownie: `stale_at`
(`2026-11-18 01:25:05.72+00`, `application_changed`), etap, decyzja i status zgłoszenia oraz nazwa
rekrutacji są takie jak przed sprawdzeniem. Nie czytano kolumn z sekretami.

Dane: zgłoszenie `2b3dc581-…` (fikcyjna kandydatka), rekrutacja `f732a556-…`, wersja analizy
`2019ca1b-…` (ta sama, która w pierwszym przejściu dostała `stale_at` przed poprawką).

### B1 — wynik: PASS

Kroki (wszystkie w jednej transakcji z wycofaniem):

1. `update public.screening_analysis_versions set stale_at = null, stale_reason = null where id = <wersja>;`
   (czysty punkt wyjścia; stary `stale_at` pochodził sprzed poprawki), zapamiętano
   `applications.updated_at`.
2. T1: `update public.applications set current_stage_id = <inny etap tej rekrutacji z public.assessment_stages> where id = <zgłoszenie>;`
3. T2: `update public.applications set human_decision = 'on_hold', human_decision_reason = 'recheck test' where id = <zgłoszenie>;`
   (dozwolone wartości z ograniczenia: `next_stage`, `on_hold`, `closed`).
4. T3: `update public.recruitments set name = name || ' (rename test)' where id = <rekrutacja>;`
5. T4 (kontrola odwrotna): `update public.applications set status = 'in_progress' where id = <zgłoszenie>;`
6. T5 (kontrola odwrotna): wyczyszczenie `stale_at`, potem `update public.recruitments set status = <inna wartość> where id = <rekrutacja>;`
7. Po każdym kroku odczyt `stale_at` wersji analizy i `updated_at` zgłoszenia / rekrutacji; na końcu `raise exception` (wycofanie).

| Krok | Oczekiwane | Wynik |
|---|---|---|
| T1 zmiana etapu | `stale_at` puste, `updated_at` bez zmian | PASS (puste, bez zmian) |
| T2 decyzja człowieka | `stale_at` puste, `updated_at` bez zmian | PASS (puste, bez zmian) |
| T3 zmiana nazwy rekrutacji | `stale_at` puste, `updated_at` bez zmian | PASS (puste, bez zmian) |
| T4 zmiana `applications.status` (kolumna wejścia) | `stale_at` ustawione, `updated_at` zmienione | PASS (ustawione, zmienione) |
| T5 zmiana `recruitments.status` (kolumna wejścia) | `stale_at` ustawione | PASS (ustawione, `updated_at` zmienione) |

Uwaga: istniejący `stale_at` z pierwszego przejścia (01:25:05 UTC, sprzed poprawki) zostaje na wersji
analizy — migracja niczego nie czyści (tak jest opisane w jej nagłówku). Ta analiza wymaga ponownego
uruchomienia, żeby w raporcie znów była aktualna. Nie uruchamiano jej (to zmiana trwała danych
i koszt AI).

### O1 — wynik: PASS (kod i dane), UI NOT RUN

Kod: `lib/screening-report.ts` (`groupAnalysisState`) zwraca trzy stany: `current` (analiza ta sama co
w rankingu i `eligible` / `insufficient_evidence`), `unreviewed` (ta sama analiza, `no_human_review`)
i `stale` (inna analiza, brak powiązania albo każdy inny powód). Ten sam stan liczą
`lib/preselection-currency.ts` (lista grup) i `lib/screening-report-source.ts` (raport i CSV).
Test jednostkowy `node --test tests/screening-report.test.mjs`: 29 z 29 PASS (lokalnie, po `npm ci`).

Dane na Preview — ta sama reguła policzona w SQL na wyniku RPC `get_preselection_groups` i
`get_screening_ranking(<rekrutacja>, 10)`, wywołanych w transakcji z wycofaniem jako konto testowe
rekrutera (`set local role authenticated` + `request.jwt.claims` z `sub` konta testowego):

```sql
with g as (select (e->>'application_id')::uuid application_id, (e->>'analysis_id')::uuid analysis_id
           from jsonb_array_elements(public.get_preselection_groups(<rekrutacja>)) e)
select case when g.analysis_id is null or k.analysis_id is null or g.analysis_id <> k.analysis_id then 'stale'
            when k.eligibility_reason in ('eligible','insufficient_evidence') then 'current'
            when k.eligibility_reason = 'no_human_review' then 'unreviewed' else 'stale' end as state,
       k.eligibility_reason, count(*)
from g left join public.get_screening_ranking(<rekrutacja>, 10) k on k.application_id = g.application_id
group by 1, 2;
```

Wynik: 9 grup `unreviewed` (`no_human_review`, analiza aktualna, jeszcze bez przeglądu człowieka) i
1 grupa `stale` (zgłoszenie z `stale_at` sprzed poprawki B1, czyli naprawdę do ponownej analizy).
Przed poprawką wszystkie 10 pokazywały „Wynik nieaktualny”. Zgodnie z poprawką 9 z 10 nie jest już
nieaktualnych.

Ekran „Wyniki preselekcji (grupy)” w przeglądarce na Preview: NOT RUN (nie sprawdzano wdrożenia
Vercel w tej sesji; dane i kod potwierdzone powyżej).

### Nadal NOT RUN

- Sekcja testu kompetencji w raporcie (flaga `COMPETENCY_CANDIDATE_PREVIEW` na Preview wymaga zmiennej
  w Vercel — zmiana ustawień poza zakresem agenta).
- Widok historii eksportów właściciela firmy (brak konta właściciela firmy testowej).
- Ekran grup i raport w przeglądarce po poprawkach (UI).

### Werdykt ponownego sprawdzenia

B1: PASS. O1: PASS w kodzie i danych, UI NOT RUN. Wiersz R2 zostaje „DO SPRAWDZENIA (częściowo)”.
