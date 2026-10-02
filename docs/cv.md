# CV tekstowe i anonimizacja — wersja przygotowana do testów

## Zakres
- Karta kandydata → CV i anonimizacja tekstu.
- Wklejony tekst lub TXT UTF-8 do 200 KB; PDF z warstwą tekstową do 750 KB i 20 stron. Każda strona musi zawierać odczytywalny tekst. Maksymalnie 100 000 znaków wyniku. DOCX do 750 KB; OCR pozostaje do zbudowania.
- Oryginalny tekst i wersja redagowana są przechowywane w prywatnych rekordach PostgreSQL, z RLS firmy. Oryginalny plik nie jest zachowywany, nie utworzono publicznego bucketu.
- Reguły proponują zamianę imienia, nazwiska, e-maili, adresów URL i ciągów przypominających telefon/identyfikator. To nie jest kompletna automatyczna anonimizacja. Rekruter musi sprawdzić m.in. adres, wiek, daty, odmiany nazwisk, nazwy profili i pośrednie identyfikatory.
- Zatwierdzenie dotyczy konkretnej wersji tekstu. Baza zapisuje tożsamość recenzenta i czas. Edycja tekstu cofa zatwierdzenie; przestarzała edycja lub zatwierdzenie są odrzucane. Nie oceniamy i nie kontaktujemy kandydatów.
- Właściciel/rekruter tworzy, edytuje i zatwierdza. Viewer czyta. Brak dostępu anonimowego i między firmami.

## Migracja wykonana na Supabase — 2026-10-02
Plik supabase/migrations/20261001000200_candidate_documents.sql wykonano w SQL Editor projektu wsvjawuikxfzjyivxgsu; wynik Success. Przed wykonaniem sprawdzono stan 9 tabel / 34 polityki oraz brak candidate_documents. Kontrola po wykonaniu potwierdziła 10 tabel / 37 polityk i włączone RLS we wszystkich tabelach. Ta migracja oraz poprzednie dwie są już wykonane — nie ponawiać ich.

Tabela candidate_documents ma trzy polityki i aktywny wyzwalacz wersjonowania. Kontrola SQL potwierdziła granty authenticated do odczytu, edycji redacted_text i RPC zatwierdzania oraz brak bezpośredniego UPDATE oryginału i metadanych zatwierdzenia. Rola anon nie ma odczytu tabeli ani wykonania RPC. Te granty nie zastępują kontroli firmy przez RLS ani testu rzeczywistej sesji aplikacji.

Kod modułu jest dostępny w gałęzi Preview; produkcja pozostaje na main 62a47ba. Wykonanie migracji nie oznacza zakończenia testów importu na Vercel po zalogowaniu.

## Weryfikacja
- test:cv: odczyt DOCX (polskie znaki, tabele, błędne archiwa, limity rozpakowania i liczby wpisów, nieobsługiwane elementy), walidacja TXT/UTF-8 i rzeczywistego parsera PDF (syntetyczne dokumenty, skompresowane strumienie, wiele stron, puste/mieszane strony, błędny format i limity), binarne i nadmierne dane, reguły redakcji, uprawnienia PostgreSQL/PGlite, obce firmy, niezmienność oryginału, ochrona metadanych zatwierdzenia i konflikt wersji.
- 2026-10-02 ponownie wykonano test:cv: wszystkie 15 raportowanych testów przeszło, w tym testy parserów i RLS w PGlite.
- test:http obejmuje odmowę dostępu anonimowego do podstrony CV.
- test:live obejmuje 10 tabel; migracja CV jest już wykonana, nadal potrzebne są dwa rzeczywiste konta. Test nie został jeszcze wykonany z prawdziwymi danymi dostępowymi.
- Pozostają testy zalogowanej przeglądarki: plik i wklejanie, zachowanie danych po błędzie, edycja i cofnięcie zatwierdzenia, konflikt dwóch okien oraz drugi użytkownik/inna firma. Nie uznawać PGlite za test pełnej integracji.

## Dalszy rozwój
Późniejsza preselekcja może korzystać wyłącznie ze sprawdzonej wersji i musi ponownie sprawdzać wersję/status przed wysyłką. Zatwierdzenie przez człowieka nie gwarantuje całkowitej anonimowości. Zewnętrzna integracja wymaga osobnej konfiguracji i budżetu. Nie dodano wysyłki do AI.

## Odczyt PDF
- Biblioteka pdf-parse 2.4.5 przypięta w package-lock.json; odczyt wyłącznie z bajtów przesłanego pliku, bez pobierania adresów URL. Wyłączone eval, fetch workera oraz ładowanie fontów systemowych. Nie uruchamiamy kodu osadzonego w CV ani zewnętrznego OCR.
- Odczyt stron kolejno; limit stron sprawdzany przed pobraniem tekstu. Pliki chronione hasłem/uszkodzone dają komunikat bez ujawniania błędów parsera. Pusta strona zatrzymuje import całego dokumentu, żeby nie zapisać niekompletnego CV; użytkownik może wkleić pełny tekst.
- Układ tabel i kolumn może zmienić kolejność tekstu. Rekruter musi sprawdzić kompletność. Reguły redakcji nadal są pomocą, nie gwarancją anonimizacji.
- Limit 750 KB pozostawia miejsce na narzut formularza w domyślnym limicie akcji Next. Limity pliku/stron/tekstu nie są izolacją pamięci ani czasu procesu; przed publicznym masowym importem potrzebna jest kolejka/izolowany proces i limity obciążenia.
- Next config dołącza dynamiczne pliki workera i canvas. test:pdf-bundle sprawdza manifest wdrożenia i istnienie natywnego pliku platformy; wykonywany też w CI na Linux. Wdrożenie serwerowe Vercel nadal wymaga testu rzeczywistego importu po zalogowaniu.
- API parsera: https://github.com/mehmet-kozan/pdf-parse/blob/main/docs/options.md.

## Odczyt DOCX
- Mammoth 1.13.0: wyłącznie extractRawText z bufora, bez konwersji do HTML, zachowywania pliku i zewnętrznych usług.
- Yauzl sprawdza archiwum wpis po wpisie: do 500 wpisów, 2 MB pojedynczego wpisu i 10 MB łącznie po rozpakowaniu. Liczymy rzeczywiste bajty strumienia, nie tylko rozmiary z nagłówków. Odrzucamy szyfrowanie, powtórzone/niebezpieczne ścieżki, programy osadzone i XML z DTD lub nieobsługiwanym kodowaniem.
- JSZip odbudowuje archiwum wyłącznie ze sprawdzonych wpisów przed odczytem przez Mammoth, aby różnice między czytnikami ZIP nie omijały kontroli. Nic nie jest wypakowywane na dysk. Limity nie stanowią twardej izolacji czasu i pamięci procesu.
- Odczyt obejmuje treść akapitów i tabel; nie wykonuje OCR obrazów. Dokumenty z nagłówkami, stopkami i przypisami oraz ostrzeżeniami parsera są odrzucane z prośbą o pełny tekst lub tekstowy PDF. Rekruter nadal musi porównać kompletność z oryginałem.
- Test hiperłącza zewnętrznego potwierdza, że zapisujemy tekst etykiety bez wywołania fetch. Nie pobieramy adresów z CV.
- DOCX korzysta z wykonanej migracji candidate_documents i nie wymaga kolejnej. Nadal pozostaje test importu po zalogowaniu.
