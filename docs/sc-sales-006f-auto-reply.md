# SC-SALES-006F — automatyczne potwierdzenie zgłoszenia

TASK: SC-SALES-006F
LEVEL: L3
SCOPE: BACKEND
OWNER: Krzysztof
REVIEWER: Codex (review tego samego wykonawcy)
DEPENDS ON: SC-SALES-006B/C/E, issue #67, PR #64
PRODUCTION_APPROVAL: NO — właściciel wstrzymał wdrożenie do powrotu do komputera.

## Co otrzyma klient

Nadawca: SkillCheck <pomoc@skillcheck.pl>. Reply-To: pomoc@skillcheck.pl.
Temat: „SkillCheck — otrzymaliśmy Twoje zgłoszenie”.

Gotowy szablon: `sales-confirmation-v1.txt`, podgląd HTML: `sales-confirmation-v1.html`.
Źródło obu: `lib/sales-mail-template.ts`. Zawiera potwierdzenie, uzasadnienie rozmowy, cztery pytania i informację, że to automat. Nie udaje osobistego zapoznania się ze zgłoszeniem, nie obiecuje terminu odpowiedzi i nie rezerwuje spotkania. Odpowiedź klienta trafia do działającej skrzynki home.pl. Historia tych odpowiedzi nie jest synchronizowana do panelu.

## Działanie i zabezpieczenia

1. Transakcja przyjmująca nowe zgłoszenie tworzy wpis prywatnej kolejki. Jeśli DB-flag wyłączony, nie powstaje wpis. Nie ma backfillu historycznych zgłoszeń.
2. Unikatowy lead_id i brak ponownego INSERT przy replay eliminują powielanie kolejki. Limit jednego potwierdzenia na znormalizowany adres / 24h, pod blokadą transakcyjną. Zgłoszenia nadal mogą być zapisywane zgodnie z limitami formularza.
3. Next `after()` inicjuje pierwszą próbę po odpowiedzi formularza. Zapisane zgłoszenie pozostaje sukcesem niezależnie od stanu dostawcy. Zewnętrzny harmonogram wywołuje `/api/internal/sales-mail`, żeby odzyskiwać zgubione próby i ponawiać błędy.
4. Worker: HMAC SHA256 z osobnym sekretem, zakres claim/finish, podpisane argumenty i data ±60s. Wymagana również zgodność świeżej dzierżawy. Jedno claim na nonce. Tabele prywatne, RLS, brak bezpośredniego dostępu ról API; service_role nieużywane.
5. `FOR UPDATE SKIP LOCKED`, dzierżawa 2 min, timeout HTTP 10s. Ponowienia 60/180/540/1620/3600s, maksymalnie 6 prób; utrata odpowiedzi dostawcy używa tego samego klucza Resend. Klucz `sales-confirmation-v1/<lead_id>`, niezmienna treść v1.
6. Resend przechowuje klucz idempotencji 24h; automat kończy próby już po 12h od pierwszej. Stan uncertain wymaga ręcznego sprawdzenia w Resend, bez automatycznego ponawiania po wygaśnięciu klucza. Pending starsze niż 24h i zakończone rozmowy są pomijane. `accepted` = przyjęcie przez dostawcę, NIE dowód doręczenia do skrzynki. Brak webhooków delivery/bounce w tym zakresie.
7. Do Resend trafiają wyłącznie adres odbiorcy, standardowy szablon i techniczny identyfikator. Brak opisu potrzeb, imienia, firmy, telefonu/CV, pikseli śledzących oraz newslettera. Wyłączyć click/open tracking także po stronie dostawcy.
8. Queue FK ON DELETE CASCADE: usuwanie zgłoszenia usuwa kolejkę/metadane w bazie. Retencja po stronie poczty/Resend to osobna konfiguracja i obowiązek administratora.
9. Wysyłka wymaga `VERCEL_ENV=production` i jawnej flagi. Preview/development nie wysyłają nawet przy omyłkowo dostępnych kluczach. Endpoint chroniony osobnym bearer secret min32 bajty; nie przyjmuje odbiorcy ani treści od wywołującego. Zwraca tylko liczniki.

## Uruchomienie później — bez zmian produkcji teraz

1. Wznowienie przez właściciela; review i zielone CI. Kontynuować runbook 006E (nie ponawiać już zastosowanych migracji).
2. Dodać migrację `20261009104142_sales_lead_auto_reply.sql` po 006B i 006E. Domyślnie enabled=false.
3. Zweryfikować domenę/nadawcę `pomoc@skillcheck.pl` w Resend, zakres klucza tylko wysyłka dla domeny i warunki przetwarzania danych. Istniejące rekordy DNS nie dowodzą gotowości konkretnego konta/API key. Nie zmieniać działającego MX home.pl. Wyłączyć tracking.
4. Wygenerować osobne sekrety worker i cron (min32 losowe bajty). Vercel production sensitive: RESEND_API_KEY, SALES_MAIL_WORKER_SECRET, SALES_MAIL_CRON_SECRET. Worker secret ten sam w private.sales_mail_settings.worker_secret; wartości nigdy do logów/Git/chatu. Nie używać SALES_LEAD_REQUEST_SECRET do poczty.
5. `SALES_AUTO_REPLY_ENABLED=false` podczas przygotowania. Ustawić harmonogram co 5 min (wybrany scheduler z takim interwałem) GET https://skillcheck.pl/api/internal/sales-mail z Authorization Bearer SALES_MAIL_CRON_SECRET. Nie włączać bez sekretu. Harmonogram nie jest rejestrowany przez ten PR. Jeśli używany natywny Vercel Cron, trzeba osobno dostosować autoryzację do jego CRON_SECRET i sprawdzić obsługiwany interwał/plany; nie zakładać, że nazwa SALES_MAIL_CRON_SECRET będzie przez Vercel wysłana automatycznie.
6. Wdrożyć kod, DB enabled=true i Vercel SALES_AUTO_REPLY_ENABLED=true dopiero po konfiguracji. Bez wznowienia zgody przez właściciela nie wykonywać tych kroków.
7. Kontrolowany test na własnym adresie: formularz → jeden lead i jeden outbox → e-mail w skrzynce → odpowiedź trafia do pomoc@skillcheck.pl → powtórzenie formularza nie wysyła duplikatu. Wcześniejsze testy używają stubu Resend; nie stanowią testu doręczenia.
8. Sprawdzić brak PII w logach, kolejkę retry/failed/uncertain i scheduler. Nie resetować prób/first_attempt_at w produkcji: grozi wysyłką duplikatu poza oknem idempotencji. Naprawę odbiorcy/nadawcy i uncertain obsłużyć ręcznie po weryfikacji dostawcy.
9. Rollback: Vercel SALES_AUTO_REPLY_ENABLED=false + private.sales_mail_settings.enabled=false, zatrzymać scheduler. Zachować zapisane zgłoszenia/kolejkę; nie uruchamiać hurtowej wysyłki historycznej po ponownym włączeniu.

Zapytanie diagnostyczne (wyłącznie administrator, bez PII):

```sql
select state, count(*), min(created_at), min(next_attempt_at)
from private.sales_mail_outbox group by state order by state;
```

## Weryfikacja

`npm run test:sales-mail`: szablon, filtrowanie recipientów, Resend stub, podpisy, flagi i worker auth, transakcje, uprawnienia, retry, wygasanie, retencja. CI używa PostgreSQL 16 (SALES_MAIL_TEST_DATABASE_URL) i dodatkowo równoległych insertów/claimów. Lokalnie PGlite. Istniejące testy formularza, typecheck/build i kontrakty bazy obowiązują.

Dokumentacja dostawcy sprawdzona 9.10.2026:
- https://resend.com/docs/api-reference/emails/send-email
- https://resend.com/docs/dashboard/emails/idempotency-keys

## Ograniczenia operacyjne

Nie skonfigurowano klucza Resend ani harmonogramu, nie wykonano migracji produkcyjnej i nie wysłano żadnej prawdziwej wiadomości. Przed aktywacją potrzebny test doręczenia, konfiguracja limitów/budżetu i retencji dostawcy. Odpowiedzi klientów pozostają w skrzynce pocztowej, panel przechowuje zgłoszenie i stan rozmowy.
