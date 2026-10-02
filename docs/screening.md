# Preselekcja — przygotowanie danych, bez integracji AI

## Dostępny zakres
Ze strony rekrutacji przy każdym kandydacie można otworzyć Przygotowanie preselekcji. Widok dotyczy zgłoszenia, nie globalnej oceny osoby. Pokazuje aktualne zadania, KPI, kompetencje i najnowszy sprawdzony tekst CV. Czytanie odbywa się przez klienta sesji użytkownika i istniejące RLS, z filtrami firmy oraz relacji zgłoszenie–rekrutacja–stanowisko–kandydat.

Nie ma połączenia z modelem, wysyłki danych, zapisu wyniku, rankingu ani automatycznej decyzji rekrutacyjnej. Komunikat w interfejsie informuje, że analiza nie jest uruchomiona. Nie ma pozornego przycisku generowania ani przykładowych ocen udających wynik AI.

## Warunki przygotowania
- Tylko aktywne zgłoszenia (new/in_progress), rekrutacja draft/open, stanowisko niezarchiwizowane.
- Wybierane jest najnowsze CV według created_at i id. Nowszy szkic blokuje przygotowanie; nie cofamy się niejawnie do starszego zatwierdzonego CV.
- CV musi być zatwierdzone i mieć metadane recenzenta; sprawdzamy zgodność firmy i kandydata. Brak migracji CV daje czytelny komunikat.
- Wymagane zadania i KPI; ograniczenia list zgodne z formularzem stanowiska.
- Osobna lista zachowań i samodzielności jest przeznaczona do późniejszej rozmowy/zadań. Nie oceniamy osobowości z CV.

## Kontrakt przyszłej integracji
lib/screening.ts przygotowuje wyłącznie sprawdzony tekst CV i jawnie wskazane zadania/KPI/kompetencje. Oryginał CV, dane kontaktowe, identyfikatory firmy/kandydata/recenzenta i opis stanowiska nie trafiają do payload. To nie gwarantuje anonimowości tekstu: człowiek sprawdza anonimizację CV i treść wymagań.

Identyfikatory i wersje są przechowywane osobno w binding. Fingerprint SHA-256 wiąże wymagania i tekst z konkretnym zgłoszeniem. assertScreeningCurrent wymaga ponownego załadowania danych i blokuje nieaktualny materiał. Nie jest tokenem autoryzacyjnym i nie wolno ufać wartościom przysłanym przez przeglądarkę.

Walidator przyszłej odpowiedzi wymaga dokładnie jednego wpisu na każde kryterium, bez dodatkowych pól decyzji. Poziomy: insufficient_data, below, meets, above. Każda ocena inna niż brak danych wymaga cytatu zgodnego znak w znak z zatwierdzonym tekstem i poprawnymi indeksami UTF-16. Maksymalnie pięć cytatów po 2000 znaków. Walidator potwierdza zgodność tekstu, nie prawdziwość deklaracji ani poprawność interpretacji; każdy wynik musi sprawdzić rekruter.

## Przed uruchomieniem AI
Nadal do implementacji: wybór dostawcy i modelu, jawny budżet, konfiguracja kluczy, zgoda na wysłanie sprawdzonego materiału, instrukcje odporne na polecenia w CV, limity żądań/kosztów, obsługa błędów, idempotencja, zapis wyniku z RLS i stanem sprawdzenia przez człowieka. Ponownie pobierać aktualny materiał przed wysyłką oraz przed zapisem wyniku; zmiana w trakcie analizy musi unieważnić wynik. Potrzebna kontrola współbieżności w transakcji bazy przy zapisie, nie tylko porównanie w kodzie.

Ta zmiana nie dodaje migracji. Migracja 20261001000200_candidate_documents.sql została wykonana 2026-10-02; baza ma 10 tabel i 37 polityk RLS. Migracji już wykonanych nie ponawiać.

## Testy
Siedem testów lokalnej logiki obejmuje zakres danych, izolację relacji/firm, blokady statusów, aktualność wersji i walidację dowodów. Test HTTP buildu sprawdza przekierowanie anonimowego wejścia na nową stronę do logowania. Nie jest to test AI ani pełny test po zalogowaniu w Supabase/Vercel. Ten pozostaje do wykonania po powrocie użytkownika.
