# R2 — historia eksportów firmy jako właściciel firmy, na Preview (26.11.2026)

Domknięcie jedynego kroku NOT RUN z `docs/checks/r2-preview-walk-2026-11-26.md` (wiersz „Przejście całego
raportu na Preview na danych testowych” w `docs/ROADMAP.md`): widok `/dashboard/<firma>/eksporty`
(„Historia eksportów raportów”) oglądany jako **właściciel konta firmy**. Tylko dane testowe
(fikcyjna firma, fikcyjna kandydatka, adresy w domenie `example.com`), tylko Preview. Nikomu nic nie
wysłano, produkcji nie dotykano, ustawień Vercel nie zmieniano, wartości sekretów nie czytano.

**Wynik: wszystkie kroki PASS. Nie znaleziono błędów w kodzie.**

## Na czym

- Preview gałęzi `integration`: wdrożenie `dpl_yzAFuecXjmTJyGNb6nNeSQA2VLYL`, commit
  `8c075da0b35596d6fca3dbe3120a6ec432480907` (PR #606), stan READY. Dostęp do chronionego Preview przez
  tymczasowy link tylko do Preview (nie zapisany).
- Baza `skillcheck-preview` (`orbyscrupgnupifzlqxp`). Produkcji nie dotykano.
- Jak działa właściciel: to nie wiersz w `company_members` (tam są tylko `recruiter` i `viewer`), tylko
  `companies.owner_id`; strona `/eksporty` porównuje `user.id` z `company.owner_id`, a baza
  (`list_company_report_exports`) sprawdza to jeszcze raz (`private.is_company_owner`).
- Nowa osobna firma testowa „Spacer R2 Właściciel Sp. z o.o. (test)” z kontem właściciela
  `r2-walk-owner@example.com` i kontem rekrutera `r2-walk-recruiter2@example.com` (rola `recruiter`).
  Hasła wylosowane na potrzeby sprawdzenia, ustawione tylko w bazie Preview, nigdzie nie zapisane
  w repozytorium. Żadnego istniejącego konta ani firmy nie zmieniano.
- Przeglądarka: Chromium (Playwright), widok 1280×900, skala 1.

## Co zrobiono

1. Dane testowe w bazie Preview (konta, firma, stanowisko, rekrutacja, kandydatka, zgłoszenie) — SQL
   w projekcie Preview, bo konta i firmę trzeba było założyć bez poczty i bez klucza serwisowego.
2. Logowanie jako właściciel przez ekran logowania; `/eksporty` przed jakimkolwiek pobraniem.
3. Jako właściciel: otwarcie raportu kandydatki i pobranie CSV (zapis w rejestrze przez
   `record_candidate_report_export`).
4. Jako rekruter tej samej firmy: logowanie, wejście na `/eksporty`, pobranie CSV tego samego raportu.
5. Jako właściciel: ponowne otwarcie `/eksporty`; próba wejścia na `/eksporty` dwóch obcych firm.

## Wyniki

| Krok | Wynik | Co widać |
|---|---|---|
| Logowanie właściciela firmy testowej | PASS | Przekierowanie na `/dashboard`. |
| `/eksporty` właściciela, brak pobrań | PASS | Nagłówek „Historia eksportów raportów — Spacer R2 Właściciel Sp. z o.o. (test)”, opis zakresu, komunikat „W tej firmie nie pobrano jeszcze żadnego raportu kandydata.” |
| Pobranie CSV przez właściciela | PASS | Raport 200, `/export` 200, `text/csv; charset=utf-8`. Raport pokazuje „Historia eksportu” i stan „Dla tego zgłoszenia nie ma jeszcze analizy CV”. |
| `/eksporty` właściciela po dwóch pobraniach (kto, kiedy, co) | PASS | Dwa wpisy, najnowszy pierwszy: „26.11.2026, 09:21:02 · Rekruter · Rekrutacja testowa R2 właściciel · Raport kandydata” oraz „26.11.2026, 09:20:53 · Ty (właściciel konta firmy) · Rekrutacja testowa R2 właściciel · Raport kandydata”. Czas w strefie Warszawy, odnośniki do rekrutacji i raportu mają adresy tej firmy. Bez e-maili i danych kandydatki. |
| Brak danych innych firm | PASS | Na liście tylko 2 wpisy tej firmy; w bazie Preview wpisy mają też „Spacer MVP Sp. z o.o. (test)” (1) i „Firma Testowa 3 (prawdziwe AI)” (1) — żaden nie pojawił się na liście. |
| Właściciel a obca firma | PASS | `/dashboard/<obca firma>/eksporty` dla dwóch obcych firm: 404 „This page could not be found.” |
| Rekruter tej samej firmy | PASS | `/eksporty`: „Historię eksportów całej firmy widzi właściciel konta firmy.” — bez listy. |
| Rekruter może pobrać CSV (SC-015-D) | PASS | `/export` 200; wpis pojawił się jako „Rekruter” na liście właściciela. |
| Historia pojedynczego raportu u właściciela | PASS | Sekcja „Historia eksportu” widoczna na raporcie (zrzut 03). |

Zrzuty ekranu: `docs/checks/screens-r2-2026-11-26b/` — `01-eksporty-wlasciciel-pusto.png`,
`02-raport-wlasciciel.png`, `03-raport-historia-eksportu-wlasciciel.png`,
`04-eksporty-rekruter-komunikat.png`, `05-eksporty-wlasciciel-lista.png`, `06-eksporty-obca-firma.png`.

## Błędy

Nie znaleziono błędów w kodzie. Zmian w kodzie nie ma.

## Nie sprawdzano

- Stronicowania („Starsze pobrania →”, powyżej 100 wpisów) — NOT RUN, wymaga 100+ wpisów; objęte
  testami jednostkowymi widoku, nie tym przejściem.
- Wpisu pochodzącego od byłego członka firmy („former_member”) — NOT RUN.

## Dane testowe dodane na Preview

Dwa konta w `example.com` (właściciel, rekruter), firma „Spacer R2 Właściciel Sp. z o.o. (test)” z
profilem, stanowisko „Specjalista ds. testów R2 (test)”, rekrutacja „Rekrutacja testowa R2 właściciel”,
kandydatka „Beata Eksportowa”, jedno zgłoszenie, dwa wpisy eksportu CSV. Wszystko fikcyjne, tylko
Preview.
