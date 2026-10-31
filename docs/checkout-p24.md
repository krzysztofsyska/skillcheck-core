# SC-CHECKOUT-P24-001 — publiczna ścieżka zakupu online (Przelewy24)

LEVEL: L3 (migracja DB, płatności, granica zaufania). SCOPE: FULLSTACK.

## Przepływ

1. `/preselekcja` → przycisk **Kup teraz** (obok „Poproś o fakturę proforma”, która zostaje bez zmian).
2. `/checkout?produkt=preselekcja` — podsumowanie (nazwa, ilość, cena brutto, suma), dane kupującego
   (imię i nazwisko, e-mail, telefon; opcjonalnie firma i NIP), obowiązkowa akceptacja regulaminu
   i polityki prywatności, logo Przelewy24 i metody (BLIK, szybki przelew, karta) bez dodatkowych opłat.
3. `POST /api/p24/register` (tylko z własnego origin): walidacja, **cena z katalogu serwera**
   (`lib/checkout-catalog.ts`), zapis `public.orders` (status `pending`), rejestracja transakcji
   `POST /api/v1/transaction/register` z podpisem SHA-384, odpowiedź z adresem bramki → przeglądarka
   przechodzi do Przelewy24.
4. `POST /api/p24/notify` (urlStatus): ścisła walidacja pól, weryfikacja podpisu SHA-384 i merchant/POS,
   zgodność kwoty i sesji z naszym zamówieniem, `PUT /api/v1/transaction/verify`, dopiero wtedy `paid`.
   Odpowiedź 200 dopiero po zapisie w bazie; każdy błąd → kod ≠ 2xx (Przelewy24 ponawia).
5. `/checkout/return?order=<uuid>` — pokazuje status z bazy. Powrót z bramki nie jest dowodem płatności;
   gdy zamówienie jest `pending`, strona sprawdza transakcję uwierzytelnionym odczytem
   `GET /transaction/by/sessionId` (i ewentualnie wykonuje `verify`), co działa także wtedy,
   gdy powiadomienie nie dotarło (np. ochrona deploymentu Preview).

## Baza danych

Migracja `supabase/migrations/20261031120000_checkout_orders.sql` (rollback w `supabase/rollbacks/`).

- `public.orders`: `id, created_at, updated_at, status (pending/paid/failed/cancelled), product_code, quantity,
  amount_gross (grosze), currency (PLN), customer_name, customer_email, customer_phone, company_name, nip,
  terms_accepted_at, p24_session_id, p24_order_id, paid_at`.
- RLS włączone, **brak uprawnień** dla `anon`/`authenticated`/`service_role` do tabeli.
- Dostęp wyłącznie przez 3 funkcje `SECURITY DEFINER` (`checkout_create_order`, `checkout_update_order`,
  `checkout_read_order`) z podpisem HMAC-SHA256 serwera (sekret `CHECKOUT_ORDER_SECRET`), ważnym 5 minut.
  Bez zainstalowanego sekretu wszystko jest odrzucane. `paid` jest stanem końcowym; `paid` wymaga zgodnej kwoty.
- Bez `service_role` w kodzie aplikacji — serwer używa klucza publikowalnego.

## Zmienne środowiskowe (Vercel, tylko serwer — nigdy w kodzie ani z prefiksem `NEXT_PUBLIC_`)

| Zmienna | Opis |
|---|---|
| `P24_MERCHANT_ID` | ID sprzedawcy Przelewy24 |
| `P24_POS_ID` | ID punktu sprzedaży (zwykle = merchant ID) |
| `P24_CRC` | klucz CRC (do podpisów SHA-384) |
| `P24_API_KEY` | klucz do raportów / API (Basic auth REST) |
| `P24_SANDBOX` | `true` = sandbox.przelewy24.pl, `false` = produkcja; inna wartość wyłącza płatności |
| `CHECKOUT_ORDER_SECRET` | losowy sekret ≥ 32 znaki; ta sama wartość w bazie (poniżej) |

Brak którejkolwiek zmiennej → `/api/p24/register` zwraca 503, a formularz pokazuje komunikat
o proformie (ścieżka zakupu pozostaje widoczna).

Instalacja sekretu w bazie danego środowiska (SQL editor, nie z aplikacji):

```sql
select private.set_checkout_request_secret('<ta sama wartość co CHECKOUT_ORDER_SECRET>');
```

## Test end-to-end w sandboxie (Preview, projekt `skillcheck-preview`)

1. Zastosuj migrację na `skillcheck-preview` i zainstaluj sekret (jak wyżej).
2. W Vercel → Preview (gałąź `integration`) ustaw zmienne z tabeli, `P24_SANDBOX=true`, dane z panelu
   sandbox Przelewy24.
3. W panelu sandbox Przelewy24 dopisz adres Preview do dozwolonych adresów powrotu/statusu, jeśli panel tego wymaga.
4. Otwórz `/preselekcja` → **Kup teraz** → ilość 2 → suma 600,00 zł → wypełnij dane → zaznacz akceptację → **Zamawiam i płacę**.
5. Na stronie sandbox wybierz metodę (np. BLIK testowy lub „przelew testowy”) i zatwierdź płatność.
6. Po powrocie `/checkout/return?order=…` powinno pokazać „Płatność przyjęta”. Jeśli najpierw pokazuje
   „Czekamy na potwierdzenie”, kliknij **Odśwież status**.
7. Kontrola w bazie: `select status, amount_gross, p24_order_id, paid_at from public.orders order by created_at desc limit 1;`
   → `paid`, `60000`, numer Przelewy24, data.
8. Negatywnie: anuluj płatność w bramce → status pozostaje `pending`; ręczny `POST /api/p24/notify` z błędnym
   podpisem → 400, zamówienie bez zmian.

Uwaga: ochrona deploymentu Vercel na Preview może blokować `urlStatus` (POST od Przelewy24). Strona powrotu
i tak potwierdzi płatność odczytem z API. Zmiana ochrony/bypassu należy wyłącznie do właściciela.

## Testy automatyczne

- `npm run test:p24-checkout` — prawdziwa migracja na PGlite + symulowany sandbox Przelewy24:
  pełny przepływ, sfałszowane/obce/zmienione powiadomienia, brak dostępu do tabeli, HMAC, stan końcowy `paid`.
- `npm run test:marketing` — przycisk „Kup teraz”, zachowana proforma, `/checkout`, `/kontakt`, linki w stopce, 503 bez kluczy.
- `npm run test:db` — kontrakt Data API po pełnym odtworzeniu migracji (tabela `orders` tylko przez RPC).

## Poza zakresem / do decyzji właściciela

- Produkcyjne klucze Przelewy24 i `P24_SANDBOX=false` — decyzja właściciela (nowe koszty/płatności).
- Migracja produkcyjna — tylko przez proces produkcyjny z AGENTS.md.
- Automatyczne przyznanie analiz po płatności i wystawienie faktury VAT nie są podłączone; operator robi to
  ręcznie na podstawie zamówień `paid` (jak przy proformie).
