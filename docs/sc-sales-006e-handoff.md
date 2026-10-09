# SC-SALES-006E — formularz → operator → odpowiedź

TASK: SC-SALES-006E
LEVEL: L3
SCOPE: FULLSTACK
OWNER: Codex
REVIEWER: Codex (przegląd w tej samej sesji)
DEPENDS ON: SC-SALES-006B/C/D
ISSUE: #62
BRANCH: feat/sc-sales-contact-launch
STATUS: IMPLEMENTED / PRODUCTION BLOCKED

## Co zmienia zadanie

- Panel zawiera bezpiecznie kodowany odnośnik „Odpowiedz e-mailem”. Otwiera domyślny program pocztowy; operator wybiera pomoc@skillcheck.pl. Nie wysyła sam wiadomości ani nie twierdzi, że wiadomość została wysłana.
- Zakończenie rozmowy bez zawarcia umowy wymaga osobnego zaznaczenia potwierdzenia. RPC ponownie sprawdza rolę operatora pod tą samą blokadą co odebranie roli.
- Zamknięcie jest idempotentne i nie przesuwa początku retencji. Nie zmienia oryginalnego zgłoszenia.
- Prywatna tabela metadanych zamknięcia ma RLS i brak dostępu ról API. Nowe RPC listy zwraca wyłącznie pola potrzebne w panelu.
- Prywatna funkcja sprzątania usuwa zgłoszenia po sześciu miesiącach od zamknięcia wraz z metadanymi i replay state. Nie usuwa otwartych rozmów.
- Informacja o danych na `/prywatnosc`, z odnośnikiem w formularzu i stopce. Formularz nadal wymaga jawnego SALES_LEAD_NOTICE, flagi i sekretu.
- Osobny workflow PostgreSQL wykonuje scenariusze równoczesności 006B i trzy testy wycofania starego klucza po rzeczywistych 60 minutach. Nie modyfikuje produkcji ani zegara.

## Weryfikacja 2026-10-09

- build i typecheck: PASS.
- test:db: 13 PASS.
- test:sales-leads: 15 PASS, w tym retencja, zamknięcie, role, idempotencja i kodowanie adresu odpowiedzi.
- test:sales-leads-http: 12 PASS.
- test:sales-leads-operator: 12 PASS z Chromium (1280 i 390 px), kontrola adresata, wymagane potwierdzenie zamknięcia, poprawny zapis, odmowa po cofnięciu roli, brak overflow/JS errors.
- test:sales-leads-browser: PASS, m.in. ponowienie po utraconej odpowiedzi, zachowanie danych przy błędzie, walidacja i obsługa klawiaturą.
- test:marketing: PASS.
- git diff --check: PASS.
- Rzeczywisty PostgreSQL: idempotencja, limity, operator grant/revoke, rotacja przed/po blokadzie PASS. Trzy rotacje przygotowane; krok rzeczywistego oczekiwania działa w run 37900072370. Wynik retire PENDING, nie PASS.

## Stan zdalny i blokada

Supabase `wsvjawuikxfzjyivxgsu`: sales_leads i platform_operators nadal nie istnieją. Dwie próby zastosowania niezmienionej migracji 006B przez apply_migration zwróciły `McpServerError: Invalid or expired requestState`. Po obu próbach potwierdzono brak tabel. Nie zastępowano zatwierdzenia inną ścieżką wykonania SQL.

Nowa migracja `20261009073604_sales_lead_inbox_retention.sql` została utworzona Supabase CLI i przetestowana lokalnie, ale nie zastosowana zdalnie. Bez produkcyjnych sekretów, nadania roli, harmonogramu ani włączenia formularza.

Zgoda właściciela na domknięcie i uruchomienie procesu jest udzielona. Problemem jest wygasający stan zatwierdzenia wtyczki, nie brak zgody w rozmowie.

## Runbook po odzyskaniu działania zatwierdzeń

1. Sprawdź końcowy PASS run 37900072370. Jeśli zmienił się kontrakt 006B/signature/normalization, powtórz pełny test dla nowego kodu. Nie cofaj timestampów.
2. Zielone CI i review task PR → integration, potem promotion integration → main. Zweryfikuj niezwiązane zmiany przed promocją. Flagi formularza pozostają wyłączone.
3. Sprawdź to_regclass i historię migracji. Zastosuj dokładnie 006B (jeśli brak), potem migrację retencji. Narzędzie nadaje własny numer wersji: porównuj również nazwę i obiekty, nigdy nie ponawiaj już wdrożonej migracji.
4. Wygeneruj nowy losowy sekret min. 32 bajty; skonfiguruj go wyłącznie w private.rotate_sales_lead_request_secret i Vercel SALES_LEAD_REQUEST_SECRET (sensitive, production). Bez ujawniania i commitowania wartości. leads_enabled pozostaje false.
5. Potwierdź użytkownika `19abc7ee-46c8-4aff-bdea-33c7c45022d4`, e-mail pomoc@skillcheck.pl, email_confirmed_at. Dodaj wyłącznie jego jako pierwszego operatora. Nie zmieniaj auth.users ani sesji. Zweryfikuj role API i advisors.
6. Włącz pg_cron zgodnie z dokumentacją Supabase (osobna zarejestrowana migracja operacyjna) i zaplanuj:

```sql
select cron.schedule('sales-leads-retention', '17 * * * *',
  'select private.purge_closed_sales_leads(); select private.purge_expired_sales_lead_attempts();');
```

   Najpierw sprawdź cron.job, aby nie tworzyć duplikatu. Przetestuj funkcje, potwierdź aktywny job i późniejszy succeeded w job_run_details. Usuwanie z bazy nie usuwa kopii odpowiedzi w poczcie — operator musi stosować ten sam okres w skrzynce. Przy przywróceniu backupu ponownie uruchom sprzątanie.
7. SALES_LEAD_NOTICE (production): „Administratorem danych jest KTIG CONSULTING Sp. z o.o., ul. Michała Kajki 10–12, 10-547 Olsztyn. Kontakt: pomoc@skillcheck.pl. Dane służą obsłudze zapytania i rozmowom o współpracy. Jeżeli nie zawrzemy umowy, przechowujemy je przez 6 miesięcy od zakończenia rozmów. Szczegóły i Twoje prawa opisujemy poniżej.”
8. Po wszystkich kontrolach włącz flagę DB oraz SALES_LEADS_ENABLED=true w Vercel i wdrożenie production. Sprawdź rzeczywisty formularz → jeden zapis → panel operatora → poprawny adres odpowiedzi. Używaj danych fikcyjnych, nie wysyłaj e-maili do klientów. Sprawdź odmowę dla anonimowego/nie-operatora, HTTPS i brak danych w logach.
9. Usuń wyłącznie dokładnie wskazane zgłoszenie testowe, sprawdź błędy runtime, zapisz identyfikator deploymentu i SHA. Dopiero wtedy status DONE.

## Zakres świadomie nieobjęty

Automatyczna wysyłka e-maili, historia korespondencji, powiadomienia o nowych zgłoszeniach, płatności, abonamenty i automatyka agentów. Obecny proces odpowiadania wykorzystuje działającą pocztę właściciela.
