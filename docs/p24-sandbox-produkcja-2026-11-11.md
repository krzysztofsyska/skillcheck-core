# Przelewy24 Sandbox na skillcheck.pl — co zrobił agent, co musi zrobić właściciel

Decyzja właściciela (głosowo, 11.11.2026): weryfikator Przelewy24 musi móc przejść
ścieżkę zakupu na **https://skillcheck.pl** aż do strony płatności Przelewy24 i
zapłacić testowymi pieniędzmi (szybki przelew albo BLIK w Sandboxie). Wyłączony
przycisk „wkrótce” jest dla weryfikatora nie do przyjęcia.

To jest **tylko tryb testowy**. Włączenie prawdziwych płatności Przelewy24 to
osobna zmiana i osobna decyzja — nie ma jej w tym kodzie i nie da się jej włączyć
samym ustawieniem zmiennej.

## Co już jest zrobione w kodzie

1. Migracja `supabase/migrations/20261111140000_sc19_p24_checkout_role.sql` tworzy
   na bazie osobne, maksymalnie ograniczone konto `sc19_p24_checkout` dla modułu
   płatności. Konto powstaje **bez hasła i bez prawa logowania** — samo wgranie
   migracji nikomu nic nie otwiera. Hasło ustawia właściciel (punkt 2 poniżej).
2. Moduł płatności uruchamia się na produkcji tylko wtedy, gdy wszystko się zgadza:
   adres `https://skillcheck.pl`, produkcyjny projekt bazy, `P24_SANDBOX=true`,
   gałąź `main` i to jedno konto bazy. Brak któregokolwiek warunku = płatności
   wyłączone (przycisk nieaktywny, jak dziś).
3. Na ekranie zamówienia jest wyraźna informacja, że płatność idzie w Sandboxie
   Przelewy24: pieniądze nie zostaną pobrane, ale analizy CV **zostaną przyznane**
   na tym koncie tak samo jak po zwykłym zakupie.

## Co musi zrobić właściciel (po przeglądzie i po połączeniu zmian do `main`)

### Krok 1 — wgranie migracji na produkcyjną bazę

Migracja idzie przez zatwierdzany przez Ciebie proces wdrożenia bazy, razem z
resztą zmian. Agent nie dotyka produkcyjnej bazy.

### Krok 2 — hasło dla nowego konta bazy

W Supabase Studio produkcyjnego projektu (`wsvjawuikxfzjyivxgsu`):
<https://supabase.com/dashboard/project/wsvjawuikxfzjyivxgsu/sql/new>

1. Wygeneruj długie, losowe hasło (co najmniej 32 znaki, bez znaków `@ : / ? #`,
   żeby nie trzeba było go kodować w adresie połączenia).
2. Wklej i uruchom (podstawiając swoje hasło w miejsce `TUTAJ_HASLO`):

   ```sql
   alter role sc19_p24_checkout with login password 'TUTAJ_HASLO';
   ```

3. Zamknij kartę i nie zapisuj tego zapytania. Hasło trzymaj tylko w Vercel
   (krok 3) i w swoim menedżerze haseł. Nigdy nie wklejaj go w czacie, w zgłoszeniu
   ani do pliku w repozytorium.

### Krok 3 — zmienne w Vercel, środowisko **Production**

<https://vercel.com/dashboard> → projekt **skillcheck-core** → *Settings* →
*Environment Variables* → *Add New*, dla każdej pozycji zaznacz **tylko
Production**:

| Nazwa | Skąd wziąć wartość |
| --- | --- |
| `P24_SANDBOX` | wpisz `true` |
| `P24_MERCHANT_ID` | ta sama wartość co w zmiennej `P24_MERCHANT_ID` dla Preview (gałąź `integration`); to Twoje ID sprzedawcy z panelu Sandbox Przelewy24 |
| `P24_POS_ID` | ta sama wartość co w zmiennej `P24_POS_ID` dla Preview |
| `P24_CRC` | ta sama wartość co w zmiennej `P24_CRC` dla Preview (klucz CRC z panelu Sandbox) |
| `P24_API_KEY` | ta sama wartość co w zmiennej `P24_API_KEY` dla Preview (klucz do raportów / API Sandbox) |
| `SC19_P24_CHECKOUT_DATABASE_URL` | nowy adres połączenia, zbudowany jak poniżej |

`SC19_P24_CHECKOUT_DATABASE_URL` ma mieć dokładnie taki kształt (to ten sam
wzór co istniejąca zmienna `SC19_P24_PREVIEW_DATABASE_URL` dla Preview, tylko z
nowym kontem i produkcyjnym projektem):

```
postgresql://sc19_p24_checkout.wsvjawuikxfzjyivxgsu:TUTAJ_HASLO@aws-<numer>-eu-west-1.pooler.supabase.com:6543/postgres
```

* `TUTAJ_HASLO` — hasło z kroku 2.
* `aws-<numer>-eu-west-1.pooler.supabase.com` i port `6543` — przepisz dokładnie z
  Supabase Studio: *Project Settings* → *Database* → *Connection pooling* →
  **Transaction pooler**
  (<https://supabase.com/dashboard/project/wsvjawuikxfzjyivxgsu/settings/database>).
  Nie dopisuj nic po `/postgres` (żadnego `?sslmode=...`) — aplikacja odrzuci taki
  adres.

Po dodaniu wszystkich sześciu zmiennych zrób nowe wdrożenie produkcyjne (*Deployments*
→ najnowsze wdrożenie → *Redeploy*), bo zmienne wczytują się przy budowaniu.

### Krok 4 — pakiet musi być widoczny

Żeby było co kupić, na produkcji muszą być (to już Twoje wcześniejsze kroki z
`/operator/billing`): limit analiz dla PRESELEKCJA = 60 i opublikowana oferta
PRESELEKCJA. Bez tego ekran zamówienia powie „Brak zatwierdzonej oferty”.

### Krok 5 — co powiedzieć weryfikatorowi

Ścieżka do strony płatności działa **tylko pod adresem `https://skillcheck.pl`**
(nie pod `www.`, które przekierowuje, i nie pod adresem `*.vercel.app`). Firma
weryfikatora musi być w panelu potwierdzona, tak jak każda inna.

## Ile razy można kupować i co się dzieje, gdy płatność zostanie porzucona

**Liczba zakupów nie jest ograniczona.** Nie ma żadnego limitu „jeden zakup
testowy”, żadnego licznika na firmę i żadnej flagi do przełączania między
próbami. Każda potwierdzona płatność dopisuje kolejne 60 analiz: analizy
przyznajemy raz na płatność (klucz płatności z Przelewy24), a każde nowe
zamówienie to nowa płatność. Po zapłaceniu można od razu kliknąć „Kup kolejny
pakiet” i zacząć następny zakup.

**Jedno otwarte zamówienie na firmę.** Dopóki zamówienie nie jest zapłacone,
firma ma jedno otwarte zamówienie — to zabezpieczenie przed podwójnym
obciążeniem i nie zmieniamy go. W praktyce:

* Otworzysz stronę Przelewy24 i zamkniesz ją bez płacenia, a potem klikniesz
  „Zamawiam i płacę” jeszcze raz → dostajesz **ten sam link do płatności** i
  możesz zapłacić. Nic nie trzeba czekać ani odblokowywać.
* To samo dzieje się w nowej karcie, na innym urządzeniu i po wyczyszczeniu
  pamięci przeglądarki — zamówienie jest zapisane na serwerze.
* Link do płatności **nie wygasa po 30 minutach** — transakcję rejestrujemy w
  Przelewy24 bez limitu czasu. Do tego samego linku można wrócić później i
  zapłacić; potwierdzenie płatności przyjmujemy bez względu na to, kiedy dotrze.
* Jeżeli strona płatności **w ogóle się nie otworzyła** (na przykład Przelewy24
  odrzuciło rejestrację), kolejne kliknięcie „Zamawiam i płacę” samo otwiera to
  samo zamówienie na nowo — pod warunkiem, że ta sama oferta (ta sama cena,
  liczba analiz i warunki) jest nadal w sprzedaży. Najpierw sprawdzamy w
  Przelewy24, że dla tego zamówienia na pewno nie ma zarejestrowanej transakcji; gdy nie da się
  tego potwierdzić, nic nie rejestrujemy.
* Gdy płatność się nie udaje, komunikat na ekranie podaje dodatkowy kod
  Przelewy24 (np. `SC19_PAYMENT_RETRY / P24_UNAUTHORIZED` — złe dane dostępowe
  do Przelewy24 w tym środowisku, `P24_SIGN_REJECTED` — zły klucz CRC). Ten sam
  kod, bez żadnych danych prywatnych, trafia do logów Vercel jako
  `SC19_P24_FAILURE`.

**Kiedy zostaje tylko odblokowanie ręczne:** niezapłacone zamówienie, którego
oferty już nie ma w sprzedaży albo która się zmieniła (inna cena, liczba analiz
lub wersja warunków). Wtedy ekran mówi, że ponawianie nie pomoże.

**Awaryjne odblokowanie (zapis do produkcyjnej bazy — robi to tylko
właściciel).** W Supabase Studio produkcyjnego projektu
(<https://supabase.com/dashboard/project/wsvjawuikxfzjyivxgsu/sql/new>),
podstawiając identyfikator zablokowanego zamówienia:

```sql
-- 1. Sprawdź, co blokuje (powinno być dokładnie jedno zamówienie, niezapłacone):
select id, created_at, status from private.sc19_payment_orders
 where company_id = '<ID FIRMY>' and status = 'awaiting_payment';

-- 2. Usuń je razem z aliasami prób. Wyzwalacze celowo zabraniają usuwania
--    zamówień, więc na czas tej jednej operacji trzeba je wyłączyć.
begin;
alter table private.sc19_payment_orders disable trigger sc19_order_immutable;
alter table private.sc19_payment_requests disable trigger sc19_request_immutable;
delete from private.sc19_payment_requests where order_id = '<ID ZAMÓWIENIA>';
delete from private.sc19_payment_orders
 where id = '<ID ZAMÓWIENIA>' and status = 'awaiting_payment';
alter table private.sc19_payment_requests enable trigger sc19_request_immutable;
alter table private.sc19_payment_orders enable trigger sc19_order_immutable;
commit;
```

Nigdy nie usuwaj w ten sposób zamówienia ze statusem `paid` ani zamówienia, za
które płatność mogła zostać wykonana — najpierw kliknij „Sprawdź status
zamówienia” na ekranie zakupu; jeśli płatność doszła, analizy zostaną przyznane i
zamówienie samo się zamknie.

Docelowe rozwiązanie (bez wchodzenia do bazy) to przycisk „Anuluj zamówienie i
zacznij od nowa” na ekranie zakupu, odmawiany w chwili, gdy dla zamówienia
istnieje jakakolwiek płatność. Wymaga osobnej, oddzielnie recenzowanej zmiany
schematu bazy (nowy status zamówienia i nowa wersja inwentarza SC-010) i jest
opisany w raporcie do tej zmiany.

## Czy powiadomienie o płatności dotrze

Tak. Przelewy24 wysyła potwierdzenie na `https://skillcheck.pl/api/billing/webhook`.
Ten adres jest publiczny (ochrona logowaniem Vercel obejmuje tylko adresy
`*.vercel.app`, nie domenę skillcheck.pl) i nie wymaga zalogowania — potwierdzenie
jest sprawdzane podpisem Przelewy24. Dodatkowo przycisk „Sprawdź status
zamówienia” na ekranie zakupu sam dopytuje Przelewy24 o płatność, więc nawet gdyby
powiadomienie nie dotarło, analizy zostaną przyznane po jego kliknięciu.

## Czego ta zmiana nie robi

* Nie włącza prawdziwych płatności ani nie przygotowuje ich „na potem”.
* Nie dotyka faktur (Fakturownia zostaje zamrożona).
* Nie zmienia ceny ani zawartości pakietu.
* Nie zabezpiecza przed tym, że testowa płatność przyzna prawdziwe analizy na
  produkcyjnym koncie — to celowe, bo o to chodzi w przejściu weryfikatora. Ekran
  mówi o tym wprost.

## Jak to wyłączyć

Usuń z Vercel Production `P24_SANDBOX` i `SC19_P24_CHECKOUT_DATABASE_URL` i zrób
nowe wdrożenie — przycisk płatności znów będzie nieaktywny. Skrypt
`supabase/rollbacks/20261111140000_sc19_p24_checkout_role_down.sql` usuwa samo
konto bazy; uruchamia się go **po** usunięciu zmiennych.
