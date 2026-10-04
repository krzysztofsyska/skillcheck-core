# Preselekcja — przygotowanie danych, bez integracji AI

## Dostępny zakres
Ze strony rekrutacji przy każdym kandydacie można otworzyć Przygotowanie preselekcji. Widok dotyczy zgłoszenia, nie globalnej oceny osoby. Pokazuje aktualne zadania, KPI, kompetencje i najnowszy sprawdzony tekst CV. Czytanie odbywa się przez klienta sesji użytkownika i istniejące RLS, z filtrami firmy oraz relacji zgłoszenie–rekrutacja–stanowisko–kandydat.

Nie ma połączenia z modelem, wysyłki danych, uruchamiania analizy, rankingu ani
automatycznej decyzji rekrutacyjnej. SC-004 dostarcza warstwę persistencji również w produkcyjnym Supabase, ale żaden
istniejący flow aplikacji nie wywołuje jeszcze integracji AI ani workera. Komunikat w interfejsie nadal informuje, że analiza
nie jest uruchomiona. Nie ma pozornego przycisku generowania ani przykładowych ocen
udających wynik AI.

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

## Persistencja wdrożona w SC-004

Migracja `20261004000200_screening_results.sql` jest wdrożona i dostarcza pięć tabel:
`screening_analysis_versions`, `screening_analysis_attempts`,
`screening_criterion_results`, `screening_result_reviews` i
`screening_criterion_review_overrides`.

- Wynik AI i jego kryteria są niezmienne; review tworzy osobną historię i override.
- Reuse wymaga jednocześnie zgodnego `input_fingerprint` oraz
  `analysis_contract_hash`.
- Kanoniczny contract hash obejmuje provider, model, model revision, prompt version
  oraz wersje schema wejścia i wyniku.
- `rating` jest źródłem prawdy. Nie ma `rating_score`, `overall_score` pozostaje
  `NULL`, a `insufficient_data` nie jest mapowane na zero.
- Zmiana danych ustawia niezależny stan stale. Wynik ukończony po zmianie wejścia
  pozostaje audytowalny jako `completed + stale`.
- Owner i recruiter startują, ponawiają i reviewują przez RPC; viewer ma wyłącznie
  odczyt. Bezpośredni zapis pięciu tabel jest zablokowany.
- Claim/complete/fail są dostępne wyłącznie dedykowanej roli serwerowej
  `screening_worker`. W bazie pozostaje tylko hash krótkotrwałego lease.
- Nie są przechowywane raw provider request/response ani nowe payloady poza
  zatwierdzonym snapshotem redacted CV, kryteriami i bindingiem audytowym.

Migracja została uruchomiona na produkcyjnym Supabase 2026-10-04. Nie zapewnia
jeszcze integracji OpenAI ani provisioningu/dispatchu wewnętrznego workera; te
elementy należą do SC-005.

## Przed uruchomieniem AI
Nadal do implementacji: wybór i konfiguracja dostawcy/modelu, jawny budżet,
konfiguracja kluczy, zgoda na wysłanie sprawdzonego materiału, instrukcje odporne
na polecenia w CV, limity żądań/kosztów oraz bezpieczny dispatch workera.
Integracja musi ponownie pobierać aktualny materiał przed wysyłką i korzystać z
lease/RPC przy zapisie. Nie wolno przekazywać internal capability do przeglądarki.

Wdrożony baseline produkcji ma 18 tabel z RLS, 45 polityk, trzy widoki
`security_invoker`, 12 publicznych RPC i osiem wykonanych migracji. Nie ponawiać
żadnej z nich.

## Testy
Testy lokalnej logiki obejmują zakres danych, izolację relacji/firm, blokady
statusów, aktualność wersji, canonical contract hash i walidację dowodów. Testy
PGlite SC-004 odtwarzają migrację, role/RLS, idempotency, lease, immutable result,
stale completion i optimistic human review. Test HTTP buildu nadal sprawdza
przekierowanie anonimowego wejścia do logowania.

2026-10-02 sprawdzono rzeczywistą sesję właściciela na Vercel/Supabase: najnowszy szkic blokuje przygotowanie mimo starszego zatwierdzonego CV. Po zatwierdzeniu DOCX widok pokazał jego wersję 2 oraz zapisane zadania, KPI, kompetencje i wymagania zachowań. Nie uruchamiano AI. Pozostają próby drugiej firmy i pozostałych ról; szczegóły docs/e2e-2026-10-02.md.
