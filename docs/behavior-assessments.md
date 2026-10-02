# Oceny z dowodami i historią

Rekrutacja → kandydat → Etapy oceny → Oceny z dowodami i historią. Osiem obszarów odpowiada przewodnikowi rozmowy. Skala: niewystarczające dane, poniżej wymagań, zgodne z wymaganiami, powyżej wymagań. Wymagany poziom stanowiska pozostaje osobnym polem. Nie ma punktacji, diagnozy osobowości, decyzji o zatrudnieniu, wysyłki do AI ani kontaktu z kandydatem.

Oceny poniżej/zgodne/powyżej wymagają uzasadnienia do 10 000 znaków. Formularz przypomina o sytuacji, działaniach, rezultacie i rozróżnieniu relacji kandydata od obserwacji. Brak wpisu i niewystarczające dane nie oznaczają oceny negatywnej. Ocena dotyczy konkretnego zgłoszenia, nie wszystkich rekrutacji osoby.

## Zapis i uprawnienia

`save_behavior_assessment` wykonuje zapis transakcyjnie. Ponownie sprawdza sesję i rolę właściciela/rekrutera, blokuje wiersze zgłoszenia/rekrutacji/stanowiska na czas zapisu oraz dopuszcza tylko zgłoszenie new/in_progress, rekrutację draft/open i niezarchiwizowane stanowisko. Viewer czyta historię, ale nie zapisuje.

Autor, firma i powiązania pochodzą z bazy. RPC sprawdza oczekiwaną wersję oceny, identyfikator i znacznik aktualizacji stanowiska; blokada transakcyjna serializuje zapisy tego samego zgłoszenia także przed pierwszym wpisem. Konflikt wymaga odświeżenia i porównania danych; treść formularza pozostaje dostępna do skopiowania. Aktualizacja innego obszaru nie wymienia automatycznie kontekstu otwartego formularza.

Wymaganie obszaru musi wystąpić dokładnie raz i mieć jeden z czterech znanych poziomów. Baza normalizuje takie same białe znaki jak parser JavaScript, aby tabulatory/Unicode nie ukrywały duplikatów. Niepełny lub niejednoznaczny profil blokuje ocenę danego obszaru.

Każdy zapis dopisuje nową wersję do `behavior_assessment_entries`: autora, datę, ocenę, uzasadnienie, wymagany poziom i kopię profilu (tytuł, opis, zadania, KPI, samodzielność, kompetencje i wymagania zachowań). Role aplikacji nie mają bezpośredniego INSERT/UPDATE/DELETE; tabela ma RLS. Widok `latest_behavior_assessments` wykonuje odczyt z uprawnieniami wywołującego i zwraca najnowszą wersję każdego obszaru. Historia używa numeru wersji jako kursora, po 20 wpisów; zapytania zawsze filtrują firmę, rekrutację, zgłoszenie i obszar.

Historia pozostaje po zmianie profilu i zamknięciu procesu. Usunięcie nadrzędnego zgłoszenia usuwa historię kaskadowo zgodnie z modelem danych; nie jest to niezależne, nieusuwalne archiwum. Bezpośrednie usunięcie autora blokuje FK. Retencja i procedura usuwania kont/danych wymagają osobnego opracowania.

## Migracja i weryfikacja

Migrację `20261002000100_behavior_assessments.sql` wykonano 2026-10-02 w projekcie Supabase wsvjawuikxfzjyivxgsu, po sprawdzeniu, że tabela i widok nie istniały. Kontrola po wykonaniu potwierdziła 11 tabel, 38 polityk, RLS tabeli, security_invoker widoku, brak SELECT dla anon i bezpośrednich zapisów authenticated, a także dostęp authenticated do RPC. Nie wykonywać ponownie żadnej z czterech wykonanych migracji. Brak modułu w innym środowisku pokazuje czytelny komunikat i pozostawia dostęp do notatek etapów.

- `test:behavior-assessments`: walidacja skali/dowodów/kursora i rzeczywiste wykonanie migracji w PGlite. Właściciel/rekruter, viewer/anon, obca firma, widok RLS, niezmienność wpisów, autor, wersje, kopia profilu, błędne wymagania Unicode, statusy i odebrane uprawnienia. 12 raportowanych testów, łącznie z testem nadrzędnym, przeszło.
- Typecheck i build przeszły. `test:http` potwierdza odmowę anonimowego wejścia i no-store dla ocen i historii. Sześć testów przewodnika oraz cztery mechanizmu kontroli live również przeszły.
- Test zalogowanego formularza po publikacji Preview pozostaje do wykonania. PGlite nie potwierdza wyścigów dwóch rzeczywistych połączeń PostgreSQL; tę próbę oraz dwie firmy/role przez Supabase API należy wykonać osobno.
- `test:live` rozszerzono o tabelę wpisów i widok najnowszych ocen. Obie firmy muszą mieć własny wpis; puste relacje nie dają PASS. Nie skonfigurowano jeszcze dwóch kont do tej próby.

Źródła mechanizmów PostgreSQL: [widoki security_invoker](https://www.postgresql.org/docs/current/sql-createview.html), [blokady wierszy i transakcyjne blokady doradcze](https://www.postgresql.org/docs/17/explicit-locking.html).

### Poprawki po pierwszej próbie Preview

Pierwsze trzy zapisy fikcyjnej oceny utworzyły wersje poprawnie. Test wykrył reset listy wyboru po akcji React; formularz blokuje teraz automatyczny reset natywnych pól. Nieaktualne żądanie z drugiego okna długo oczekiwało i wróciło z ogólnym błędem. Przyczyną był domenowy SQLSTATE 40001, który starszy PostgREST ponawia jako błąd przejściowy — [opis Supabase](https://supabase.com/docs/guides/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b). Dodano migrację 20261002000200_behavior_conflict_response.sql z PT409 dla konfliktu profilu/oceny; wykonana 2026-10-02 z wynikiem Success. Oryginalnej wykonanej migracji nie zmieniano. Wszystkie 12 testów ocen ponownie przeszło z nową migracją. Powtórzenie testu poprawionego Preview jest w toku.
