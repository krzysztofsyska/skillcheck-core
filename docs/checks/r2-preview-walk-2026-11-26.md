# R2 — przejście raportu kandydata na Preview, z ekranem i testem kompetencji (26.11.2026)

Powtórzenie sprawdzenia z `docs/checks/r2-preview-walk-2026-11-18.md` (wiersz „Przejście całego raportu
na Preview na danych testowych” w `docs/ROADMAP.md`). Tym razem rekruter testowy mógł się zalogować,
więc sprawdzono też część ekranową, a sekcja testu kompetencji jest już w raporcie. Tylko dane
testowe (fikcyjni kandydaci, adres w domenie `example.com`), tylko Preview. Nikomu nic nie wysłano,
produkcji nie dotykano, ustawień Vercel nie zmieniano, wartości sekretów nie czytano.

**Wynik: wszystkie sprawdzone kroki PASS. Jedyny krok NOT RUN: widok historii eksportów całej firmy
jako właściciel firmy (konto testowe ma rolę rekrutera, nie podnoszono uprawnień).**

## Na czym

- Preview gałęzi `integration`: wdrożenie `dpl_CGKNmUAcEdS3VLAFvcHgV4xVssZk`, commit
  `9df1ebb1818053aa2f53852f3b8215db6527dcb1` (PR #604), stan READY.
- Baza `skillcheck-preview` (`orbyscrupgnupifzlqxp`).
- Konto: `r1-walk-recruiter@example.com`, rola `recruiter` w firmie „Spacer MVP Sp. z o.o. (test)”.
  Hasło ustawione tylko w bazie Preview, wylosowane na potrzeby sprawdzenia, trzymane w pamięci sesji,
  nigdzie nie zapisane. Dostęp do chronionego Preview przez tymczasowy link tylko do Preview
  (nie zapisany).
- Kandydatka A (fikcyjna „Alicja Raportowa”), rekrutacja „specjalista ds. raportowania”, analiza CV
  w wersji 1, CV v2.
- Przeglądarka: Chromium (Playwright), widok 1280×900, skala 1, wydruk A4 do PDF.

## Co zrobiono na ekranie (jak rekruter)

1. W profilu stanowiska oznaczono wymagania: Excel i SQL jako konieczne, CRM jako dodatkowe, trzy
   zostały nieoznaczone.
2. Na stronie rekrutacji dodano dwa etapy („Rozmowa wstępna”, „Ćwiczenie AC”), kandydatkę przesunięto
   przez oba i zapisano decyzję człowieka „Kolejny etap” z uzasadnieniem.
3. Utworzono ćwiczenie Assessment Center z dwoma kryteriami (zapis raz, wersja 1) i zapisano obserwację:
   kryterium 1 „zgodne z wymaganiami” z notatką, kryterium 2 „niewystarczające dane” bez notatki.
4. Test kompetencji: kandydatka ma dwie próby — starszą już ocenioną przez człowieka (18.11) i
   świeżo oddaną w sprawdzeniu R1 z 26.11 (jeszcze nieocenioną). Nic nie zmieniano.
5. Otwarto raport, pobrano CSV, sprawdzono historię eksportu, wydruk, ekran analizy i listę grup.

## Wyniki

| Krok | Wynik | Co widać |
|---|---|---|
| Logowanie rekrutera testowego i otwarcie raportu | PASS | Raport otwiera się (200), nagłówek, zastrzeżenie „nie jest decyzją o zatrudnieniu i nie zawiera wyniku ogólnego”, stopka. |
| Wymagania z CV | PASS | Przed oznaczeniem: komunikat „Żadne wymaganie nie jest jeszcze oznaczone jako konieczne”. Po oznaczeniu: „Z 2 wymagań koniecznych: 2 ma potwierdzenie w CV…”, „3 nieoznaczonych, 1 dodatkowych”, grupy konieczne / nieoznaczone / dodatkowe z cytatami i pozycją w CV; „Czego brakuje” i pytanie na rozmowę przy braku informacji. |
| Test kompetencji (sekcja) | PASS | Sekcja jest widoczna (wcześniej brakowało). Dwie wersje zadania: „Odpowiedź oddana — czeka na ocenę rekrutera” z odnośnikiem „Oceń odpowiedź” oraz „Ocenione przez człowieka · wersja oceny 1” z autorem, czasem (Warszawa), kryteriami i cytatami z odpowiedzi („2 z 2”). Bez wyniku zbiorczego. |
| Ćwiczenia | PASS | „Niepełne dowody”, kto i kiedy zapisał, „Kryteria z notatką obserwatora: 1 z 2”, notatka jako cytat, przy braku notatki tekst „To nie jest niska ocena”. Przed dodaniem ćwiczenia: „Kandydat nie ma jeszcze ćwiczenia w tej rekrutacji”. |
| Etapy rekrutacji i decyzja | PASS | Lista etapów z aktualnym („Ćwiczenie AC (aktualny)”), historia dwóch przesunięć z autorem i czasem, decyzja „Kolejny etap” z uzasadnieniem i historią. |
| Wydruk A4 | PASS | PDF A4, 5 stron. W PDF nie ma: „Drukuj / zapisz PDF”, „Pobierz CSV”, „Historia eksportu”, „Oceń odpowiedź”, „Otwórz ćwiczenie”, „Etapy oceny”, „Dalsze kroki”; jest nagłówek sekcji testu i stopka. Odnośnika „Uruchom analizę ponownie” nie było na ekranie (analiza aktualna), więc uwaga z 18.11 nie wystąpiła. |
| Eksport CSV | PASS | Plik `skillcheck-raport-kandydata-<zgłoszenie>.csv`, UTF-8 z BOM, separator `;`, 6 wymagań w grupach Konieczne / Nieoznaczone / Dodatkowe, cytaty z pozycją. CSV nadal obejmuje tylko część z CV, bez testu, ćwiczeń i etapów (zakres kroku D). |
| Rejestr dostępu do CSV | PASS | Jedno pobranie = jeden wpis w `report_audit.candidate_report_exports` (`candidate_report_csv`, konto testowe, wersja analizy 1). Raport pokazuje „Historia eksportu: 26.11.2026, 08:29:49 · Ty (rekruter)”. |
| Historia eksportów firmy — rola rekrutera | PASS | `/eksporty`: „Historię eksportów całej firmy widzi właściciel konta firmy.” |
| Historia eksportów firmy — widok właściciela | NOT RUN | Konto testowe jest jedynym członkiem firmy; rola `owner` nie istnieje w `company_members` (dozwolone: recruiter, viewer), właściciel to osobna rzecz. Nie zmieniano właściciela firmy testowej. |
| Ekran analizy CV („Macierz wymagań i dowodów”) | PASS | Stan „Analiza ukończona · wersja 1”, wiersze z werdyktem, cytatem i źródłem (CV v2, pozycja), statusem człowieka, formularz weryfikacji. |
| B1 (przesunięcia etapów nie unieważniają analizy) | PASS | Po dwóch przesunięciach i zapisie decyzji w raporcie i na ekranie analizy nie ma ani jednego „Wynik nieaktualny”; wymagania pokazują „Potwierdzone w CV” / „Brak informacji w CV”. |
| O1 (lista grup zgodna z raportem) | PASS | „Wyniki preselekcji (grupy)”: jedna osoba z wynikiem i punktami, pozostałe cztery „Wynik aktualny — punkty pokażemy po sprawdzeniu przez człowieka”; żadna „nieaktualny”. |
| Dostęp z obcej firmy | PASS | Raport i CSV zgłoszenia z innej firmy: 404 / `not_found`; zgłoszenie obcej firmy pod adresem własnej firmy: 404. |
| Błędy w konsoli przeglądarki | PASS | Tylko zablokowany skrypt paska Vercel (`vercel.live`) przez CSP — nie dotyczy aplikacji. |

Zrzuty ekranu: `docs/checks/screens-r2-2026-11-26/` — `01-raport-ekran.png`, `02-historia-eksportu.png`,
`03-wydruk-media-print.png`, `04-ekran-preselekcji.png`, `05-rekrutacja-grupy.png`,
`06-raport-rekrutacji.png`, `07-eksporty-firmy-rekruter.png`, `08-wydruk-pdf-a4-strona1.png`.

## Błędy

Nie znaleziono błędów w kodzie. Zmian w kodzie nie ma.

## Obserwacje (nie błędy)

- O2 (bez zmian): CSV nie zawiera testu, ćwiczeń ani etapów.
- Starsza próba testu kompetencji z 18.11 jest podpisana „Ocenił(a): Właściciel konta firmy” — to etykieta
  autora oceny z tamtego sprawdzenia, nie rola konta testowego.
- Nowa próba z 26.11 (R1) czeka na ocenę rekrutera; ocenę człowieka z cytatami sprawdzono w R1 (krok 7, baza).

## Dane testowe dodane na Preview

Oznaczenia wymagań stanowiska (Excel, SQL konieczne; CRM dodatkowe), dwa etapy rekrutacji, dwa
przesunięcia i jedna decyzja kandydatki A, jedno ćwiczenie AC „Test R2 26.11: …” z jedną obserwacją,
jeden wpis eksportu CSV. Wszystko fikcyjne, tylko Preview. Hasło konta testowego ustawione na
losową wartość, niezapisaną nigdzie.

## Co zostaje

- Widok historii eksportów firmy jako właściciel firmy (NOT RUN) — wymaga konta właściciela firmy
  testowej na Preview. Propozycja: założyć w Preview osobną firmę testową z kontem właściciela w
  `example.com` przy okazji kolejnego przejścia R3/R7.
