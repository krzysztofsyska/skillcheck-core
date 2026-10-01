# CV tekstowe i anonimizacja — wersja przygotowana do testów

## Zakres
- Karta kandydata → CV i anonimizacja tekstu.
- Wklejony tekst lub TXT UTF-8 do 200 KB i 100 000 znaków. PDF, DOCX i OCR pozostają do zbudowania.
- Oryginalny tekst i wersja redagowana są przechowywane w prywatnych rekordach PostgreSQL, z RLS firmy. Oryginalny plik nie jest zachowywany, nie utworzono publicznego bucketu.
- Reguły proponują zamianę imienia, nazwiska, e-maili, adresów URL i ciągów przypominających telefon/identyfikator. To nie jest kompletna automatyczna anonimizacja. Rekruter musi sprawdzić m.in. adres, wiek, daty, odmiany nazwisk, nazwy profili i pośrednie identyfikatory.
- Zatwierdzenie dotyczy konkretnej wersji tekstu. Baza zapisuje tożsamość recenzenta i czas. Edycja tekstu cofa zatwierdzenie; przestarzała edycja lub zatwierdzenie są odrzucane. Nie oceniamy i nie kontaktujemy kandydatów.
- Właściciel/rekruter tworzy, edytuje i zatwierdza. Viewer czyta. Brak dostępu anonimowego i między firmami.

## Migracja — jeszcze niewykonana na Supabase
Nowy plik: supabase/migrations/20261001000200_candidate_documents.sql.
Stosować dopiero po zakończeniu testów środowiska. Poprzednie dwie migracje są już wykonane i nie wolno ich ponawiać.
Nowa migracja dodaje jedną tabelę, trzy polityki, wyzwalacz wersjonowania i RPC zatwierdzania. Bez tej tabeli podstrona CV pokazuje, że moduł oczekuje na uruchomienie; pozostałe strony nie wymagają nowego schematu.

## Weryfikacja
- test:cv: walidacja TXT/UTF-8, binarne i nadmierne dane, reguły redakcji, uprawnienia PostgreSQL/PGlite, obce firmy, niezmienność oryginału, ochrona metadanych zatwierdzenia i konflikt wersji.
- test:http obejmuje odmowę dostępu anonimowego do podstrony CV.
- test:live obejmuje teraz 10 tabel i wymaga migracji CV oraz dwóch rzeczywistych kont. Nie został jeszcze wykonany z prawdziwymi danymi dostępowymi.
- Pozostają testy zalogowanej przeglądarki: plik i wklejanie, zachowanie danych po błędzie, edycja i cofnięcie zatwierdzenia, konflikt dwóch okien oraz drugi użytkownik/inna firma. Nie uznawać PGlite za test pełnej integracji.

## Dalszy rozwój
Późniejsza preselekcja może korzystać wyłącznie ze sprawdzonej wersji i musi ponownie sprawdzać wersję/status przed wysyłką. Zatwierdzenie przez człowieka nie gwarantuje całkowitej anonimowości. Zewnętrzna integracja wymaga osobnej konfiguracji i budżetu. Nie dodano wysyłki do AI.
