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
