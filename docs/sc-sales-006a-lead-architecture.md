# SC-SALES-006A — projekt formularza kontaktowego i bezpiecznej obsługi zgłoszeń

- TASK: SC-SALES-006A
- STATUS: REVIEW
- LEVEL: L3
- OWNER: Codex
- REVIEWER: Codex
- BASE: `dbef6a8462f2e46587d061c321586136e0e68fbe` (`origin/main` w momencie projektu)
- DB / MIGRATIONS: brak zmian wykonanych w tym zadaniu

To nie jest backendowe SC-006. SC-006 w `docs/BACKLOG.md` nadal oznacza UI uruchomienia analizy AI i pozostaje BACKLOG. To zadanie nie zmienia jego zakresu.

Poprawka po review PR #32 zastępuje wcześniejszy kontrakt, w którym RPC przyjmowało dowolny `fingerprint_hash`, odmowa biznesowa była wyjątkiem wycofującym dziennik prób, a trigger niezmienności blokował usunięcie konta.

## 1. Cel

Firma odwiedzająca publiczną stronę może zostawić kontakt w sprawie rozmowy o rekrutacji, bez zakładania konta. Właściciel SkillCheck odczytuje zgłoszenie tylko jako uprawniony operator platformy. Wysłanie formularza nie rezerwuje terminu i nie obiecuje czasu odpowiedzi.

## 2. Co już jest i co wolno użyć ponownie

Sprawdzone w kodzie na bazie `dbef6a8`:

- Role firmy to wyłącznie `companies.owner_id` oraz `company_members.role` o wartościach `recruiter` albo `viewer`. Nie ma roli operatora platformy.
- Każda tabela operacyjna ma `company_id`. RLS i `private.has_company_access` izolują tenantów. Tego modelu nie rozszerzamy na zgłoszenie.
- Zapis krytyczny idzie przez funkcje `SECURITY DEFINER` z `search_path = ''`. Wzorzec `revoke all` i grant `execute` jest w `public.create_company`.
- Aplikacja używa `lib/supabase/server.ts` i klucza publicznego. `service_role` jest zakazany w runtime.
- Walidacja e-maila logowania jest w `lib/auth-validation.ts`: trim, długość do 254, wzorzec `^[^\s@]+@[^\s@]+\.[^\s@]+$`, bez MX.
- `lib/screening-hmac.ts` pokazuje HMAC-SHA256 z Node `crypto`, hex i próg 32 bajtów. To wzorzec kodowania, nie ten sam sekret i nie ta sama treść podpisu. Sekret workera analizy nie może podpisywać zgłoszeń.
- `proxy.ts` odświeża sesję tylko dla `/login`, `/register`, `/forgot-password`, `/reset-password`, `/onboarding` i `/dashboard/:path*`.
- Publiczna oferta jest w `app/components/marketing/`.
- Testy bazy używają PGlite oraz ról `anon` i `authenticated`. Kontrakt jest w `tests/database-types.test.mjs` i `tests/database-types.contract.ts`.
- Ostatnia wykonana migracja to `20261005000100_screening_worker_claim_payload.sql`. Starszych plików nie wolno edytować ani uruchamiać ponownie.
- Istniejące testy PGlite stosują jedną sesję. `docs/exercise-definitions.md` już oddziela taki test od wyścigu dwóch połączeń. Ten projekt zachowuje to rozróżnienie.

Nie używać tabel `candidates`, `companies` ani `company_members` jako miejsca na zgłoszenie. Nie wywoływać `create_company` ani `ensure_initial_company` z formularza.

## 3. Podział implementacji

| Etap | Zakres | Zależność |
|---|---|---|
| SC-SALES-006B | Migracja, RLS, RPC, typy, testy PGlite i skrypt współbieżności | ten dokument zatwierdzony i na `main` |
| SC-SALES-006C | Strona `/rozmowa`, przyciski, server action, test HTTP | 006B DONE |
| SC-SALES-006D | Widok `/operator/leads` | 006C DONE |
| SC-SALES-013 | Etapy, notatki, przypomnienia, ręczne powiązanie z firmą | 006D DONE |

006B nie startuje przed scaleniem 006A. Potem kolejność jest liniowa, bo 006C i 006D dopisują skrypty do `package.json` i CI. Publiczne włączenie wymaga obu widoków oraz testu współbieżności z sekcji 12.

Pierwszy prompt wykonawczy, do użycia dopiero po scaleniu, jest w `docs/sc-sales-006b-cursor-prompt.md`.

## 4. Ścieżka odwiedzającego

1. Widzi odnośnik „Porozmawiajmy o Twojej rekrutacji”.
2. Otwiera `/rozmowa` bez konta.
3. Podaje imię, nazwę firmy, e-mail i krótki opis potrzeb. Telefon może zostać pusty.
4. Wysyła formularz.
5. Napis „Zgłoszenie zostało zapisane. To nie jest rezerwacja terminu rozmowy.” pojawia się tylko wtedy, gdy RPC zwróci niepuste `lead_id` oraz `result_code` równy `accepted` albo `replay`.

Nie dodawać kalendarza, uploadu CV, załączników, płatności ani wysyłki wiadomości.

### Gdzie dodać odnośnik w 006C

- Sekcja otwierająca i zamykająca `app/components/marketing/home-page.tsx`.
- Sekcja zamykająca `app/components/marketing/demo-page.tsx`.
- Stopka przez `footerLinks` w `app/components/marketing/links.ts`.
- Nawigacja desktop i menu telefonu, jako odnośnik tekstowy za „Zaloguj się”. Przycisk „Zobacz przykład” zostaje przyciskiem głównym.

Adres formularza: `/rozmowa`.

## 5. A. Formularz i walidacja

Przeglądarka wysyła tylko pola formularza i `idempotency_key`. Nie wysyła adresu IP, czasu wystawienia ani podpisu. Te trzy wartości dopisuje server action.

| Pole | Wymagane | Po normalizacji | Zasada |
|---|---|---|---|
| `first_name` | tak | 1–80 znaków | trim, wielokrotne białe znaki do jednej spacji |
| `company_name` | tak | 1–160 znaków | tak samo |
| `email` | tak | 3–254 znaków | trim, małe litery, wzorzec `^[^\s@]+@[^\s@]+\.[^\s@]+$` |
| `phone` | nie | `null` albo 5–32 znaki | pusty tekst staje się `null`; wzorzec `^[0-9+().\-\s]{5,32}$` |
| `needs` | tak | 10–1000 znaków | trim, końce linii do `\n` |
| `idempotency_key` | tak | UUID | generuje przeglądarka, nie użytkownik |

Odrzucić znaki sterujące i DEL (`U+007F`). W `needs` wolno zostawić tabulator i `\n`. W pozostałych polach nie. Nie sprawdzać MX. Nie poprawiać telefonu do formatu międzynarodowego.

Normalizacja jest w `lib/sales-lead-signature.ts` i jeszcze raz w `submit_sales_lead`, tym samym algorytmem. Baza jest źródłem prawdy dla zapisu. Action nie podpisuje danych, które lokalnie łamią limity. Bezpośrednie RPC i tak nie zapisze danych bez ważnego podpisu.

### Stany interfejsu

- gotowy — pola edytowalne, przycisk „Wyślij zgłoszenie”;
- wysyłanie — `aria-busy`, wartości zostają, drugi klik nie tworzy nowego klucza;
- sukces — wyłącznie po `lead_id` i kodzie `accepted` albo `replay`; formularz znika;
- błąd — wartości zostają, komunikat w `role="alert"`;
- ponowienie — ten sam klucz, dopóki treść po normalizacji jest taka sama.

Wyłączony przycisk nie jest zabezpieczeniem. Odmowa, pusty wynik i wyjątek nie są sukcesem, także gdy w odpowiedzi pojawiłby się identyfikator przy innym kodzie. Funkcja nie może zwrócić `lead_id` razem z kodem odmowy.

### Klawiatura i telefon

Etykiety powiązane z polami. `autoComplete`: `given-name`, `organization`, `email`, `tel`. Przycisk ma co najmniej 44 px wysokości. Formularz działa tabulatorem i Enterem. Walidacja przeglądarki nie zastępuje serwera ani bazy.

### Komunikaty

- błąd pola: krótko o tym polu;
- `sales_lead_invalid`, `sales_lead_unauthorized` i wyjątek techniczny: „Nie udało się zapisać zgłoszenia. Dane zostały w formularzu. Możesz spróbować ponownie.”;
- `sales_lead_rate_limited`: „Nie udało się teraz przyjąć zgłoszenia. Spróbuj później.”;
- `sales_lead_unavailable`: „Formularz nie przyjmuje teraz zgłoszeń.”;
- `sales_lead_idempotency_conflict`: „To zgłoszenie różni się od poprzedniej próby. Wyślij je ponownie.” Po tym błędzie przeglądarka tworzy nowy klucz.

Nie pokazywać, który warunek podpisu zawiódł. Nie pokazywać SQL, IP ani identyfikatora cudzego wiersza.

### Informacja o danych

Nie ma zatwierdzonej treści o przetwarzaniu danych ani zatwierdzonego okresu przechowywania treści zgłoszenia. 006C nie wymyśla klauzuli. Pusta `SALES_LEAD_NOTICE` nie jest uzupełniana przez implementację. Publiczne ustawienie `leads_enabled = true` pozostaje zablokowane do decyzji właściciela.

## 6. B. Model danych

Jedyna nowa migracja 006B: `supabase/migrations/20261007000200_sales_leads.sql`. Jeśli ten numer jest zajęty, zatrzymać się.

Migracja nie polega na błędzie `CREATE EXTENSION IF NOT EXISTS`. To polecenie milczy, gdy rozszerzenie o tej nazwie już jest, także wtedy, gdy leży w innym schemacie. Na początku migracja robi jednoznaczny sprawdzian i przerywa się czytelnym wyjątkiem, zanim utworzy tabele:

1. Odczytać `pg_extension.extname = 'pgcrypto'` oraz schemat z `pg_namespace`.
2. Brak wiersza: `create schema if not exists extensions`, potem zwykłe `create extension pgcrypto with schema extensions`. Bez `IF NOT EXISTS`.
3. Wiersz jest, a schematem nie jest `extensions`: wyjątek `sales_lead_pgcrypto_schema`. Nie przenosić, nie kasować i nie tworzyć drugiej kopii.
4. Wiersz jest w `extensions`: nie tworzyć rozszerzenia ponownie.
5. Potem wymagać przeciążenia `extensions.hmac(text, text, text)`. Predykat: `pg_proc` w schemacie `extensions`, `proname = 'hmac'`, `pg_get_function_identity_arguments(oid) = 'text, text, text'`. Brak tego wiersza: wyjątek `sales_lead_pgcrypto_hmac`. Nie dodawać własnego HMAC i nie odtwarzać rozszerzenia.

Funkcje wołają `extensions.hmac` przy `search_path = ''`.

### `public.sales_leads`

| Kolumna | Typ | Znaczenie |
|---|---|---|
| `id` | `uuid` PK, `gen_random_uuid()` | nadawany w bazie |
| `idempotency_key` | `uuid not null unique` | klucz ponowienia |
| `first_name` | `text not null` | imię po normalizacji |
| `company_name` | `text not null` | nazwa firmy wpisana przez osobę |
| `email` | `text not null` | e-mail po normalizacji |
| `phone` | `text null` | telefon albo brak |
| `needs` | `text not null` | opis potrzeb |
| `status` | `text not null default 'received'` | check: wyłącznie `received` |
| `submitted_by` | `uuid null` | `auth.uid()` w chwili INSERT; bez klucza obcego |
| `fingerprint_hash` | `text not null` | 64 znaki hex; HMAC adresu IP, bez samego adresu |
| `created_at` | `timestamptz not null default now()` | czas pierwszego zapisu |

Brak `company_id` i `updated_at`. Długości z sekcji 5 są checkami. Check nie zastępuje walidacji formatu w funkcji.

`submitted_by` celowo nie ma `REFERENCES auth.users`. `ON DELETE SET NULL` jest UPDATE-em wiersza. Trigger odrzucający każdy UPDATE zablokowałby usunięcie konta. `ON DELETE CASCADE` usuwałoby zgłoszenie. `ON DELETE RESTRICT` blokowałoby usunięcie konta. Zamiast klucza obcego usunięcie konta obsługuje trigger z sekcji 8.

Indeksy: unikalny `idempotency_key`, `(email, created_at)`, `(fingerprint_hash, created_at)`, `(created_at)`.

### `private.sales_lead_replay_state`

Jeden wiersz na zgłoszenie, nie na każde ponowienie.

| Kolumna | Typ |
|---|---|
| `lead_id` | `uuid` PK → `public.sales_leads(id)` |
| `replay_count` | `integer not null`, check od 1 do 20 |
| `last_replay_at` | `timestamptz not null default now()` |

### `public.platform_operators`

| Kolumna | Typ | Znaczenie |
|---|---|---|
| `user_id` | `uuid` PK → `auth.users(id) on delete cascade` | konto operatora |
| `granted_at` | `timestamptz not null default now()` | pierwsze nadanie |
| `granted_by` | `uuid null` → `auth.users(id) on delete set null` | kto nadał; `null` dla pierwszego SQL |
| `revoked_at` | `timestamptz null` | `null` oznacza uprawnienie aktywne |

Check: `revoked_at` jest puste albo nie wcześniejsze niż `granted_at`. Migracja nie wstawia `user_id`. Aktywny operator to `revoked_at is null`. Właściciel firmy-klienta nie staje się operatorem.

Usunięcie konta operatora kasuje jego wiersz przez `ON DELETE CASCADE`. To nie jest RPC. Może zostawić zero operatorów i wtedy ponowne wejście wymaga ręcznego SQL z sekcji 8. RPC nie ma tej ścieżki.

### `private.sales_lead_settings`

Jeden wiersz, klucz `id boolean primary key default true check (id)`.

| Kolumna | Znaczenie |
|---|---|
| `leads_enabled boolean not null default false` | wyłącznik zapisu nowych zgłoszeń w bazie |
| `request_secret_current text null` | aktualny sekret MAC; `null` albo co najmniej 32 bajty |
| `request_secret_previous text null` | poprzedni sekret do historii odcisków; ta sama zasada długości |
| `request_secret_rotated_at timestamptz null` | moment ostatniej zmiany z niepustego sekretu na nowy; `null`, dopóki nie było rotacji |

Migracja wstawia `leads_enabled = false`, oba sekrety jako `null` i `request_secret_rotated_at` jako `null`. Nie zawiera wartości sekretu.

Trigger `BEFORE UPDATE` na tej tabeli pilnuje historii odcisków. Nie skraca okien limitów.

- Wyzerowanie `request_secret_previous`, gdy stary sekret jeszcze stoi, przechodzi tylko wtedy, gdy `request_secret_rotated_at` nie jest puste i `clock_timestamp()` jest nie wcześniej niż ten znacznik plus 60 minut. Wcześniejsza próba kończy się `sales_lead_secret_history_open` i nic nie zmienia. Dotyczy to także ręcznego `UPDATE`.
- Zamiana jednego niepustego `request_secret_previous` na inny niepusty ciąg kończy się `sales_lead_secret_rotation_busy`. Nie ma trzeciego sekretu.
- Zmiana `request_secret_rotated_at`, gdy poprzedni sekret jest niepusty, jest dozwolona tylko w tym samym `UPDATE`, który ustawia poprzedni sekret z `null` na nową wartość. Cofnięcie znacznika, żeby skrócić te 60 minut, nie przechodzi.

### `private.sales_lead_attempts`

| Kolumna | Typ |
|---|---|
| `id` | `bigint identity` PK |
| `fingerprint_hash` | `text not null` |
| `attempted_at` | `timestamptz not null default now()` |
| `result` | `text not null`: tylko `accepted`, `rejected`, `rate_limited` |

Brak imienia, telefonu, e-maila, nazwy firmy, treści, adresu IP i klucza ponowienia. Indeksy: `(fingerprint_hash, attempted_at)` oraz `(attempted_at)`.

Schemat `private` nie jest wystawiony w API. `anon` nie dostaje `USAGE` na `private`. Istniejące `USAGE` dla `authenticated` zostaje, bo używa go reszta aplikacji. Nowe obiekty `private` nie dostają grantów dla `anon` ani `authenticated`.

### Niezmienność i jedyne dozwolone zmiany

Trigger `BEFORE UPDATE OR DELETE` na `public.sales_leads` woła `private.sales_leads_immutable()`.

- `DELETE` kończy się `sales_lead_immutable`, chyba że w tej transakcji ustawiono lokalnie `skillcheck.sales_lead_test_purge = 'on'`. Ustawia to wyłącznie `private.purge_sales_leads(uuid[])`.
- `UPDATE` kończy się `sales_lead_immutable`, chyba że lokalnie ustawiono `skillcheck.sales_lead_author_detach = 'on'` i jedyną zmianą jest `submitted_by` z niepustego UUID na `null`. Pozostałe kolumny muszą być równe. Ustawia to wyłącznie `private.detach_sales_lead_author(uuid)`.
- API nie dostaje `UPDATE` ani `DELETE`. GUC bez grantu tabeli nic nie daje roli `anon` ani `authenticated`.
- Nie wyłączać triggera jako sposobu sprzątania ani usuwania konta.

### Powtórzone wysłanie

Idempotencja porównuje wyłącznie pięć znormalizowanych pól: `first_name`, `company_name`, `email`, `phone` (`null` i pusty tekst są tym samym) oraz `needs`. Nie porównuje `submitted_by`, `fingerprint_hash`, `status`, `created_at` ani `id`. Ponowienie nie wykonuje `UPDATE` na `sales_leads`, więc nie nadpisuje pierwotnego `submitted_by`.

- Brak wiersza i `leads_enabled = true`: po limitach `INSERT`, wynik `accepted` i nowe `lead_id`.
- Brak wiersza i `leads_enabled = false`: `sales_lead_unavailable`, bez zgłoszenia i bez wiersza w dzienniku prób. Tak samo, gdy podpis jest ważny, a pola są błędne.
- Jest wiersz i pięć pól jest równych: `replay` oraz istniejące `lead_id`, także przy wyłączonej fladze i zanim funkcja oceni nowe pola. Nie dodaje zgłoszenia i nie zużywa limitu przyjęć. Agregacja ponowień jest w sekcji 9.
- Jest wiersz, pola się różnią i flaga jest wyłączona: `sales_lead_unavailable`, bez próby i bez zmiany wiersza. Przy włączonej fladze: `sales_lead_idempotency_conflict`, wiersz bez zmian, `lead_id` puste.

Nowy klucz przy tym samym e-mailu może utworzyć kolejne zgłoszenie, aż do limitu. Domeny e-maila nie wolno porównywać z firmami.

## 7. C. Granica zaufania

```text
przeglądarka
  → server action (pola i idempotency_key)
    → action dopisuje source_ip, issued_at_us i request_signature
      → public.submit_sales_lead jako anon albo authenticated
        → funkcja odrzuca podpis albo wykonuje INSERT jako SECURITY DEFINER
```

Klucz publiczny Supabase pozwala wywołać RPC bezpośrednio. Dlatego sam HMAC w aplikacji nie jest kontrolą. Kontroli jest weryfikacja tego samego MAC wewnątrz funkcji, sekretem którego rola API nie umie odczytać.

### Podpis

Sekret ma co najmniej 32 bajty UTF-8. Aplikacja trzyma go w `SALES_LEAD_REQUEST_SECRET`. Baza trzyma ten sam ciąg w `request_secret_current`. Brak którejkolwiek kopii blokuje nowe przyjęcie. Wartości nie wolno wkładać do repozytorium ani migracji.

Czas `issued_at_us` to liczba mikrosekund Unix UTC wyliczona przez action (`Date.now() * 1000`). Nie pochodzi z przeglądarki. Ważność w bazie, względem `clock_timestamp()`:

- nie starszy niż 120 sekund;
- nie nowszy niż 30 sekund.

Po upływie action przy następnym wysłaniu wystawia nowy czas i nowy podpis. Ten sam klucz i ta sama treść pozostają ponowieniem. Stary podpis nie przedłuża się sam.

Kanoniczny tekst UTF-8, bez ogona po ostatnim polu:

```text
v1
<issued_at_us>
<idempotency_key jako małe litery>
<auth.uid() jako małe litery albo znak ->
<source_ip>
<bajty UTF-8>:<first_name>
<bajty UTF-8>:<company_name>
<bajty UTF-8>:<email>
<bajty UTF-8>:<phone albo pusty ciąg>
<bajty UTF-8>:<needs>
```

Każda z pierwszych dziewięciu linii kończy się `\n`. Ostatnie pole nie ma końcowego `\n`. Długość pola jest dziesiętną liczbą bajtów UTF-8, więc znak nowej linii wewnątrz `needs` nie przesuwa granicy pola. User-Agent nie wchodzi do tekstu.

MAC to HMAC-SHA256. Kluczem jest sekret jako UTF-8, wiadomością kanoniczny tekst jako UTF-8, wynikiem 64 małe znaki hex. W Node jest to `crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex')`. W bazie jest to `encode(extensions.hmac(canonical, secret, 'sha256'), 'hex')` na przeciążeniu `text, text, text`.

Sprawdzone 2026-10-05 w tym workspace: zwykłe `new PGlite()` nie ma `pgcrypto`. Po `import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'` oraz `create extension pgcrypto with schema extensions` oba wyliczenia dały ten sam hex dla tekstu ze znakiem `ś`. Dokumentacja PostgreSQL opisuje `hmac(data text, key text, type text)` i algorytm `sha256`. W Supabase woła się je jako `extensions.hmac`, bo `search_path = ''` nie widzi schematu rozszerzenia.

Funkcja akceptuje podpis z `request_secret_current`, a gdy `request_secret_previous` ma co najmniej 32 bajty, także z niego. Porównanie jest równością hex. Nie zastępuje ono sekretu: bez sekretu nie da się wyliczyć MAC, który baza uzna.

Podpis wiąże treść, klucz ponowienia, czas, adres IP i kontekst użytkownika. `auth.uid()` nie jest argumentem RPC. Baza wstawia do tekstu wynik `(select auth.uid())`. Podpis anonima nie przechodzi jako zalogowany użytkownik i odwrotnie. Zmiana dowolnego podpisanego pola unieważnia MAC.

`fingerprint_hash` nie jest argumentem. Do limitu i do zapisu funkcja liczy go jako HMAC-SHA256 aktualnego sekretu i dokładnego `source_ip`, tym samym kodowaniem, ale dopiero ze sekretów odczytanych pod blokadą wiersza ustawień. Wstępne sprawdzenie podpisu nie dostarcza odcisku do tej decyzji. Dopóki `request_secret_previous` odczytany pod tą blokadą nie jest puste, ten sam limit źródła wlicza także hash wyliczony poprzednim sekretem. W bazie ląduje tylko hex nowego zapisu, zawsze z aktualnego sekretu z tego odczytu.

### Adres IP

Docelowy hosting to Vercel, bez reverse proxy przed projektem. Zaufanym źródłem jest jeden nagłówek `x-real-ip`. Dokumentacja Vercel opisuje go jako publiczny adres klienta wyliczony przez platformę; przy brzegu Vercel platforma nadpisuje `x-forwarded-for`, żeby nie przyjmować podstawionego ciągu. Kod i tak nie czyta `x-forwarded-for`: poza Vercel lewa strona listy nie jest zaufana, a po podstawieniu proxy może zostać nadpisana. `x-vercel-forwarded-for` zostaje w dokumentacji Vercel na wypadek proxy, ale ten projekt go nie używa. Postawienie proxy przed Vercel wymaga osobnej decyzji, zanim jakikolwiek inny nagłówek stanie się źródłem.

Action przyjmuje `x-real-ip` tylko wtedy, gdy po trimie jest pojedynczym adresem IPv4 albo IPv6: bez przecinka, portu, spacji i identyfikatora strefy. IPv4 to cztery oktety 0–255. IPv6 to 2–39 znaków, wyłącznie cyfry szesnastkowe i dwukropki, co najwyżej jedno `::`. Inaczej action nie podpisuje i nie woła RPC.

Brak nagłówka, pusty nagłówek albo lista adresów nie są zastępowane przez `127.0.0.1` ani żaden inny wspólny adres. Action zwraca `sales_lead_unavailable` bez podpisu. Dotyczy to produkcji i lokalnego `next dev`. Test HTTP, który ma dojść do podpisu, sam ustawia `x-real-ip`, na przykład adres z sieci dokumentacyjnej `203.0.113.10`.

Zmiana samego User-Agent nie zmienia `source_ip` ani `fingerprint_hash`, więc nie otwiera nowego limitu źródła. Wspólny adres NAT dzieli jeden licznik. To skutek zaufanego adresu, nie możliwość wybrania dowolnego odcisku przez klienta RPC.

### Rotacja sekretu

Ważność podpisu i historia odcisku to dwa różne czasy. Podpis, także tym poprzednim sekretem, żyje tylko w oknie 120 sekund wstecz i 30 sekund do przodu. Po tym czasie stary MAC nie przechodzi, nawet jeśli poprzedni sekret nadal leży w tabeli. Historia odcisku potrzebuje tego sekretu dłużej: limit źródła sięga 60 minut dla przyjętych zgłoszeń i 10 minut dla prób. Po skasowaniu poprzedniego sekretu baza nie odtworzy starego HMAC, bo nie przechowuje adresu IP. Limity e-maila i limit globalny nie używają odcisku, więc rotacja ich nie rusza. Okien 60 minut, 10 minut, 24 godzin i progu globalnego nie skracać.

Jedyna obsługiwana zmiana sekretu to `private.rotate_sales_lead_request_secret(new_secret text)` oraz późniejsze `private.retire_sales_lead_previous_secret()`. Obie są `SECURITY DEFINER`, `search_path = ''`, bez grantu dla `anon` i `authenticated`. Woła je postgres. Nie wkładają sekretu do migracji.

Obie, zanim cokolwiek zmienią, biorą `select ... from private.sales_lead_settings for update` i pod tą blokadą ponownie czytają `leads_enabled`, `request_secret_current`, `request_secret_previous` oraz `request_secret_rotated_at`. Warunki oceniają wyłącznie ten odczyt. Nie biorą blokad 6101, 6102, 6103 ani 6104, więc nie odwracają kolejności używanej przez `submit_sales_lead`. Trzymają wiersz do końca transakcji. Zgłoszenie, które już trzyma ten wiersz, kończy zapis na sekretach ze swojego odczytu. Rotacja albo retire czekają i dopiero potem widzą stan po tym zapisie.

Rotacja:

1. Właściciel przygotowuje nowy ciąg poza repozytorium. Krótszy niż 32 bajty daje `sales_lead_secret_invalid` i nic nie zmienia.
2. Po blokadzie wiersza: gdy `request_secret_current` jest puste, funkcja wpisuje tylko aktualny sekret. Poprzedni zostaje pusty, `request_secret_rotated_at` zostaje puste. To pierwsze ustawienie, nie rotacja.
3. Gdy aktualny sekret już jest, a poprzedni jest pusty, funkcja przepisuje aktualny do poprzedniego, ustawia nowy aktualny i `request_secret_rotated_at = clock_timestamp()`.
4. Gdy poprzedni sekret jeszcze stoi, funkcja zwraca wyjątek `sales_lead_secret_rotation_busy` i nic nie zmienia. Kolejna rotacja czeka, aż retire wyczyści poprzedni sekret. Nie trzymać trzech sekretów.
5. Właściciel ustawia ten sam nowy ciąg w `SALES_LEAD_REQUEST_SECRET` i wdraża aplikację. Do czasu wdrożenia stary proces podpisuje sekretem, który jest już poprzednim. Taki podpis przechodzi tylko wewnątrz zwykłego okna 120 sekund.

Retire zeruje wyłącznie `request_secret_previous`, pod tą samą blokadą wiersza. Wolno je wywołać, gdy od `request_secret_rotated_at` odczytanego pod blokadą minęło pełne 60 minut. Wcześniej funkcja i trigger zgłaszają `sales_lead_secret_history_open`. Po udanym retire nowe podpisy liczy już tylko aktualny sekret, a zgłoszenia sprzed rotacji są starsze niż okno źródła, więc limit nie traci wierszy, które jeszcze powinny się liczyć.

### Dwie flagi

| Flaga | Kto ją czyta | Skutek |
|---|---|---|
| `SALES_LEADS_ENABLED` | tylko server action | Brak albo wartość inna niż `true`: action nie podpisuje i nie woła RPC, zwraca `sales_lead_unavailable`. Baza tej zmiennej nie widzi i nie egzekwuje. |
| `leads_enabled` | `submit_sales_lead` | `false` blokuje nowe `idempotency_key` nawet przy ważnym podpisie i nawet przy bezpośrednim RPC. |

Żądanie podpisane, zanim action zobaczyło wyłączenie zmiennej, może jeszcze dojść do bazy. Baza rozstrzyga je po `leads_enabled` i po ważności podpisu, nie po zmiennej środowiska. Przy `leads_enabled = false` nowy klucz dostaje `sales_lead_unavailable`. Ten sam klucz i ta sama treść dostają `replay`, dopóki podpis jest ważny. Samo wyłączenie zmiennej aplikacji nie unieważnia podpisu, który już wyszedł z action. Żeby zatrzymać także takie nowe klucze, trzeba ustawić `leads_enabled = false`.

Wyłączenie nie kasuje zgłoszeń. Samo ukrycie przycisku nie wystarcza.

### Dlaczego bezpośrednie API nie omija kontroli

1. `revoke all` odbiera `anon` i `authenticated` prawa CRUD na `sales_leads`, `platform_operators` i tabelach `private`.
2. RLS tabel publicznych jest włączone i nie ma polityki `INSERT` ani `SELECT`.
3. Jedyny zapis zgłoszenia to `submit_sales_lead`. Nie przyjmuje `id`, `status`, `created_at`, `submitted_by`, `fingerprint_hash` ani `company_id`.
4. Wywołanie bez ważnego MAC dostaje `sales_lead_unauthorized` i nie zapisuje zgłoszenia ani próby. Podmiana hexu, IP, treści albo kontekstu `auth.uid()` łamie podpis.
5. `leads_enabled = false` blokuje nowy klucz także wtedy, gdy podpis jest ważny.
6. Odczyt listy ma tylko `list_sales_leads`.
7. Trigger ogranicza `UPDATE` i `DELETE` sposobem z sekcji 6.
8. Runtime nie używa `service_role`. Polityki tenantów nie dostają nowej roli.

Nie traktować możliwości podstawienia odcisku jako przyjętego ryzyka. Klient RPC nie wybiera odcisku, bo odcisk powstaje w bazie z adresu objętego podpisem.

### Kolejność `submit_sales_lead`

Funkcja zwraca dokładnie jeden wiersz `table (lead_id uuid, result_code text)` dla każdego kodu biznesowego. Nie używa `RAISE` dla tych kodów, bo wyjątek wycofałby `INSERT` do dziennika prób. Wyjątek zostaje dla niespodziewanej awarii, naruszenia triggera i dla `list_sales_leads`, które nie zapisuje licznika. Awaria techniczna nie jest sukcesem interfejsu.

Kody: `accepted`, `replay`, `sales_lead_invalid`, `sales_lead_unauthorized`, `sales_lead_rate_limited`, `sales_lead_unavailable`, `sales_lead_idempotency_conflict`. `lead_id` jest niepuste wyłącznie przy `accepted` i `replay`.

1. Zły kształt podpisu, pusty czas albo pusty IP: `sales_lead_unauthorized`, bez zapisu. Podpis musi pasować do `^[0-9a-f]{64}$`.
2. Brak aktualnego sekretu albo sekret krótszy niż 32 bajty: `sales_lead_unavailable`, bez zapisu.
3. IP spoza gramatyki z tej sekcji: `sales_lead_unauthorized`, bez zapisu.
4. Czas poza oknem 120 sekund wstecz i 30 sekund do przodu: `sales_lead_unauthorized`, bez zapisu.
5. Znormalizować pola i wstępnie sprawdzić MAC oraz okno czasu na odczycie sekretów bez blokady. Niezgodność: `sales_lead_unauthorized`, bez zapisu i bez blokad. Zła autoryzacja nie wchodzi do limitu i nie tworzy wiersza dziennika. Odcisk wyliczony przy tym wstępnym sprawdzeniu, jeżeli w ogóle powstanie, nie służy do limitu ani do zapisu.
6. Wziąć wyłącznie `pg_advisory_xact_lock(6101, hashtext(idempotency_key::text))` i odczytać zgłoszenie.
7. Zgodne pięć pól: ścieżka `replay` z sekcji 9, także przy wyłączonej fladze i zanim funkcja odrzuci kształt nowych pól. Nie brać blokady ustawień ani 6102. Nie dopisywać próby i nie używać odcisku. To jedyna ścieżka, która po wstępnej autoryzacji nie wraca do sekretów.
8. W każdym pozostałym przypadku, nadal trzymając 6101, wziąć `select leads_enabled, request_secret_current, request_secret_previous, request_secret_rotated_at from private.sales_lead_settings for update`. Tę blokadę trzymać do końca transakcji. Pod nią ponownie złożyć MAC i ponownie sprawdzić okno 120 sekund oraz 30 sekund na sekretach z tego odczytu. Niezgodność: `sales_lead_unauthorized`, bez próby. Flaga wyłączona: `sales_lead_unavailable`, bez zgłoszenia i bez próby. Obejmuje to nowy klucz, nowy klucz z błędem pól oraz istniejący klucz o innej treści. Wiersz zgłoszenia się nie zmienia.
9. Dopiero teraz wyliczyć odciski do limitu i ewentualnego zapisu: aktualny sekret z kroku 8 oraz, gdy poprzedni z tego samego odczytu nie jest pusty, także poprzedni. Odcisku sprzed tej blokady nie używać. Przy włączonej fladze i polach, które nie przechodzą długości, wzorca albo znaków sterujących, wziąć blokadę 6102. Pod nią policzyć próby tych odcisków i ewentualnie dopisać jedną `rejected`. Wynik `sales_lead_invalid` albo, przy wyczerpanym progu 8, `sales_lead_rate_limited` bez nowego wiersza dziennika.
10. Flaga włączona, pola poprawne, a istniejący klucz ma inną treść: blokada 6102, ta sama zasada limitu prób, wynik `sales_lead_idempotency_conflict` albo `sales_lead_rate_limited`. Wiersz zgłoszenia bez zmian.
11. Flaga włączona, pola poprawne i brak wiersza: w kolejności blokady 6102, 6103 (`hashtext` znormalizowanego e-maila) i 6104,1. Pod blokadą odcisku usunąć próby tych odcisków starsze niż 48 godzin, ponownie policzyć limity na odciskach z kroku 9 i dopiero wtedy zapisać. Zapisany `fingerprint_hash` jest hashem aktualnego sekretu z kroku 8.

Kolejność blokad ścieżki z licznikiem jest stała: 6101, potem wiersz ustawień, potem 6102, potem 6103, potem 6104. Ścieżka, która nie potrzebuje dalszej blokady, zatrzymuje się wcześniej. Nie bierze 6102 przed 6101 ani blokady ustawień przed 6101. Rotacja i retire nie wchodzą w tę kolejkę od drugiej strony: biorą tylko wiersz ustawień.

Próba `rejected` albo `rate_limited` jest dopisywana tylko wtedy, gdy liczba prób tego odcisku z ostatnich 10 minut jest mniejsza niż 8. Ósma próba jeszcze się zapisuje. Dziewiąta zwraca `sales_lead_rate_limited` i nie dodaje wiersza. Dzięki temu odmowa biznesowa zostaje w dzienniku po zakończeniu funkcji, a przekroczenie limitu nie wydłuża dziennika bez końca.

Limity przyjęć, liczone po ponownym odczycie pod blokadami, dotyczą nowego klucza:

- 5 zgłoszeń tego odcisku w 60 minut, łącznie z hashem poprzedniego sekretu, dopóki ten sekret nie zostanie legalnie wycofany;
- 3 zgłoszenia tego znormalizowanego e-maila w 24 godziny;
- 30 zgłoszeń łącznie w 60 minut.

Gdy którykolwiek jest wyczerpany, funkcja zwraca `sales_lead_rate_limited` i dopisuje próbę tylko według progu 8. Nie tworzy zgłoszenia. `replay` nie zużywa tych progów.

`accepted` wstawia zgłoszenie i jedną próbę `accepted` w tej samej transakcji. `submitted_by` bierze wyłącznie z `auth.uid()`.

## 8. D. Operator platformy

### Nadanie i odebranie

Pierwszego operatora nie tworzy aplikacja ani migracja. Właściciel kopiuje własny UUID z panelu Auth i jako postgres uruchamia:

```sql
insert into public.platform_operators (user_id)
values ('UUID-Z-PANELU-AUTH');
```

Projekt nie podaje tego UUID.

`public.grant_platform_operator(target_user uuid) returns text`

`public.revoke_platform_operator(target_user uuid) returns text`

Obie są `SECURITY DEFINER`, `search_path = ''`, `execute` tylko dla `authenticated`. Najpierw biorą `pg_advisory_xact_lock(6105, 1)`. Pod tą blokadą ponownie czytają wiersz wywołującego `FOR UPDATE`. Brak aktywnego wiersza daje `sales_lead_forbidden` i nie zmienia danych. Grant wymaga istniejącego `auth.users`; inaczej `sales_lead_invalid`. Ponowne nadanie czyści `revoked_at` i ustawia `granted_by` na `auth.uid()`, bez zmiany pierwotnego `granted_at`.

Revoke pod tą samą blokadą liczy aktywnych operatorów. Jeżeli cel jest aktywny i aktywny jest tylko jeden, zwraca `sales_lead_last_operator` i nic nie zmienia. Dotyczy to także dwóch równoczesnych RPC: druga transakcja widzi stan po pierwszej i nie zostawia zera. Odebranie już nieaktywnego celu zwraca `ok`. Sukces zapisu też zwraca `ok`.

Te kody są zwykłym wynikiem, nie wyjątkiem. Nie zapisują dziennika prób.

`private.is_platform_operator(uuid)` jest `SECURITY DEFINER` z pustym `search_path`. Po `revoke all` dostaje `execute` tylko `authenticated`, tak jak `private.is_company_owner`. Nie jest publicznym RPC i nie dostaje `anon`.

### Sprawdzenie

- W bazie: `private.is_platform_operator((select auth.uid()))` pod blokadą tam, gdzie RPC zmienia uprawnienia.
- `public.platform_operator_status() returns boolean`: `execute` ma `authenticated`. Brak aktywnego wiersza albo puste `auth.uid()` zwraca `false`. `anon` nie ma `execute`.
- `list_sales_leads` przy braku operatora robi `RAISE` z tokenem `sales_lead_forbidden`, nie pustą listę. To odczyt bez licznika, więc wyjątek niczego nie wycofuje poza samym odczytem.

### Widok

Adres `/operator/leads` nie leży pod `/dashboard/[companyId]`.

006D:

- brak sesji przekierowuje do `/login`;
- sesja bez operatora kończy się `notFound()`;
- operator widzi do 50 najnowszych zgłoszeń: czas, imię, nazwę firmy, e-mail, telefon, opis, status i UUID `submitted_by`, jeżeli jest;
- brak edycji, notatek, eksportu i wysyłki;
- `list_sales_leads(result_limit integer)` przycina limit do 1–100, domyślnie 50, sortuje `created_at desc, id desc`.

`proxy.ts` w 006D dopisuje wyłącznie matcher `/operator/:path*`.

### Usunięcie autora zgłoszenia

`private.detach_sales_lead_author(uuid)` jest `SECURITY DEFINER`, `search_path = ''`, bez grantu dla `anon` i `authenticated`. Ustawia lokalnie `skillcheck.sales_lead_author_detach = 'on'` i wykonuje jedyną dozwoloną zmianę: `submitted_by` wskazanego autora na `null`.

Trigger `AFTER DELETE ON auth.users FOR EACH ROW` woła tę funkcję. Usunięcie użytkownika kończy się powodzeniem, zgłoszenie zostaje, treść zostaje, a `submitted_by` staje się `null`. Pozostałe kolumny się nie zmieniają. Test 006B wykonuje ten scenariusz na tabeli `auth.users` utworzonej tak, jak robią to istniejące testy PGlite. Na hostowanym Supabase ten sam trigger tworzy rola migracji. Jeżeli host odmówi triggera na `auth.users`, 006B się zatrzymuje i nie wraca do `ON DELETE SET NULL`.

### Sprzątanie techniczne

`private.rotate_sales_lead_request_secret(text)` i `private.retire_sales_lead_previous_secret()` działają według sekcji 7. Nie mają grantu dla API. Trigger ustawień i tak odrzuca zbyt wczesne wyzerowanie poprzedniego sekretu.

`private.purge_expired_sales_lead_attempts()` kasuje próby starsze niż 48 godzin. To techniczny horyzont liczników, dłuższy niż okno 24 godzin dla e-maila. Nie jest decyzją o przechowywaniu treści zgłoszeń. Funkcja jest `SECURITY DEFINER`, bez grantu dla API. Dodatkowo ścieżka nowego zapisu, już pod blokadą odcisku, kasuje przeterminowane próby tego odcisku.

`private.purge_sales_leads(uuid[])` kasuje wskazane identyfikatory. W tej samej transakcji ustawia `skillcheck.sales_lead_test_purge = 'on'`, usuwa wiersze `sales_lead_replay_state`, potem wskazane `sales_leads`. Nie przyjmuje warunku czasowego i nie jest dostępna przez API. Właściciel woła ją jako postgres, podając UUID zgłoszenia testowego. To zastępuje wyłączanie triggera.

Publiczne włączenie nie wymaga harmonogramu. Właściciel może wołać czyszczenie prób ręcznie. Brak harmonogramu nie wydłuża dziennika ponowień: ponowienia mają osobny, ograniczony wiersz.

## 9. E. Ochrona publicznego formularza

Limity egzekwuje funkcja pod blokadami z sekcji 7, nie przycisk.

Ponowienie zgodnej treści:

- zwraca istniejące `lead_id` także przy `leads_enabled = false`, o ile podpis jest ważny;
- nie zużywa limitu przyjęć ani limitu ośmiu prób;
- nie dopisuje wiersza do `sales_lead_attempts`;
- w `sales_lead_replay_state` tworzy albo zwiększa jeden licznik, najwyżej do 20;
- po osiągnięciu 20 nie wykonuje dalszego zapisu, a wynik nadal jest `replay` z tym samym `lead_id`.

Dziennik prób nie zawiera danych kontaktowych. Zła autoryzacja i wyłączona flaga nowego klucza nie dopisują próby. Błędne pola, konflikt klucza i odrzucenie przez limit przyjęć dopisują próbę tylko poniżej progu 8.

Rozmiar: action odrzuca pole przed podpisem, gdy surowy tekst przekracza limit kolumny. Nie obniżać globalnego `serverActions.bodySizeLimit` w `next.config.mjs`, bo ten sam proces przyjmuje pliki CV.

Niedostępna baza, brak sekretu, brak zaufanego IP albo wyłączona flaga nie pokazują sukcesu. Log serwera zawiera wyłącznie `result_code`: `sales_lead_accepted` mapowane z `accepted`, oraz `sales_lead_rejected`, `sales_lead_rate_limited`, `sales_lead_unavailable`, `sales_lead_replay`, `sales_lead_unauthorized`, `sales_lead_idempotency_conflict`. Bez imienia, e-maila, telefonu, firmy, treści, adresu IP i podpisu.

Captcha i nowa zależność poza `pg` w teście współbieżności nie wchodzą do tych etapów.

## 10. F. Konfiguracja i uruchomienie

| Nazwa | Gdzie | Uwagi |
|---|---|---|
| `SALES_LEADS_ENABLED` | serwer Vercel, nie `NEXT_PUBLIC` | steruje tylko action; brak oznacza wyłączenie |
| `SALES_LEAD_REQUEST_SECRET` | serwer Vercel | co najmniej 32 bajty; ten sam ciąg co `request_secret_current` |
| `SALES_LEAD_NOTICE` | serwer Vercel | treść od właściciela; pusta do czasu decyzji |

Nie używać nazwy `SALES_LEAD_FINGERPRINT_SECRET`. Nie dodawać `service_role`.

### Kolejność

1. Zmergować 006B. Uruchomić tylko `20261007000200_sales_leads.sql` raz. Nie uruchamiać starszych plików.
2. Zmergować 006C i 006D przy `leads_enabled = false` i bez `SALES_LEADS_ENABLED=true`.
3. Na jednorazowym Postgresie, nie na produkcji, wykonać test współbieżności z sekcji 12 i zachować wynik. Bez tego nie ustawiać `leads_enabled = true`.
4. Właściciel wstawia własny UUID operatora SQL-em z sekcji 8.
5. Właściciel zatwierdza `SALES_LEAD_NOTICE` albo świadomie odkłada publikację.
6. Ustawia sekret w Vercel i pierwszy raz woła `private.rotate_sales_lead_request_secret` jako postgres. Nie wpisuje sekretu ręcznym `UPDATE`, żeby nie pominąć triggera historii.
7. Ustawia `SALES_LEADS_ENABLED=true` oraz `leads_enabled = true`.
8. Sprawdza jedno zgłoszenie i odczyt operatorem. Sprzątanie tego wiersza robi `private.purge_sales_leads` jako postgres.

Wyłączenie bez utraty danych: `SALES_LEADS_ENABLED` inne niż `true` oraz `leads_enabled = false`. Wiersze zostają.

## 11. RPC, które 006B ma utworzyć

Publiczne funkcje: `language plpgsql`, `security definer`, `set search_path = ''`. Po definicji `revoke all ... from public`, potem tylko grant poniżej.

### `public.submit_sales_lead(idempotency_key uuid, first_name text, company_name text, email text, phone text, needs text, source_ip text, issued_at_us bigint, request_signature text) returns table(lead_id uuid, result_code text)`

Grant: `anon`, `authenticated`.

### `public.list_sales_leads(result_limit integer) returns setof public.sales_leads`

Grant: `authenticated`. Brak operatora: wyjątek `sales_lead_forbidden`.

### `public.platform_operator_status() returns boolean`

Grant: `authenticated`. Brak uprawnienia albo puste `auth.uid()` zwraca `false`.

### `public.grant_platform_operator(target_user uuid) returns text`

### `public.revoke_platform_operator(target_user uuid) returns text`

Grant obu: `authenticated`. Wynik to `ok`, `sales_lead_forbidden`, `sales_lead_last_operator` albo `sales_lead_invalid`. Obie zwracają `text`, nie `void`.

## 12. Testy przyszłej implementacji

### Lokalnie, PGlite, jedna sesja — 006B

To nie jest dowód współbieżności. Sprawdza kontrakt sekwencyjnie:

- migracja przechodzi na łańcuchu i jest w tablicy `tests/database-types.test.mjs`;
- konstruktor PGlite w tym teście i w `tests/sales-leads-database.test.mjs` ładuje `@electric-sql/pglite/contrib/pgcrypto`;
- brak `pgcrypto` przed migracją: migracja tworzy je w `extensions` i przechodzi, a predykat `hmac(text, text, text)` jest prawdziwy;
- `pgcrypto` utworzone wcześniej w `extensions`: migracja przechodzi i nie tworzy drugiej kopii;
- `pgcrypto` utworzone w innym schemacie: migracja kończy się `sales_lead_pgcrypto_schema`, rozszerzenie zostaje w tamtym schemacie i nie powstaje kopia w `extensions`;
- po udanej migracji test wymaga, żeby predykat `extensions.hmac(text, text, text)` był prawdziwy; gałąź `sales_lead_pgcrypto_hmac` jest w migracji na wypadek braku tego przeciążenia i nie wolno jej pominąć;
- jeden fixture kanoniczny daje ten sam hex w `lib/sales-lead-signature.ts` i w `extensions.hmac`;
- `anon` i `authenticated` nie mają CRUD na obu tabelach publicznych;
- bezpośredni `insert` i `select` kończą się odmową dla anonima, właściciela firmy, rekrutera i viewera;
- ważny podpis i włączona flaga wstawiają jeden wiersz oraz zwracają jego `lead_id` z kodem `accepted`;
- zły hex, zmienione pole, inny `auth.uid()` niż w podpisanym kontekście i przeterminowany `issued_at_us` dają `sales_lead_unauthorized`, zero zgłoszeń i zero prób;
- brak sekretu daje `sales_lead_unavailable` i zero prób;
- po ważnym podpisie, przy włączonej fladze, zły e-mail daje `sales_lead_invalid`, jedną próbę `rejected` i zero zgłoszeń; w próbie nie ma treści kontaktu;
- przy wyłączonej fladze nowy klucz, także z błędnym e-mailem i ważnym podpisem, daje `sales_lead_unavailable`, zero zgłoszeń i zero prób; zgodne ponowienie nadal zwraca `lead_id`;
- przy wyłączonej fladze inna treść tego samego klucza daje `sales_lead_unavailable`, nie zmienia wiersza i nie dopisuje próby;
- dziewiąta próba poniżej progu czasu zwraca `sales_lead_rate_limited` i nie dodaje dziewiątego wiersza;
- ten sam klucz i te same pięć pól zwracają to samo `lead_id`, zostawiają jeden wiersz i nie zmieniają `submitted_by`;
- przy włączonej fladze ten sam klucz i inny opis dają konflikt, a pierwotny `submitted_by` zostaje;
- po 20 ponowieniach nadal wraca to samo `lead_id`, a `replay_count` nie przekracza 20 i nie powstają kolejne wiersze dziennika;
- wywołanie nie tworzy firmy ani członkostwa;
- anonim ma `submitted_by null`; zalogowany ma własne `auth.uid()`;
- `leads_enabled = false` nie kasuje starych wierszy;
- pięć zgłoszeń zapisanych sekretem A dla jednego IP, w tym wiersz z `created_at` sprzed 59 minut wstawiony przez właściciela bazy, po rotacji na sekret B nadal wyczerpuje limit pięciu przyjęć w 60 minut; wiersz sprzed 61 minut już go nie wyczerpuje;
- podpis sekretem A starszy niż 120 sekund daje `sales_lead_unauthorized`, chociaż poprzedni sekret nadal stoi i wiersz sprzed 59 minut nadal liczy się do limitu;
- `retire_sales_lead_previous_secret` oraz ręczne wyzerowanie poprzedniego sekretu przed upływem 60 minut od `request_secret_rotated_at` zgłaszają `sales_lead_secret_history_open` i zostawiają poprzedni sekret;
- druga rotacja, zanim retire wyczyści poprzedni sekret, zgłasza `sales_lead_secret_rotation_busy` i nie podmienia sekretów;
- usunięcie autora z `auth.users` kończy się powodzeniem, zgłoszenie zostaje, `submitted_by` jest `null`, pozostałe kolumny bez zmian;
- bezpośredni `update` i `delete` zgłoszenia są przerwane;
- `purge_sales_leads` nie ma `execute` dla `anon` i `authenticated`, a wywołana jako właściciel bazy usuwa wskazany wiersz bez `disable trigger`;
- anonim nie może wywołać listy;
- właściciel firmy, rekruter i viewer dostają `sales_lead_forbidden`;
- operator widzi zgłoszenie, a po odebraniu już nie;
- revoke ostatniego aktywnego operatora zwraca `sales_lead_last_operator`;
- grant odrzuca UUID spoza `auth.users`;
- kanoniczny tekst nie zawiera User-Agent, a dwa podpisy tego samego IP różnią się tylko wtedy, gdy różni się podpisana treść albo czas;
- kod odmowy nie zawiera treści `needs`;
- `npm run test:db` przechodzi po świadomym rozszerzeniu zamrożonego kontraktu.

### Współbieżność, osobny Postgres, przed publicznym włączeniem

Nie uruchamiać tego na produkcji i nie uznawać sekwencyjnego PGlite za ten test. Skrypt `tests/sales-leads-concurrency.mjs` używa dwóch niezależnych połączeń pakietu `pg`. Bez `SALES_LEADS_TEST_DATABASE_URL` kończy się kodem 0 i jawnym komunikatem, że test został pominięty. CI nie uruchamia skryptu. Pominięcie nie jest PASS współbieżności.

Środowisko: jednorazowa baza PostgreSQL zgodna z Supabase, z `pgcrypto` w schemacie `extensions`, po wykonaniu wyłącznie nowej migracji na tym środowisku. Dwa połączenia wołają RPC równocześnie, `Promise.all`, bez czekania w jednej sesji. To pokrywa wyścigi zapisu. Wyścig ze zmianą sekretu wymaga wymuszonej kolejności opisanej niżej, nie samego `Promise.all`.

Wymagany wynik przed `leads_enabled = true` na środowisku współdzielonym:

- ten sam klucz i ta sama treść: jeden wiersz, oba wyniki mają to samo niepuste `lead_id`, kody to `accepted` i `replay`;
- ten sam klucz i różny opis: jeden wiersz, jeden `accepted`, jeden `sales_lead_idempotency_conflict`, `submitted_by` pochodzi od pierwszego zapisu;
- dziewięć równoczesnych nowych kluczy z jednego IP: nie więcej niż osiem prób i nie więcej niż pięć zgłoszeń;
- cztery równoczesne przyjęcia tego samego e-maila z różnych IP: nie więcej niż trzy zgłoszenia;
- trzydzieści jeden równoczesnych przyjęć różnych e-maili i IP: nie więcej niż trzydzieści zgłoszeń;
- dwóch operatorów odbiera uprawnienie równocześnie jeden drugiemu: po obu transakcjach zostaje co najmniej jeden aktywny operator;
- grant wywołany przez operatora odebranego równoległą transakcją nie dodaje nowego operatora, gdy sprawdzenie pod blokadą widzi już odebranie.

Osobno wymusić kolejność rotacji na niezależnych połączeniach. Funkcja czyta `skillcheck.sales_lead_submit_barrier` tylko w tej sesji. Wartość `before_settings` po kroku 7 i przed blokadą ustawień wykonuje `pg_advisory_lock(6190, 1)`, a zaraz potem `pg_advisory_unlock(6190, 1)`. Wartość `after_settings`, już po blokadzie ustawień, ponownej autoryzacji i wyliczeniu odcisków, a przed 6102, robi to samo z `6191`. Inna albo pusta wartość nic nie robi. Migracja, aplikacja i test PGlite tej wartości nie ustawiają.

Kolejność testu rotacji:

1. Sesja T bierze session-level `pg_advisory_lock(6190, 1)` i go nie puszcza.
2. Sesja A ustawia barierę `before_settings` i woła `submit_sales_lead` z podpisem ważnym dla sekretu sprzed rotacji oraz z nowym kluczem.
3. Test czeka, aż `pg_locks` pokaże, że A czeka na 6190, trzyma już 6101 i jeszcze nie ma blokady wiersza `sales_lead_settings`. Samo uruchomienie obu wywołań bez tego sprawdzenia nie wystarcza.
4. Sesja B commituje rotację, a potem commituje przyjęcia tego samego IP już pod nowym odciskiem, aż do progu pięciu.
5. T puszcza 6190. A dopiero teraz bierze wiersz ustawień, powtarza autoryzację i liczy oba odciski z tego odczytu.
6. Podpis A jest nadal w oknie 120 sekund i 30 sekund w chwili sprawdzenia pod blokadą, więc odmowa nie wynika z czasu. Wynik A to `sales_lead_rate_limited` i brak szóstego zgłoszenia. W `sales_leads` dla tego IP zostaje pięć zgłoszeń zapisanych już pod nowym odciskiem. Ewentualna próba `rate_limited` powstaje tylko według progu 8. A nie zapisuje zgłoszenia na odcisku obliczonym przed rotacją.

Ten sam szkielet dla retire, zamiast kroku 4. Zanim A przejdzie wstępną autoryzację, jednorazowa baza ma już pięć zgłoszeń tego IP pod odciskiem sekretu, który zostaje aktualny, oraz `request_secret_rotated_at` starszy o co najmniej 60 minut. Znacznik pochodzi ze zwykłej rotacji wykonanej wcześniej. Skrypt nie przesuwa go wstecz, nie wyłącza triggera i nie śpi wewnątrz transakcji A. B commituje `retire_sales_lead_previous_secret`, gdy `pg_locks` pokazuje oczekiwanie A na 6190. Po puszczeniu 6190:

- podpis A ważny dla sekretu, który zostaje aktualny: A czyta poprzedni sekret jako pusty, liczy tylko odcisk z tego odczytu, zwraca `sales_lead_rate_limited` i nie dodaje szóstego zgłoszenia;
- podpis A wyłącznie wycofanym sekretem: `sales_lead_unauthorized`, bez próby i bez nowego zgłoszenia.

Drugi kierunek, bariera `after_settings`: T trzyma 6191. A dochodzi do blokady ustawień, powtarza autoryzację, liczy odciski i czeka na 6191, nadal trzymając wiersz. Test widzi w `pg_locks`, że B w `rotate` albo `retire` czeka na ten wiersz i nie ma jeszcze prawa zapisu. T puszcza 6191. A kończy na sekretach ze swojego odczytu i commituje. Dopiero potem B dostaje wiersz i zmienia sekrety. Zmiana nie wchodzi w licznik, który A już domknął, ani w zapisany odcisk. Gdy A było poniżej progów i podpis pasował do sekretu z własnego odczytu, wynik A to `accepted`, a zapisany `fingerprint_hash` jest hashem tego sekretu.

006B oddaje skrypt i w raporcie pisze, że CI go nie wykonało. Wynik powyższej listy zapisuje się przy uruchomieniu przed publikacją, nie jako test 006B w CI.

### Lokalnie, HTTP, bez prawdziwej wysyłki — 006C i 006D

- `GET /rozmowa` zwraca 200 i nie twierdzi, że termin jest zarezerwowany;
- brak `x-real-ip` nie kończy się potwierdzeniem i action nie woła RPC;
- ten sam IP i różny User-Agent nie tworzą dwóch odcisków w builderze podpisu;
- niepoprawny POST i błąd RPC nie zawierają potwierdzenia zapisu;
- stub z `lead_id` oraz `accepted` albo `replay` pokazuje potwierdzenie;
- stub z `lead_id` przy innym kodzie nie pokazuje potwierdzenia;
- anonimowe `GET /operator/leads` przekierowuje do `/login`;
- zalogowany nie-operator dostaje 404;
- `/`, `/demo`, `/login`, `/register`, `/forgot-password` zostają sprawne;
- anonimowe `/dashboard` i `/onboarding` nadal prowadzą do `/login`.

Wzorzec stubu: `tests/auth-mail-http.test.mjs`. Nie wysyłać wiadomości i nie używać `test:live`.

### Dwa konta właściciela

Dopiero po migracji na projekcie testowym, nie produkcyjnym: właściciel firmy nie widzi `/operator/leads`, wskazany operator widzi zgłoszenie. To nie jest warunek scalenia 006B.

## 13. Pliki zarezerwowane

006B rusza tylko pliki wypisane w promptcie Cursora. Są wśród nich helper podpisu, test PGlite, skrypt współbieżności, devDependency `pg` i `package-lock.json` tylko w zakresie zależności `pg`. Kontrola 006B zaczyna się od `npm ci`.

006C, później:

- `app/rozmowa/page.tsx`
- `app/rozmowa/actions.ts`
- `app/rozmowa/lead-form.tsx`
- `app/rozmowa/rozmowa.module.css`
- `lib/sales-lead-signature.ts` tylko przez import; nie zmieniać formatu kanonicznego
- `app/components/marketing/home-page.tsx`
- `app/components/marketing/demo-page.tsx`
- `app/components/marketing/links.ts`
- `app/components/marketing/site-header.tsx`
- `app/components/marketing/mobile-nav.tsx`
- `app/marketing.module.css` tylko jeśli odnośnik nie mieści się w istniejących klasach
- `tests/sales-leads-http.test.mjs`
- `package.json` i `.github/workflows/checks.yml` wyłącznie o nowy skrypt HTTP
- `.env.example` wyłącznie o nazwy zmiennych, bez wartości sekretu
- `docs/sc-sales-006c-handoff.md`

006D, później:

- `app/operator/leads/page.tsx`
- `app/operator/leads/leads.module.css`
- `proxy.ts` wyłącznie dopisanie matchera `/operator/:path*`
- `tests/sales-leads-operator-http.test.mjs`
- `docs/sc-sales-006d-handoff.md`

Żaden etap nie zmienia `app/globals.css`, `app/layout.tsx`, auth, onboardingu, analizy AI ani istniejących migracji.

## 14. Otwarte kwestie

| Kwestia | Skutek |
|---|---|
| Brak UUID pierwszego operatora | Nie blokuje kodu 006B–006D. Blokuje publiczne włączenie. Nie wolno go zgadywać. |
| Brak zatwierdzonej informacji o przetwarzaniu danych | Nie blokuje kodu. Blokuje `leads_enabled = true`. |
| Brak sekretu w Vercel albo w `request_secret_current` | Nie blokuje kodu. Blokuje przyjęcie zgłoszenia. |
| Niewykonany test dwóch połączeń | Nie blokuje scalenia 006B. Blokuje `leads_enabled = true` na środowisku współdzielonym. |
| Brak powiadomienia e-mail | Świadomy brak. Właściciel czyta `/operator/leads`. Nie obiecywać czasu odpowiedzi. |
| Okres przechowywania treści zgłoszenia | Nieustalony. 48 godzin dotyczy wyłącznie technicznego dziennika prób. |
| Captcha | Poza zakresem. Źródłem limitu jest adres wyliczony przez Vercel i objęty podpisem. |
| Etapy sprzedaży i powiązanie z firmą | SC-SALES-013. Nie dodawać `company_id`. |

## 15. Decyzje podjęte w tym projekcie

- Zgłoszenie jest osobnym bytem, bez tenanta i bez fikcyjnej firmy.
- Bezpośrednie RPC musi przedstawić MAC wystawiony przez server action. Baza weryfikuje go `extensions.hmac`.
- Odcisk jest HMAC zaufanego `x-real-ip`. User-Agent nie resetuje limitu. Brak adresu nie wpada do wspólnego `127.0.0.1`.
- `SALES_LEADS_ENABLED` steruje tylko action. `leads_enabled` blokuje nowy klucz i błędne pola przed zapisem próby. Zgodne ponowienie zostaje wyjątkiem.
- Poprzedni sekret żyje 60 minut dla historii odcisku. Okno podpisu zostaje 120 sekund. `pgcrypto` musi być w schemacie `extensions` i udostępniać `hmac(text, text, text)`, zanim migracja tworzy tabele.
- Odmowy biznesowe wracają jako `result_code` i commitują co najwyżej jedną próbę poniżej progu. Zła autoryzacja nie tworzy próby.
- Limity są sprawdzane ponownie pod `pg_advisory_xact_lock` w stałej kolejności. Końcowa autoryzacja, odciski, limity i zapis używają jednego odczytu sekretów z wiersza ustawień trzymanego do końca transakcji. Rotacja i retire biorą ten sam wiersz przed zmianą i nie biorą blokad 6101–6104.
- Ponowienie porównuje pięć pól, nie nadpisuje `submitted_by` i agreguje się do jednego wiersza o suficie 20.
- Usunięcie konta odczepia autora przez wąski UPDATE. API nie może dowolnie zmieniać zgłoszenia. Sprzątanie testu jest funkcją, nie wyłączeniem triggera.
- Implementacja zaczyna się od 006B dopiero po scaleniu tego dokumentu.
