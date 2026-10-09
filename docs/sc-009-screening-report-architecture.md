# SC-009 — Raport preselekcji i eksport

## Kontrakt zadania

- TASK: SC-009 / Issue #10
- LEVEL: L3 (nowy eksport danych kandydatów i kontrola dostępu; backlog określał L2)
- SCOPE: FULLSTACK
- OWNER / BUILDER: Codex na bezpośrednie polecenie właściciela z 2026-10-09
- REVIEWER: Codex, osobna recenzja
- DEPENDS ON: SC-008, kontrakt architektury PR #47 @ 93d378a
- BASE: integration @ 0003b8d
- STATUS: implementacja równoległa autoryzowana poleceniem „przygotuj architekturę i zrób SC 009”; zależność produkcyjna pozostaje otwarta.

## Cel i granice

Firma otrzymuje raport jednej rekrutacji: wymagania stanowiska, ranking, świadomie wybraną shortlistę oraz oceny i dowody po review człowieka. Raport nie podejmuje decyzji o zatrudnieniu. Eksport CSV zawiera te same oceny i cytaty co ekran; widok do druku umożliwia zapis PDF przez przeglądarkę.

Nie implementujemy SC-008 w SC-009. Nie dodajemy migracji, RPC, grantów, zmian RLS, naliczania punktów ani wywołań AI. Nie zmieniamy globalnych typów bazy, aby nie deklarować niewdrożonych RPC jako istniejących. Dwa odczytowe kontrakty SC-008 są lokalnym typem adaptera, walidowanym także w runtime.

## Przepływ

1. Użytkownik otwiera raport z ekranu rekrutacji; wybiera wielkość sugestii 5–10 (domyślnie 10).
2. Serwer weryfikuje sesję `getUser`, UUID, widoczność firmy i rekrutacji przez obecne RLS.
3. Używa `get_screening_ranking(target_recruitment, target_size)` i `get_recruitment_shortlist(target_recruitment, include_removed=false)` z SC-008.
4. Jawnie sprawdza, że wszystkie identyfikatory należą do zgłoszeń tej firmy i rekrutacji. Brakujące lub nadmiarowe wiersze blokują raport.
5. Pobiera tylko wybrane kolumny wyników i wskazanego review. Dowody są prezentowane wyłącznie dla aktualnego wyniku z zatwierdzonym review (`eligible` lub `insufficient_evidence`). Override pochodzi wyłącznie z review wskazanego przez ranking. Puste nadpisanie cytatów/uzasadnienia jest zachowane; `null` oznacza zachowanie wartości AI.
6. Ponownie odczytuje nagłówek, zgłoszenia, ranking i shortlistę. Jeśli dane się zmieniły, zwraca 409 z poleceniem odświeżenia. To kontrola optymistyczna, nie transakcyjny snapshot bazy ani archiwum historyczne. Zmiana po końcowym odczycie nie zmienia już wygenerowanego pliku.
7. Renderuje raport albo zwraca plik CSV. Każde pobranie ponownie sprawdza uprawnienia; pobierany plik może mieć nowszy stan niż wcześniej otwarty ekran. Czas wygenerowania jest widoczny.

## Dane i semantyka

- Kandydat reprezentowany przez identyfikator zgłoszenia; bez nazwiska, telefonu i e-maila. Ekran odsyła do istniejącego widoku preselekcji wewnątrz firmy. Identyfikatory i cytaty nadal są danymi poufnymi, nie anonimowymi.
- `rank`, `raw_score`, `coverage`, sugestia i wersja polityki pochodzą wyłącznie z SC-008. SC-009 nie przelicza punktów ani progu coverage.
- `insufficient_data` wyświetla się jako „Brak wystarczających danych”. `null` score pozostaje pustą komórką CSV i „—” na ekranie, nigdy 0.
- Sugestia algorytmu i zapisana shortlista człowieka są osobnymi polami. Nieaktualny wpis shortlisty pozostaje widoczny jako wymagający ponownego sprawdzenia; historyczny score nie zastępuje bieżącego.
- Kryteria raportu używają snapshotów ocenianej analizy; wymagania aktualnego stanowiska są oddzielną sekcją.
- Nieeksportowane: pełna treść CV, input/binding snapshot, podsumowanie modelu, confidence, payload providera, identyfikatory requestów, review_note, notatki shortlisty, autorzy review.
- Brakujące RPC (`PGRST202`, `42883`) daje 503 i informację o niedostępności rankingu; brak pustego „udanego” eksportu i brak zastępczego rankingu.

## Interfejsy i limity

- Ekran: `/dashboard/[companyId]/recruitments/[recruitmentId]/report?size=10`.
- CSV: ta sama ścieżka + `/export?size=10`, GET, UTF-8 BOM, separator `;`, CRLF, cytowanie każdej komórki.
- Wszystkie tekstowe komórki zabezpieczone przed formułami arkusza (także poprzedzonymi whitespace/control characters). Cudzysłowy są podwajane; tekst dowodów nie jest HTML-em ani Markdown-em.
- Widok do druku: ten sam ekran, CSS print, bez nawigacji i przycisków. PDF powstaje lokalnie przez funkcję drukowania przeglądarki, nie na publicznym URL ani w Storage.
- Wszyscy uprawnieni czytelnicy firmy, w tym viewer, mogą czytać i eksportować; brak mutacji danych.
- Limit 500 zgłoszeń na raport. Odczyty stronicowane w paczkach po 200, zapytania IN w paczkach po 50. Przekroczenie limitu lub niepełna odpowiedź blokuje eksport zamiast obcinać raport.
- Błędy: 400 parametry, 401 sesja, 404 brak dostępu lub nieistniejąca firma/rekrutacja, 409 zmiana/niespójność źródeł, 413 limit, 503 brak SC-008, 500 bezpieczny komunikat pozostałych błędów.
- `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`; nazwa pliku wyłącznie z walidowanego UUID. Brak logowania treści danych i błędów providera.

## Akceptacja i testy

1. Ekran i CSV odzwierciedlają te same dane SC-008, z osobną sugestią i shortlistą.
2. Najnowsze wskazane review stosuje override; wyniki AI nie są zmieniane.
3. Brak danych, stale, potrzeba ponownej analizy i brak review nie są oceną negatywną.
4. Obca firma/rekrutacja i brak sesji blokują odczyt; brak RPC blokuje eksport.
5. Błędy i zmiana źródeł nie dają częściowego raportu; paginacja nie obcina danych.
6. Testy adaptera, niezmienności, CSV injection, kontraktu HTTP oraz regresje screeningu i bazy; typecheck i build.
7. Przed uruchomieniem produkcyjnym wymagane: zaakceptowany i wdrożony SC-008, rzeczywisty test RPC/raportu na danych syntetycznych, review i osobna zgoda produkcyjna. Testy z adapterem nie dowodzą integracji z niewdrożonym SC-008.

Dokumentacja sprawdzona podczas implementacji: Supabase `rpc` oraz SSR `getUser` (2026-10-09). Nie zmieniamy kontraktów uwierzytelnienia ani dostawcy AI.
